/**
 * connect-extension — SENDER side of phone→extension pairing. Scans the
 * `p01conn1:` QR shown by the P01 browser extension (Welcome → Connect with
 * phone), prompts for the pairing CODE shown there, encrypts THIS phone's seed
 * to that code (pairCrypto, identical to the extension→phone path) and uploads
 * the ciphertext to the relay channel named in the QR. The extension polls the
 * channel and decrypts with the same code.
 *
 * The relay only ever sees ciphertext — the seed and the code never travel
 * together. Deliberately separate from (auth)/scan-connect (the IMPORT side) and
 * from (wallet)/scan (addresses): this screen only accepts `p01conn1:` tokens.
 *
 * 🎯 RETONED 2026-08-23. Every colour in here was a literal — `#39c5bb`,
 * `#eae7df`, `#0d0d10`, `#ff4444`, `#666` — so the theme realignment could not
 * reach the screen at all.
 *
 * 🚨 AND EVERY ICON-ONLY CONTROL WAS UNNAMED. Close, back and the torch were
 * three 40pt discs with a glyph and nothing else, on a camera screen where
 * there is no other text to infer from. A screen reader announced the only way
 * out of a full-screen camera as "button". They are 44pt and labelled.
 *
 * ⚠️ The pairing-code error already sat under its own field; it now announces
 * itself as an alert, which is the half that was missing — a code that is
 * silently rejected reads as a dead button.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { p01Alert } from '@/stores/alertStore';
import { Button } from '@/components/ui/Button';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { encryptPairing, formatCodeForDisplay } from '@/utils/crypto/pairCrypto';
import { isConnectQR, parseConnectToken } from '@/utils/crypto/connectPair';
import { useWalletStore } from '@/stores/walletStore';

const { width, height } = Dimensions.get('window');
const SCAN_AREA_SIZE = width * 0.7;

type Mode = 'scan' | 'code';

export default function ConnectExtensionScreen() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('scan');
  const [torchOn, setTorchOn] = useState(false);
  const [isScanning, setIsScanning] = useState(true);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<{ apiBase: string; channelId: string } | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    if (!permission?.granted && permission?.canAskAgain) requestPermission();
  }, [permission]);

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    if (!isScanning) return;
    const data = result.data;
    const parsed = isConnectQR(data) ? parseConnectToken(data) : null;
    if (!parsed) {
      setIsScanning(false);
      setError('Not a P01 connect QR. In the extension: Connect with phone.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setTimeout(() => { setError(''); setIsScanning(true); }, 2500);
      return;
    }
    setIsScanning(false);
    setTarget(parsed);
    setMode('code');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleSend = async () => {
    if (!target) return;
    const trimmed = code.trim();
    if (!trimmed) { setError('Enter the pairing code shown on the extension.'); return; }

    setError('');
    setSending(true);
    try {
      const mnemonic = await useWalletStore.getState().getBackupMnemonic();
      if (!mnemonic) {
        throw new Error('No recovery phrase on this device — this wallet can’t be linked.');
      }
      // Let the spinner paint before the CPU-bound PBKDF2 runs on the JS thread.
      await new Promise((r) => setTimeout(r, 16));
      const blob = await encryptPairing(mnemonic, trimmed); // p01pair1: ciphertext

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(`${target.apiBase}/api/pair/${target.channelId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blob }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));

      if (!res.ok) {
        throw new Error(`Relay rejected the request (${res.status}). Try again.`);
      }

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert(
        'Sent to extension',
        'Your wallet was sent securely. Finish on the extension — it should connect within a few seconds.',
        [{ text: 'Done', onPress: () => router.back() }],
        'success',
      );
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(e?.name === 'AbortError' ? 'Relay timed out. Check your connection and try again.' : (e?.message || 'Could not send to the extension.'));
    } finally {
      setSending(false);
    }
  };

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
      <SafeAreaView style={styles.permWrap}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Connect to extension</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={40} color={Colors.textTertiary} />
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.muted}>The pairing QR is on the extension’s screen — this app has to read it.</Text>
          <View style={styles.permAction}>
            <Button
              fullWidth
              size="lg"
              onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
            >
              {permission.canAskAgain ? 'Allow camera' : 'Open settings'}
            </Button>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (mode === 'code') {
    return (
      <SafeAreaView style={styles.permWrap}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => { setMode('scan'); setTarget(null); setCode(''); setError(''); setIsScanning(true); }}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back to the scanner"
            >
              <Ionicons name="arrow-back" size={22} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Pairing code</Text>
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
            <Text style={styles.codeTitle}>Type the code from the extension</Text>
            <Text style={styles.codeBlurb}>
              It’s the 16-character code under the QR. Your recovery phrase is encrypted to it
              before it leaves this phone — the relay only ever sees ciphertext.
            </Text>

            <View style={[styles.inputWrap, error ? styles.inputErr : null]}>
              <TextInput
                style={styles.input}
                placeholder="ABCD-EFGH-JKLM-NPQR"
                placeholderTextColor={Colors.textTertiary}
                value={code}
                onChangeText={(tx) => { setCode(formatCodeForDisplay(tx)); setError(''); }}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                accessibilityLabel="Pairing code"
                accessibilityHint="Sixteen characters, shown under the QR on the extension"
              />
            </View>
            {error ? (
              <Text style={styles.errText} accessibilityRole="alert">{error}</Text>
            ) : null}
          </View>

          <View style={styles.codeFooter}>
            <Button onPress={handleSend} disabled={!code.trim()} loading={sending} fullWidth size="lg">
              Send to extension
            </Button>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.cameraScreen}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        enableTorch={torchOn}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={isScanning ? handleBarCodeScanned : undefined}
      />
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        <View style={styles.dim} />
        <View style={styles.scanRow}>
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

      <View style={styles.cameraCopy} pointerEvents="none">
        <Text style={styles.headerTitle}>Connect to extension</Text>
        <Text style={styles.muted}>Scan the QR under the extension’s “Connect with phone”</Text>
      </View>

      {error ? (
        <View style={styles.errBanner} accessibilityRole="alert">
          <Text style={styles.errBannerText}>{error}</Text>
        </View>
      ) : null}

      <SafeAreaView style={styles.cameraChrome} edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.iconBtnDark}
            accessibilityRole="button"
            accessibilityLabel="Close the scanner"
          >
            <Ionicons name="close" size={22} color={Colors.text} />
          </TouchableOpacity>
          <View style={styles.headerSpacer} />
          <TouchableOpacity
            onPress={() => setTorchOn(!torchOn)}
            style={[styles.iconBtnDark, torchOn ? styles.iconBtnOn : null]}
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
  flex: { flex: 1 },
  center: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing['2xl'],
  },
  permWrap: { flex: 1, backgroundColor: Colors.background },
  cameraScreen: { flex: 1, backgroundColor: Colors.background },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  headerSpacer: { width: 44 },
  headerTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnDark: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    // Colors.background at 60%. A scrim is the ground with alpha; the theme
    // exports no alpha ramp for it, so it is written out rather than guessed.
    backgroundColor: 'rgba(7, 7, 9, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnOn: { backgroundColor: Colors.primary },

  muted: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  permTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
    marginTop: Spacing.lg,
    textAlign: 'center',
  },
  permAction: { alignSelf: 'stretch', marginTop: Spacing['2xl'] },

  /* Code step */
  codeBody: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing['2xl'] },
  codeTitle: {
    color: Colors.text,
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
    letterSpacing: -0.3,
  },
  codeBlurb: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  inputWrap: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
  },
  inputErr: { borderColor: Colors.error },
  input: {
    color: Colors.text,
    fontSize: FontSize.lg,
    fontFamily: FontFamily.mono,
    letterSpacing: 2,
    paddingVertical: Spacing.lg,
    textAlign: 'center',
  },
  errText: {
    color: Colors.error,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.md,
    textAlign: 'center',
  },
  codeFooter: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing['2xl'] },

  /* Camera */
  cameraChrome: { position: 'absolute', top: 0, left: 0, right: 0 },
  cameraCopy: {
    position: 'absolute',
    top: height * 0.14,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
  },
  scanRow: { flexDirection: 'row' },
  dim: { flex: 1, backgroundColor: 'rgba(7, 7, 9, 0.62)' },
  scanArea: { width: SCAN_AREA_SIZE, height: SCAN_AREA_SIZE },
  corner: { position: 'absolute', width: 28, height: 28, borderColor: Colors.primary },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
  errBanner: {
    position: 'absolute',
    bottom: height * 0.3,
    alignSelf: 'center',
    marginHorizontal: Spacing.xl,
    backgroundColor: Colors.errorDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.error,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  errBannerText: {
    color: Colors.error,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    textAlign: 'center',
  },
});
