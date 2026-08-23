/**
 * scan-connect — DEDICATED pairing scanner. Scans a `p01pair1:` QR shown by the
 * P01 browser extension (Settings → Link a phone), prompts for the pairing CODE,
 * decrypts the seed and imports the wallet onto this phone.
 *
 * This is intentionally separate from (wallet)/scan.tsx (the address/zk/stealth
 * scanner): it ONLY accepts pairing QRs, so it never routes a pairing blob into
 * the send/transfer handlers and never accidentally treats an address as a pairing.
 *
 * 🚨 EVERY ICON-ONLY CONTROL ON THIS SCREEN WAS UNLABELLED. Close, back, and the
 * torch toggle were bare `TouchableOpacity`s wrapping an `Ionicons` glyph, which
 * is a button a screen reader can find and cannot name — on a screen whose whole
 * job is to move a seed phrase between two devices. All three are labelled now,
 * and the torch announces which state it is in rather than which glyph it shows.
 *
 * ⛔ Twenty-two colour literals came out, including two reds that were not the
 * theme's red (`#ff4444`, `rgba(239,68,68,0.92)`) and a `#666` grey that is not
 * in the palette at all. The camera scrim is the one thing here that is not a
 * brand colour by nature; it is now the ink token at 60% opacity rather than a
 * black nobody can retune.
 *
 * ⚠️ The pairing TTL, the `isPairingQR` gate and the mnemonic validation are
 * untouched. This was a UI pass.
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { p01Alert } from '@/stores/alertStore';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';
import { isPairingQR, decryptPairing, formatCodeForDisplay } from '@/utils/crypto/pairCrypto';
import { validateMnemonic } from '@/services/solana/wallet';
import { useWalletStore } from '@/stores/walletStore';

const { width, height } = Dimensions.get('window');
const SCAN_AREA_SIZE = width * 0.7;

type Mode = 'scan' | 'code';

export default function ScanConnectScreen() {
  const router = useRouter();
  const { importExistingWallet } = useWalletStore();

  const [mode, setMode] = useState<Mode>('scan');
  const [torchOn, setTorchOn] = useState(false);
  const [isScanning, setIsScanning] = useState(true);
  const [error, setError] = useState('');
  const [scannedQr, setScannedQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [importing, setImporting] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    if (!permission?.granted && permission?.canAskAgain) {
      requestPermission();
    }
  }, [permission]);

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    if (!isScanning) return;
    const data = result.data;
    if (!isPairingQR(data)) {
      // Not a pairing QR — keep scanning, nudge the user. Do NOT route anywhere.
      setIsScanning(false);
      setError('Not a P01 pairing QR. Open the extension → Link a phone.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setTimeout(() => { setError(''); setIsScanning(true); }, 2500);
      return;
    }
    setIsScanning(false);
    setScannedQr(data);
    setMode('code');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleConnect = async () => {
    if (!scannedQr) return;
    const trimmed = code.trim();
    if (!trimmed) { setError('Enter the pairing code shown on the extension.'); return; }

    setError('');
    setImporting(true);
    try {
      // Let the "Linking…" spinner paint before the CPU-bound PBKDF2 runs on the
      // JS thread (pure-JS KDF briefly blocks Hermes; this avoids a dead-looking tap).
      await new Promise((r) => setTimeout(r, 16));
      // decryptPairing enforces the TTL and returns a normalized mnemonic.
      const mnemonic = await decryptPairing(scannedQr, trimmed);
      if (!validateMnemonic(mnemonic)) {
        throw new Error('The linked wallet phrase is invalid.');
      }
      await importExistingWallet(mnemonic);
      await SecureStore.setItemAsync('p01_onboarded', 'true');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const pubKey = useWalletStore.getState().publicKey || '';
      p01Alert(
        'Wallet linked',
        pubKey
          ? `Imported ${pubKey.slice(0, 6)}…${pubKey.slice(-6)}. Set up a screen lock to protect it.`
          : 'Set up a screen lock to protect it.',
        [{ text: 'Set up security', onPress: () => router.replace('/(onboarding)/security') }],
        'success',
      );
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg: string = e?.message || 'Could not link the wallet.';
      setError(msg);
      // Expired / malformed → send the user back to rescan a fresh QR.
      if (/expired|malformed|not a p01/i.test(msg)) {
        setMode('scan');
        setScannedQr(null);
        setCode('');
        setIsScanning(true);
      }
    } finally {
      setImporting(false);
    }
  };

  // Permission states ---------------------------------------------------------
  if (!permission) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.muted}>Requesting camera permission…</Text>
      </SafeAreaView>
    );
  }

  if (!permission.granted && mode === 'scan') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan to connect</Text>
          <View style={styles.iconBtn} />
        </View>
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={56} color={Colors.textTertiary} />
          <Text style={styles.permTitle} accessibilityRole="header">Camera permission required</Text>
          <Text style={styles.muted}>Enable camera access to scan the pairing QR.</Text>
          <Button
            onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
            size="lg"
            style={styles.permButton}
          >
            {permission.canAskAgain ? 'Grant permission' : 'Open settings'}
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  // Code entry ---------------------------------------------------------------
  if (mode === 'code') {
    return (
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => { setMode('scan'); setScannedQr(null); setCode(''); setError(''); setIsScanning(true); }}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back to the scanner"
            >
              <Ionicons name="arrow-back" size={22} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Enter pairing code</Text>
            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={22} color={Colors.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.codeBody}>
            <Text style={styles.codeTitle} accessibilityRole="header">
              Type the code from the extension
            </Text>
            <Text style={styles.codeLede}>
              It's the 16-character code shown under the QR. Pairing expires shortly, so enter it now.
            </Text>

            {/* The field owns its own error, announced as an alert. */}
            <Input
              placeholder="ABCD-EFGH-JKLM-NPQR"
              value={code}
              onChangeText={(v) => { setCode(formatCodeForDisplay(v)); setError(''); }}
              error={error || undefined}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              accessibilityLabel="Pairing code"
              style={styles.codeInput}
            />
          </View>

          <View style={styles.footer}>
            <Button onPress={handleConnect} disabled={!code.trim()} loading={importing} fullWidth size="lg">
              {importing ? 'Linking…' : 'Connect wallet'}
            </Button>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Camera scan --------------------------------------------------------------
  return (
    <View style={styles.cameraRoot}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        enableTorch={torchOn}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={isScanning ? handleBarCodeScanned : undefined}
      />
      {/* Frame overlay. The scrim is the ink token at 60%, not an untunable
          black: the camera feed is the only thing on this app that a brand
          colour genuinely cannot sit on top of. */}
      <View style={StyleSheet.absoluteFillObject}>
        <View style={styles.dim} />
        <View style={styles.dimRow}>
          <View style={styles.dim} />
          <View style={styles.scanArea}>
            <View style={[styles.corner, styles.tl]} />
            <View style={[styles.corner, styles.tr]} />
            <View style={[styles.corner, styles.bl]} />
            <View style={[styles.corner, styles.br]} />
          </View>
          <View style={styles.dim} />
        </View>
        <View style={styles.dim} />
      </View>

      <View style={[styles.cameraCaption, { top: height * 0.14 }]} pointerEvents="none">
        <Text style={styles.headerTitle} accessibilityRole="header">Scan to connect</Text>
        <Text style={styles.muted}>Scan the QR from the extension's “Link a phone”</Text>
      </View>

      {error ? (
        <View style={[styles.errBanner, { bottom: height * 0.3 }]}>
          <Text style={styles.errBannerText} accessibilityRole="alert">{error}</Text>
        </View>
      ) : null}

      <SafeAreaView style={styles.cameraChrome} edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.iconBtnOverlay}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={22} color={Colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setTorchOn(!torchOn)}
            style={[styles.iconBtnOverlay, torchOn && styles.iconBtnOverlayOn]}
            accessibilityRole="button"
            accessibilityLabel={torchOn ? 'Turn the torch off' : 'Turn the torch on'}
            accessibilityState={{ selected: torchOn }}
          >
            <Ionicons
              name={torchOn ? 'flash' : 'flash-outline'}
              size={20}
              color={torchOn ? Colors.background : Colors.text}
            />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { flex: 1, backgroundColor: Colors.background },
  center: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing['2xl'],
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  headerTitle: {
    color: Colors.text,
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.lg,
  },
  // 44pt, which the 40pt discs these replace were not.
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnOverlay: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnOverlayOn: {
    backgroundColor: Colors.primary,
  },

  muted: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  permTitle: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize.xl,
    marginTop: Spacing.lg,
    textAlign: 'center',
  },
  permButton: {
    marginTop: Spacing['2xl'],
  },

  codeBody: {
    flex: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing['3xl'],
  },
  codeTitle: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize.xl,
  },
  codeLede: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    lineHeight: 22,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  codeInput: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.lg,
    letterSpacing: 2,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing['3xl'],
  },

  // Camera
  cameraRoot: { flex: 1, backgroundColor: Colors.background },
  cameraChrome: { position: 'absolute', top: 0, left: 0, right: 0 },
  cameraCaption: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  dim: { flex: 1, backgroundColor: Colors.background, opacity: 0.6 },
  dimRow: { flexDirection: 'row' },
  scanArea: { width: SCAN_AREA_SIZE, height: SCAN_AREA_SIZE },
  corner: { position: 'absolute', width: 28, height: 28, borderColor: Colors.primary },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: BorderRadius.sm },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: BorderRadius.sm },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: BorderRadius.sm },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: BorderRadius.sm },

  errBanner: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '86%',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.error,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  errBannerText: {
    color: Colors.text,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
});
