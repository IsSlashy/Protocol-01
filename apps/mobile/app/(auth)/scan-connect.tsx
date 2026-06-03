/**
 * scan-connect — DEDICATED pairing scanner. Scans a `p01pair1:` QR shown by the
 * P01 browser extension (Settings → Link a phone), prompts for the pairing CODE,
 * decrypts the seed and imports the wallet onto this phone.
 *
 * This is intentionally separate from (wallet)/scan.tsx (the address/zk/stealth
 * scanner): it ONLY accepts pairing QRs, so it never routes a pairing blob into
 * the send/transfer handlers and never accidentally treats an address as a pairing.
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  TextInput,
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
        <ActivityIndicator size="large" color="#39c5bb" />
        <Text style={styles.muted}>Requesting camera permission…</Text>
      </SafeAreaView>
    );
  }

  if (!permission.granted && mode === 'scan') {
    return (
      <SafeAreaView style={styles.permWrap}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan to connect</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={64} color="#666" />
          <Text style={styles.permTitle}>Camera permission required</Text>
          <Text style={styles.muted}>Enable camera access to scan the pairing QR.</Text>
          <Button onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()} className="mt-6">
            {permission.canAskAgain ? 'Grant permission' : 'Open settings'}
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  // Code entry ---------------------------------------------------------------
  if (mode === 'code') {
    return (
      <SafeAreaView style={styles.permWrap}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => { setMode('scan'); setScannedQr(null); setCode(''); setError(''); setIsScanning(true); }}
              style={styles.iconBtn}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Enter pairing code</Text>
            <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>

          <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 24 }}>
            <View style={styles.iconCircle}>
              <Ionicons name="key-outline" size={36} color="#39c5bb" />
            </View>
            <Text style={styles.codeTitle}>Type the code from the extension</Text>
            <Text style={styles.muted2}>
              It's the 16-character code shown under the QR. Pairing expires shortly, so enter it now.
            </Text>

            <View style={[styles.inputWrap, error ? styles.inputErr : null]}>
              <TextInput
                style={styles.input}
                placeholder="ABCD-EFGH-JKLM-NPQR"
                placeholderTextColor="#555560"
                value={code}
                onChangeText={(t) => { setCode(formatCodeForDisplay(t)); setError(''); }}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
              />
            </View>
            {error ? <Text style={styles.errText}>{error}</Text> : null}
          </View>

          <View style={{ paddingHorizontal: 20, paddingBottom: 28 }}>
            <Button onPress={handleConnect} disabled={!code.trim() || importing} fullWidth size="lg">
              {importing ? 'Linking…' : 'Connect wallet'}
            </Button>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Camera scan --------------------------------------------------------------
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        enableTorch={torchOn}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={isScanning ? handleBarCodeScanned : undefined}
      />
      {/* Frame overlay */}
      <View style={StyleSheet.absoluteFillObject}>
        <View style={styles.dim} />
        <View style={{ flexDirection: 'row' }}>
          <View style={styles.dimSide} />
          <View style={styles.scanArea}>
            <View style={[styles.corner, styles.tl]} />
            <View style={[styles.corner, styles.tr]} />
            <View style={[styles.corner, styles.bl]} />
            <View style={[styles.corner, styles.br]} />
          </View>
          <View style={styles.dimSide} />
        </View>
        <View style={styles.dim} />
      </View>

      <View style={{ position: 'absolute', top: height * 0.14, left: 0, right: 0, alignItems: 'center' }}>
        <Text style={styles.headerTitle}>Scan to connect</Text>
        <Text style={styles.muted}>Scan the QR from the extension's “Link a phone”</Text>
      </View>

      {error ? (
        <View style={styles.errBanner}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>{error}</Text>
        </View>
      ) : null}

      <SafeAreaView style={{ position: 'absolute', top: 0, left: 0, right: 0 }} edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtnDark}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={{ width: 40 }} />
          <TouchableOpacity
            onPress={() => setTorchOn(!torchOn)}
            style={[styles.iconBtnDark, torchOn ? { backgroundColor: '#39c5bb' } : null]}
          >
            <Ionicons name={torchOn ? 'flash' : 'flash-outline'} size={22} color={torchOn ? '#0a0a0a' : '#fff'} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#0a0a0c', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  permWrap: { flex: 1, backgroundColor: '#0a0a0c' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#151518', alignItems: 'center', justifyContent: 'center' },
  iconBtnDark: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  muted: { color: '#888892', fontSize: 13, marginTop: 8, textAlign: 'center' },
  muted2: { color: '#888892', fontSize: 14, lineHeight: 20, marginTop: 6, marginBottom: 20 },
  permTitle: { color: '#fff', fontSize: 20, fontWeight: '600', marginTop: 16, textAlign: 'center' },
  iconCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(57,197,187,0.12)', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 16 },
  codeTitle: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  inputWrap: { backgroundColor: '#0f0f12', borderRadius: 14, borderWidth: 1, borderColor: '#2a2a30', paddingHorizontal: 16, paddingVertical: 4 },
  inputErr: { borderColor: '#ff4444' },
  input: { color: '#fff', fontSize: 18, letterSpacing: 2, paddingVertical: 14, fontWeight: '600', textAlign: 'center' },
  errText: { color: '#ff4444', fontSize: 13, marginTop: 10, textAlign: 'center' },
  errBanner: { position: 'absolute', bottom: height * 0.3, alignSelf: 'center', backgroundColor: 'rgba(239,68,68,0.92)', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12 },
  dim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  dimSide: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  scanArea: { width: SCAN_AREA_SIZE, height: SCAN_AREA_SIZE },
  corner: { position: 'absolute', width: 30, height: 30, borderColor: '#39c5bb' },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 8 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 8 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 8 },
  br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 8 },
});
