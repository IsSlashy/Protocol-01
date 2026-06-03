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
          <Text style={styles.headerTitle}>Connect to extension</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={64} color="#666" />
          <Text style={styles.permTitle}>Camera permission required</Text>
          <Text style={styles.muted}>Enable camera access to scan the extension’s QR.</Text>
          <Button onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()} className="mt-6">
            {permission.canAskAgain ? 'Grant permission' : 'Open settings'}
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  if (mode === 'code') {
    return (
      <SafeAreaView style={styles.permWrap}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => { setMode('scan'); setTarget(null); setCode(''); setError(''); setIsScanning(true); }}
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
              <Ionicons name="desktop-outline" size={36} color="#39c5bb" />
            </View>
            <Text style={styles.codeTitle}>Type the code from the extension</Text>
            <Text style={styles.muted2}>
              It’s the 16-character code shown under the QR. Your seed is encrypted to it before it leaves this phone.
            </Text>

            <View style={[styles.inputWrap, error ? styles.inputErr : null]}>
              <TextInput
                style={styles.input}
                placeholder="ABCD-EFGH-JKLM-NPQR"
                placeholderTextColor="#555560"
                value={code}
                onChangeText={(tx) => { setCode(formatCodeForDisplay(tx)); setError(''); }}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
              />
            </View>
            {error ? <Text style={styles.errText}>{error}</Text> : null}
          </View>

          <View style={{ paddingHorizontal: 20, paddingBottom: 28 }}>
            <Button onPress={handleSend} disabled={!code.trim() || sending} fullWidth size="lg">
              {sending ? 'Sending…' : 'Send to extension'}
            </Button>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        enableTorch={torchOn}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={isScanning ? handleBarCodeScanned : undefined}
      />
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
        <Text style={styles.headerTitle}>Connect to extension</Text>
        <Text style={styles.muted}>Scan the QR from the extension’s “Connect with phone”</Text>
      </View>

      {error ? (
        <View style={styles.errBanner}><Text style={{ color: '#fff', fontWeight: '600' }}>{error}</Text></View>
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
