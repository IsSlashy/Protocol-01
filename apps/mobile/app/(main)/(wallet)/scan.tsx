/**
 * Scan — a QR code, or an address typed by hand.
 *
 * 🎯 REWRITTEN IN StyleSheet 2026-08-23. This screen was almost entirely
 * Tailwind class strings (`text-white`, `bg-black/50`, `border-red-500`,
 * `placeholderTextColor="#666666"`), which is the exact failure mode the
 * realignment is closing: those names resolve in a config file nobody edits
 * when the design changes, so the token sweep over `constants/theme.ts` moved
 * every screen except the ones written this way. `text-white` in particular is
 * the single most visible thing the realignment removes — the brand's text is
 * warm paper, not white.
 *
 * ⚠️ THE CAMERA SCRIM IS THE ONE PLACE A NEAR-BLACK IS CORRECT, and it is still
 * a token: `Colors.background` with an alpha suffix, so it darkens toward the
 * app's own ink rather than toward a black the brand does not use.
 *
 * 🚨 THE ERROR OVER THE VIEWFINDER NOW ANNOUNCES ITSELF. It was a red pill with
 * no `accessibilityRole`, which meant a screen-reader user pointing a camera at
 * an invalid code got silence and a scanner that had stopped.
 *
 * ⛔ Nothing about what a scanned code MEANS changed: the P01 auth branch, the
 * `zk:` and `st:01` prefixes, the Solana Pay stripping and every route this
 * screen pushes to are untouched.
 */

import React, { useState, useEffect, useRef } from 'react';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { Button } from '@/components/ui/Button';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { isValidSolanaAddress } from '@/utils/format/address';
import { isP01AuthRequest, parseAuthQR } from '@/services/auth/p01Auth';

const { width, height } = Dimensions.get('window');
const SCAN_AREA_SIZE = width * 0.7;

/** The viewfinder scrim: the app's own ink at ~70%, not a black from nowhere. */
const SCRIM = Colors.background + 'B3';
/** The pill behind a control sitting on top of the camera feed. */
const OVER_CAMERA = Colors.background + 'CC';

type ScanMode = 'camera' | 'manual';

export default function ScanScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // The tab bar floats over every screen in this stack; bottom actions clear it.
  const bottomClearance = Layout.tabBarTotalHeight + insets.bottom;
  const cameraRef = useRef<CameraView>(null);

  const [mode, setMode] = useState<ScanMode>('camera');
  const [torchOn, setTorchOn] = useState(false);
  const [manualAddress, setManualAddress] = useState('');
  const [error, setError] = useState('');
  const [isScanning, setIsScanning] = useState(true);
  const [permission, requestPermission] = useCameraPermissions();

  // Request camera permission on mount
  useEffect(() => {
    if (!permission?.granted && permission?.canAskAgain) {
      requestPermission();
    }
  }, [permission]);

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    if (!isScanning) return;
    setIsScanning(false);

    const data = result.data;

    // Check for P01 Auth QR codes (Login with Protocol 01)
    if (isP01AuthRequest(data)) {
      const authRequest = parseAuthQR(data);
      if (authRequest) {
        // Navigate to auth confirmation screen
        router.push({
          pathname: '/(main)/(wallet)/auth-confirm',
          params: {
            payload: JSON.stringify(authRequest.payload),
            serviceName: authRequest.serviceName,
            serviceLogo: authRequest.serviceLogo || '',
            requiresSubscription: authRequest.requiresSubscription ? '1' : '0',
            isExpired: authRequest.isExpired ? '1' : '0',
          },
        });
        return;
      } else {
        setError('Invalid P01 Auth QR code');
        setTimeout(() => {
          setError('');
          setIsScanning(true);
        }, 3000);
        return;
      }
    }

    // Handle Solana Pay URLs: solana:<address>?...
    let address = data;
    if (data.startsWith('solana:')) {
      const parsed = data.slice(7).split('?')[0];
      address = parsed;
    }

    // L6: Validate scanned data — route zk: addresses to shielded transfer
    if (address.startsWith('zk:')) {
      const zkAddr = address.slice(3);
      if (zkAddr.length >= 32) {
        router.push({
          pathname: '/(main)/(privacy)/shielded-transfer',
          params: { address: zkAddr },
        } as any);
      } else {
        setError('Invalid ZK address format.');
        setTimeout(() => { setError(''); setIsScanning(true); }, 3000);
      }
    } else if (address.startsWith('st:01') || address.startsWith('st:02')) {
      // P01 stealth meta-address → route to Private Send
      router.push({
        pathname: '/(main)/(privacy)/private-send',
        params: { address },
      });
    } else if (isValidSolanaAddress(address) || address.endsWith('.sol')) {
      // Navigate back to send screen with the address
      router.push({
        pathname: '/(main)/(wallet)/send',
        params: { address },
      });
    } else {
      setError('Invalid QR code. Please scan a valid Solana address.');
      setTimeout(() => {
        setError('');
        setIsScanning(true);
      }, 3000);
    }
  };

  const handleManualSubmit = () => {
    if (!manualAddress.trim()) {
      setError('Please enter an address');
      return;
    }

    if (!isValidSolanaAddress(manualAddress) && !manualAddress.endsWith('.sol')) {
      setError('Invalid Solana address');
      return;
    }

    router.push({
      pathname: '/(main)/(wallet)/send',
      params: { address: manualAddress },
    });
  };

  // Waiting on the permission object itself
  if (!permission) {
    return (
      <SafeAreaView style={[styles.ground, styles.centred]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.centredNote}>Asking for camera access…</Text>
      </SafeAreaView>
    );
  }

  // Permission refused
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.ground}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={24} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} accessibilityRole="header">Scan</Text>
          <View style={styles.headerButton} />
        </View>

        <View style={styles.centred}>
          <Ionicons name="camera-outline" size={48} color={Colors.textTertiary} />
          <Text style={styles.blockedTitle}>Camera access is off</Text>
          <Text style={styles.blockedBody}>
            Styx needs the camera to read a QR code. Nothing is recorded or sent anywhere.
          </Text>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            style={styles.blockedAction}
            onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
          >
            {permission.canAskAgain ? 'Allow camera' : 'Open settings'}
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.cameraRoot}>
      {mode === 'camera' && (
        <View style={styles.cameraRoot}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFillObject}
            facing="back"
            enableTorch={torchOn}
            barcodeScannerSettings={{
              barcodeTypes: ['qr'],
            }}
            onBarcodeScanned={isScanning ? handleBarCodeScanned : undefined}
          />

          {/* Viewfinder */}
          <View style={StyleSheet.absoluteFillObject}>
            <View style={styles.scrim} />
            <View style={styles.overlayMiddle}>
              <View style={styles.scrim} />
              <View style={styles.scanArea}>
                <View style={[styles.corner, styles.cornerTopLeft]} />
                <View style={[styles.corner, styles.cornerTopRight]} />
                <View style={[styles.corner, styles.cornerBottomLeft]} />
                <View style={[styles.corner, styles.cornerBottomRight]} />
              </View>
              <View style={styles.scrim} />
            </View>
            <View style={styles.scrim} />
          </View>

          {/* Instruction */}
          <View style={[styles.instructions, { top: height * 0.15 }]} pointerEvents="none">
            <Text style={styles.instructionsTitle}>Point at a QR code</Text>
            <Text style={styles.instructionsBody}>An address, or a Styx sign-in request</Text>
          </View>

          {/* Error */}
          {error ? (
            <View style={[styles.error, { bottom: height * 0.32 }]} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Top controls */}
          <SafeAreaView style={styles.topBar} edges={['top']}>
            <View style={styles.header}>
              <TouchableOpacity
                onPress={() => router.back()}
                style={[styles.headerButton, styles.overCamera]}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={22} color={Colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setTorchOn(!torchOn)}
                style={[styles.headerButton, torchOn ? styles.torchOn : styles.overCamera]}
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

          {/* Bottom controls */}
          <SafeAreaView style={styles.bottomBar} edges={['bottom']}>
            <View style={[styles.bottomInner, { paddingBottom: bottomClearance }]}>
              {!isScanning ? (
                <Button variant="primary" size="lg" fullWidth onPress={() => setIsScanning(true)}>
                  Scan again
                </Button>
              ) : (
                <Button variant="secondary" size="lg" fullWidth onPress={() => setMode('manual')}>
                  Type an address instead
                </Button>
              )}
            </View>
          </SafeAreaView>
        </View>
      )}

      {mode === 'manual' && (
        <SafeAreaView style={styles.ground}>
          <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <View style={styles.header}>
              <TouchableOpacity
                onPress={() => setMode('camera')}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel="Back to the camera"
              >
                <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
              </TouchableOpacity>
              <Text style={styles.headerTitle} accessibilityRole="header">Enter address</Text>
              <TouchableOpacity
                onPress={() => router.back()}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={22} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.manualBody}>
              <Text style={styles.fieldLabel}>Wallet address</Text>
              <View style={[styles.field, error ? styles.fieldError : null]}>
                <TextInput
                  style={styles.fieldInput}
                  placeholder="Solana address or .sol domain"
                  placeholderTextColor={Colors.textTertiary}
                  value={manualAddress}
                  onChangeText={(text) => {
                    setManualAddress(text);
                    setError('');
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  accessibilityLabel="Wallet address"
                />
              </View>
              {error ? (
                <Text style={styles.fieldErrorText} accessibilityRole="alert">{error}</Text>
              ) : null}
            </View>

            <View style={[styles.manualFooter, { paddingBottom: bottomClearance }]}>
              <Button
                onPress={handleManualSubmit}
                disabled={!manualAddress.trim()}
                fullWidth
                size="lg"
              >
                Continue
              </Button>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  ground: { flex: 1, backgroundColor: Colors.background },
  cameraRoot: { flex: 1, backgroundColor: Colors.background },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing['3xl'],
  },
  centredNote: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    marginTop: Spacing.lg,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    minHeight: 56,
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  overCamera: { backgroundColor: OVER_CAMERA },
  torchOn: { backgroundColor: Colors.primary },

  // Permission refused
  blockedTitle: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
    textAlign: 'center',
    marginTop: Spacing['2xl'],
  },
  blockedBody: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: Spacing.sm,
  },
  blockedAction: { marginTop: Spacing['3xl'] },

  // Viewfinder
  scrim: { flex: 1, backgroundColor: SCRIM },
  overlayMiddle: { flexDirection: 'row' },
  scanArea: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_SIZE,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: Colors.primary,
  },
  cornerTopLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  cornerTopRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  cornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  cornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },

  instructions: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  instructionsTitle: {
    color: Colors.text,
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
  },
  instructionsBody: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
  },

  error: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '86%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.error,
    backgroundColor: Colors.surface,
  },
  errorText: {
    color: Colors.error,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },

  topBar: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  bottomInner: { paddingHorizontal: Spacing.xl },

  // Manual entry
  manualBody: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing['2xl'] },
  fieldLabel: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    marginBottom: Spacing.sm,
  },
  field: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: 56,
    justifyContent: 'center',
  },
  fieldError: { borderColor: Colors.error },
  fieldInput: {
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.md,
    lineHeight: 22,
  },
  fieldErrorText: {
    color: Colors.error,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    marginTop: Spacing.sm,
  },
  manualFooter: { paddingHorizontal: Spacing.xl },
});
