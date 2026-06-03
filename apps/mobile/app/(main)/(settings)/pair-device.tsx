/**
 * Device pairing screen (MOBILE, Stage S3 / UI-2).
 *
 * Moves the BIP39 mnemonic between this phone and another P01 device (phone or
 * extension) over a 2-QR, no-network handshake. Two modes selected by the `mode`
 * route param:
 *
 *   mode=receive  this empty device IMPORTS a wallet:
 *                 show QR#1 → scan the sender's QR#2 → confirm SAS → import.
 *   mode=send     this device (with a seed wallet) SENDS its mnemonic:
 *                 scan the receiver's QR#1 → show QR#2 + SAS → other device imports.
 *
 * SECURITY (docs/pairing-ledger-spec.md §1A, §3 S3):
 *  - DEDICATED pairing scanner: the camera only accepts `p01pair1:` / `p01pairenc1:`
 *    frames (strict prefix gate) — it is NOT the note/address scanner.
 *  - FORCED cross-entry SAS: the user must TYPE the 6 digits shown on the OTHER
 *    device, not tap "looks right" (Finding #1). A mismatch aborts + zeroizes.
 *  - FLAG_SECURE: screenshots/recording are blocked for the whole ceremony
 *    (Finding #3) — QR#1, QR#2 and the SAS can all leak the handshake.
 *  - The mnemonic is NEVER shown, copied or logged; it only ever travels encrypted
 *    inside QR#2. Clipboard is intentionally NOT offered for QR payloads.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as ScreenCapture from 'expo-screen-capture';
import * as Haptics from 'expo-haptics';
import QRCode from 'react-native-qrcode-svg';

import { p01Alert } from '@/stores/alertStore';
import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import {
  startAsReceiver,
  senderConsumeQr1,
  senderBuildQr2,
  sasEqual,
  isPairingQr1,
  isPairingQr2,
  type ReceiverSession,
} from '@/services/pairing/pairing';

const { width } = Dimensions.get('window');
const SCAN_AREA = Math.min(width * 0.72, 300);
const QR_SIZE = Math.min(width - 96, 300);

type Mode = 'receive' | 'send';

// Receiver: show-qr1 → scan-qr2 → sas → done.  Sender: scan-qr1 → show-qr2(+sas) → done.
type Step = 'show-qr1' | 'scan-qr2' | 'sas' | 'scan-qr1' | 'show-qr2' | 'done';

export default function PairDeviceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: Mode = params.mode === 'send' ? 'send' : 'receive';

  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Receiver session lives only in a ref — its ephemeral keys never persist.
  const receiverRef = useRef<ReceiverSession | null>(null);
  const [qr1, setQr1] = useState<string | null>(null); // shown by receiver

  // Sender state.
  const [qr2, setQr2] = useState<string | null>(null); // shown by sender
  const senderSasRef = useRef<string>(''); // the digits the sender displays

  // SAS confirmation (receiver side): the digits computed locally for the scanned
  // QR#2, plus the user's typed entry that must match.
  const [receiverSas, setReceiverSas] = useState<string>('');
  const [pendingQr2, setPendingQr2] = useState<string | null>(null);
  const [typedSas, setTypedSas] = useState('');

  const [step, setStep] = useState<Step>(mode === 'receive' ? 'show-qr1' : 'scan-qr1');
  const [isScanning, setIsScanning] = useState(true);

  // ── FLAG_SECURE for the whole ceremony (Finding #3) ────────────────────────────
  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync();
    return () => {
      ScreenCapture.allowScreenCaptureAsync();
    };
  }, []);

  // ── camera permission ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!permission?.granted && permission?.canAskAgain) {
      requestPermission();
    }
  }, [permission]);

  // ── receiver: mint a fresh ceremony (QR#1 + ephemeral keys) ──────────────────────
  useEffect(() => {
    if (mode !== 'receive') return;
    const session = startAsReceiver();
    receiverRef.current = session;
    setQr1(session.qr1);
    return () => {
      // Abort + zeroize ephemeral keys if the user leaves before finishing.
      session.cancel();
    };
  }, [mode]);

  // ── sender guard: refuse if this device has no seed wallet ──────────────────────
  // (A hardware-only wallet has no mnemonic to send — getMnemonic returns null and
  // senderBuildQr2 throws. We surface a friendly check up-front for clarity.)
  const hasWallet = useWalletStore((s) => s.hasWallet);
  useEffect(() => {
    if (mode === 'send' && !hasWallet) {
      p01Alert(
        'No wallet to send',
        'This device has no seed-backed wallet to pair from.',
        [{ text: 'OK', onPress: () => router.back() }],
        'warning',
      );
    }
  }, [mode, hasWallet]);

  const failAndReset = useCallback((msg: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setError(msg);
    setTimeout(() => {
      setError(null);
      setIsScanning(true);
    }, 3000);
  }, []);

  // ════════════════════════════════════════════════════════════════════════════════
  //  SENDER  —  scan QR#1, build QR#2
  // ════════════════════════════════════════════════════════════════════════════════
  const handleSenderScanQr1 = useCallback(
    async (raw: string) => {
      // DEDICATED gate: only a pairing QR#1 is accepted here.
      if (!isPairingQr1(raw)) {
        failAndReset('Not a pairing code. Scan the QR shown on the receiving device.');
        return;
      }
      setBusy(true);
      try {
        const parsed = senderConsumeQr1(raw);
        const { qr2: blob, sas } = await senderBuildQr2(parsed);
        senderSasRef.current = sas;
        setQr2(blob);
        setStep('show-qr2');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        failAndReset(e?.message || 'Failed to read the pairing code.');
      } finally {
        setBusy(false);
      }
    },
    [failAndReset],
  );

  // ════════════════════════════════════════════════════════════════════════════════
  //  RECEIVER  —  scan QR#2, compute SAS, force typed match, import
  // ════════════════════════════════════════════════════════════════════════════════
  const handleReceiverScanQr2 = useCallback(
    (raw: string) => {
      const session = receiverRef.current;
      if (!session) return;
      // DEDICATED gate: only a pairing QR#2 is accepted here.
      if (!isPairingQr2(raw)) {
        failAndReset('Not a pairing reply. Scan the QR shown on the sending device.');
        return;
      }
      try {
        // Compute the SAS WITHOUT decrypting; the typed match below gates the import.
        const sas = session.computeSasForQr2(raw);
        setReceiverSas(sas);
        setPendingQr2(raw);
        setTypedSas('');
        setStep('sas');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } catch (e: any) {
        failAndReset(e?.message || 'Could not read the pairing reply.');
      }
    },
    [failAndReset],
  );

  const handleConfirmSasAndImport = useCallback(async () => {
    const session = receiverRef.current;
    if (!session || !pendingQr2) return;

    // FORCED cross-entry: the typed digits MUST equal the locally computed SAS
    // (which both devices derive from the full transcript). No tap-to-trust.
    if (typedSas.length !== 6 || !sasEqual(typedSas, receiverSas)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setError('Codes do not match. If they keep differing, someone may be intercepting — stop and start over.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { mnemonic } = session.consumeQr2(pendingQr2);
      // Import via the standard wallet path. NEVER log the mnemonic.
      await useWalletStore.getState().importExistingWallet(mnemonic);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep('done');
    } catch (e: any) {
      setBusy(false);
      p01Alert(
        'Pairing failed',
        e?.message || 'Could not import the paired wallet. Start a new pairing.',
        [{ text: 'OK', onPress: () => router.back() }],
        'error',
      );
    }
  }, [pendingQr2, typedSas, receiverSas]);

  // ── barcode dispatcher (dedicated to pairing) ────────────────────────────────────
  const onBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (!isScanning) return;
      setIsScanning(false);
      const data = result.data?.trim() ?? '';
      if (mode === 'send' && step === 'scan-qr1') {
        handleSenderScanQr1(data);
      } else if (mode === 'receive' && step === 'scan-qr2') {
        handleReceiverScanQr2(data);
      }
    },
    [isScanning, mode, step, handleSenderScanQr1, handleReceiverScanQr2],
  );

  // ── header ───────────────────────────────────────────────────────────────────────
  const Header = ({ title }: { title: string }) => (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Go back">
        <Ionicons name="arrow-back" size={20} color="#fff" />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={{ width: 40 }} />
    </View>
  );

  // ── camera permission gate ─────────────────────────────────────────────────────
  const renderCamera = (instruction: string) => {
    if (!permission) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={P01Colors.cyan} />
          <Text style={styles.muted}>Requesting camera permission…</Text>
        </View>
      );
    }
    if (!permission.granted) {
      return (
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={56} color="#666" />
          <Text style={styles.cardTitle}>Camera permission required</Text>
          <Text style={styles.muted}>Enable camera access to scan the pairing code.</Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
          >
            <Text style={styles.primaryBtnText}>
              {permission.canAskAgain ? 'Grant Permission' : 'Open Settings'}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={isScanning ? onBarcodeScanned : undefined}
        />
        <View style={styles.scanFrameWrap}>
          <View style={styles.scanFrame}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
        </View>
        <View style={styles.cameraInstruction}>
          <Text style={styles.cameraInstructionText}>{instruction}</Text>
        </View>
        {error && (
          <View style={styles.errorPill}>
            <Text style={styles.errorPillText}>{error}</Text>
          </View>
        )}
        {!isScanning && !busy && (
          <TouchableOpacity style={styles.scanAgainBtn} onPress={() => { setError(null); setIsScanning(true); }}>
            <Text style={styles.scanAgainText}>Scan again</Text>
          </TouchableOpacity>
        )}
        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator size="large" color={P01Colors.cyan} />
          </View>
        )}
      </View>
    );
  };

  // ── a QR display card (no copy/share — payloads must not hit the clipboard) ──────
  const renderQrCard = (value: string, caption: string) => (
    <View style={styles.qrCard}>
      <View style={styles.qrFrame}>
        <QRCode value={value} size={QR_SIZE} backgroundColor="white" color="#0a0a0c" />
      </View>
      <Text style={styles.qrCaption}>{caption}</Text>
    </View>
  );

  const renderSecurityNote = (text: string) => (
    <View style={styles.note}>
      <Ionicons name="shield-checkmark" size={18} color={P01Colors.cyan} />
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );

  // ════════════════════════════════════════════════════════════════════════════════
  //  RECEIVER UI
  // ════════════════════════════════════════════════════════════════════════════════
  if (mode === 'receive') {
    if (step === 'show-qr1') {
      return (
        <SafeAreaView style={styles.container} edges={['top']}>
          <Header title="Pair this device" />
          <ScrollView contentContainerStyle={styles.scroll}>
            <Text style={styles.lead}>Step 1 of 2</Text>
            <Text style={styles.title}>Show this code to your other device</Text>
            <Text style={styles.subtitle}>
              On the device that already has your wallet, choose "Link another device" and scan
              this code.
            </Text>
            {qr1 && renderQrCard(qr1, 'Pairing request')}
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => { setError(null); setIsScanning(true); setStep('scan-qr2'); }}
            >
              <Text style={styles.primaryBtnText}>I scanned it — continue</Text>
            </TouchableOpacity>
            {renderSecurityNote(
              'Your recovery phrase never appears here. It is encrypted end-to-end and only travels inside the reply code your other device shows you.',
            )}
          </ScrollView>
        </SafeAreaView>
      );
    }

    if (step === 'scan-qr2') {
      return (
        <SafeAreaView style={styles.container} edges={['top']}>
          <Header title="Pair this device" />
          {renderCamera('Scan the reply code shown on your other device')}
        </SafeAreaView>
      );
    }

    if (step === 'sas') {
      return (
        <SafeAreaView style={styles.container} edges={['top']}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Header title="Verify connection" />
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
              <View style={styles.shieldIcon}>
                <Ionicons name="shield-checkmark" size={32} color={P01Colors.cyan} />
              </View>
              <Text style={styles.title}>Confirm the security code</Text>
              <Text style={styles.subtitle}>
                Type the 6-digit code shown on your other device. They must match exactly — if
                they don't, someone may be intercepting the connection.
              </Text>

              <View style={styles.sasInputWrap}>
                <TextInput
                  style={styles.sasInput}
                  value={typedSas}
                  onChangeText={(t) => { setTypedSas(t.replace(/[^0-9]/g, '').slice(0, 6)); setError(null); }}
                  placeholder="000000"
                  placeholderTextColor="#444"
                  keyboardType="number-pad"
                  maxLength={6}
                  autoFocus
                  accessibilityLabel="Enter the 6-digit security code from the other device"
                />
              </View>
              {error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[styles.primaryBtn, (typedSas.length !== 6 || busy) && styles.primaryBtnDisabled]}
                disabled={typedSas.length !== 6 || busy}
                onPress={handleConfirmSasAndImport}
              >
                {busy ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.primaryBtnText}>Codes match — import wallet</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.ghostBtn} onPress={() => router.back()}>
                <Text style={styles.ghostBtnText}>They don't match — cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      );
    }

    // done
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Paired" />
        <View style={styles.center}>
          <View style={styles.shieldIcon}>
            <Ionicons name="checkmark-circle" size={40} color={P01Colors.cyan} />
          </View>
          <Text style={styles.title}>Wallet paired</Text>
          <Text style={styles.subtitle}>Your wallet is now available on this device.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => router.replace('/(main)/(wallet)')}>
            <Text style={styles.primaryBtnText}>Open wallet</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════════
  //  SENDER UI
  // ════════════════════════════════════════════════════════════════════════════════
  if (step === 'scan-qr1') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Link another device" />
        {renderCamera('Scan the pairing code on the new device')}
      </SafeAreaView>
    );
  }

  if (step === 'show-qr2') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Link another device" />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.lead}>Step 2 of 2</Text>
          <Text style={styles.title}>Show this reply to the new device</Text>
          <Text style={styles.subtitle}>
            On the new device, scan this code. Then confirm the security code below matches on
            both screens.
          </Text>
          {qr2 && renderQrCard(qr2, 'Encrypted reply')}

          <View style={styles.sasCard}>
            <Text style={styles.sasCardLabel}>SECURITY CODE</Text>
            <Text style={styles.sasCardCode}>{senderSasRef.current}</Text>
            <Text style={styles.sasCardHint}>
              The new device must type these exact digits. If they don't match, stop — someone may
              be intercepting.
            </Text>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => setStep('done')}>
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
          {renderSecurityNote(
            'Your recovery phrase is encrypted end-to-end inside this reply code. It is never shown or copied to the clipboard.',
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // sender done
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header title="Linked" />
      <View style={styles.center}>
        <View style={styles.shieldIcon}>
          <Ionicons name="checkmark-circle" size={40} color={P01Colors.cyan} />
        </View>
        <Text style={styles.title}>Reply sent</Text>
        <Text style={styles.subtitle}>
          The other device can now finish importing. Your wallet stays on this device too.
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing['3xl'], alignItems: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: '#0f0f12',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 18, fontFamily: FontFamily.semibold },

  lead: {
    color: P01Colors.cyan,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 2,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  title: {
    color: Colors.text,
    fontSize: 22,
    fontFamily: FontFamily.bold,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.xl,
  },
  cardTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
    marginTop: Spacing.md,
    textAlign: 'center',
  },
  muted: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center', marginTop: Spacing.sm },

  /* QR card */
  qrCard: { alignItems: 'center', marginBottom: Spacing.xl },
  qrFrame: {
    backgroundColor: 'white',
    padding: Spacing.lg,
    borderRadius: BorderRadius.xl,
    shadowColor: P01Colors.cyan,
    shadowOpacity: 0.2,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  qrCaption: { color: Colors.textSecondary, fontSize: 13, marginTop: Spacing.md },

  /* security note */
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: P01Colors.cyanDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginTop: Spacing.lg,
  },
  noteText: { flex: 1, color: Colors.textSecondary, fontSize: 13, lineHeight: 19 },

  /* primary / ghost buttons */
  primaryBtn: {
    backgroundColor: P01Colors.cyan,
    borderRadius: BorderRadius.lg,
    paddingVertical: 16,
    paddingHorizontal: Spacing.xl,
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: Spacing.md,
  },
  primaryBtnDisabled: { backgroundColor: '#2a2a30' },
  primaryBtnText: { color: '#000', fontSize: 16, fontFamily: FontFamily.bold },
  ghostBtn: { paddingVertical: 14, alignItems: 'center', marginTop: Spacing.sm, alignSelf: 'stretch' },
  ghostBtnText: { color: Colors.error, fontSize: 15, fontFamily: FontFamily.semibold },

  /* shield icon */
  shieldIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
    alignSelf: 'center',
  },

  /* SAS input (receiver) */
  sasInputWrap: { alignSelf: 'stretch', marginBottom: Spacing.md },
  sasInput: {
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: P01Colors.cyan + '40',
    color: P01Colors.cyan,
    fontSize: 32,
    fontFamily: FontFamily.mono,
    letterSpacing: 8,
    textAlign: 'center',
    paddingVertical: Spacing.lg,
  },
  errorText: { color: Colors.error, fontSize: 13, textAlign: 'center', marginBottom: Spacing.md, alignSelf: 'stretch' },

  /* SAS card (sender) */
  sasCard: {
    alignSelf: 'stretch',
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: P01Colors.cyan + '40',
    padding: Spacing.lg,
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  sasCardLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 2,
    marginBottom: Spacing.sm,
  },
  sasCardCode: {
    color: P01Colors.cyan,
    fontSize: 36,
    fontFamily: FontFamily.mono,
    letterSpacing: 6,
    marginBottom: Spacing.sm,
  },
  sasCardHint: { color: Colors.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 17 },

  /* camera */
  cameraWrap: { flex: 1, backgroundColor: '#000' },
  scanFrameWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: SCAN_AREA, height: SCAN_AREA },
  corner: { position: 'absolute', width: 30, height: 30, borderColor: P01Colors.cyan },
  cornerTL: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 8 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 8 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 8 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 8 },
  cameraInstruction: { position: 'absolute', top: 80, left: 0, right: 0, alignItems: 'center', paddingHorizontal: Spacing.xl },
  cameraInstructionText: { color: '#fff', fontSize: 16, fontFamily: FontFamily.semibold, textAlign: 'center' },
  errorPill: {
    position: 'absolute',
    bottom: 160,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,51,102,0.9)',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    marginHorizontal: Spacing.xl,
  },
  errorPillText: { color: '#fff', fontSize: 13, textAlign: 'center' },
  scanAgainBtn: {
    position: 'absolute',
    bottom: 60,
    alignSelf: 'center',
    backgroundColor: P01Colors.cyanDim,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  scanAgainText: { color: P01Colors.cyan, fontSize: 15, fontFamily: FontFamily.semibold },
  busyOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
});
