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
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { isValidSolanaAddress } from '@/utils/format/address';
import { isP01AuthRequest, parseAuthQR } from '@/services/auth/p01Auth';

const { width, height } = Dimensions.get('window');
const SCAN_AREA_SIZE = width * 0.7;

type ScanMode = 'camera' | 'manual';

export default function ScanScreen() {
  const router = useRouter();
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
        setError('QR Code P01 Auth invalide');
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

    // Validate scanned data
    if (isValidSolanaAddress(address) || address.endsWith('.sol') || address.startsWith('zk:')) {
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

  // Loading state
  if (!permission) {
    return (
      <SafeAreaView className="flex-1 bg-p01-void items-center justify-center">
        <ActivityIndicator size="large" color="#39c5bb" />
        <Text className="text-white mt-4">Requesting camera permission...</Text>
      </SafeAreaView>
    );
  }

  // No permission state
  if (!permission.granted) {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-row items-center justify-between px-5 py-4">
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          >
            <Ionicons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text className="text-white text-lg font-semibold">Scan QR Code</Text>
          <View className="w-10" />
        </View>

        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="camera-outline" size={64} color="#666666" />
          <Text className="text-white text-xl font-semibold mt-4 text-center">
            Camera Permission Required
          </Text>
          <Text className="text-p01-text-muted text-center mt-2">
            Please enable camera access in your device settings to scan QR codes.
          </Text>
          {permission.canAskAgain ? (
            <Button onPress={requestPermission} className="mt-6">
              Grant Permission
            </Button>
          ) : (
            <Button
              onPress={() => Linking.openSettings()}
              className="mt-6"
            >
              Open Settings
            </Button>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View className="flex-1 bg-black">
      {/* Camera View with Barcode Scanner */}
      {mode === 'camera' && (
        <View className="flex-1 bg-black">
          {/* Real Camera Feed */}
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
          {/* Scan Frame Overlay */}
          <View style={styles.overlay}>
              {/* Top Overlay */}
              <View style={styles.overlayTop} />

              {/* Middle Row */}
              <View style={styles.overlayMiddle}>
                {/* Left Overlay */}
                <View style={styles.overlaySide} />

                {/* Scan Area */}
                <View style={styles.scanArea}>
                  {/* Corner Markers */}
                  <View style={[styles.corner, styles.cornerTopLeft]} />
                  <View style={[styles.corner, styles.cornerTopRight]} />
                  <View style={[styles.corner, styles.cornerBottomLeft]} />
                  <View style={[styles.corner, styles.cornerBottomRight]} />

                  {/* Scanning Line Animation */}
                  {isScanning && (
                    <View style={styles.scanLine} />
                  )}
                </View>

                {/* Right Overlay */}
                <View style={styles.overlaySide} />
              </View>

              {/* Bottom Overlay */}
              <View style={styles.overlayBottom} />
            </View>

            {/* Instructions */}
            <View
              style={{
                position: 'absolute',
                top: height * 0.15,
                alignItems: 'center',
              }}
            >
              <Text className="text-white text-lg font-semibold">
                Scan QR Code
              </Text>
              <Text className="text-p01-text-muted text-sm mt-1">
                Position the QR code within the frame
              </Text>
            </View>

            {/* Error Message */}
            {error && (
              <View
                style={{
                  position: 'absolute',
                  bottom: height * 0.35,
                  backgroundColor: 'rgba(239, 68, 68, 0.9)',
                  paddingHorizontal: 20,
                  paddingVertical: 10,
                  borderRadius: 12,
                }}
              >
                <Text className="text-white font-medium">{error}</Text>
              </View>
            )}

          {/* Header */}
          <SafeAreaView
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
            }}
            edges={['top']}
          >
            <View className="flex-row items-center justify-between px-5 py-4">
              <TouchableOpacity
                onPress={() => router.back()}
                className="w-10 h-10 bg-black/50 rounded-full items-center justify-center"
              >
                <Ionicons name="close" size={24} color="#ffffff" />
              </TouchableOpacity>
              <View className="w-10" />
              <TouchableOpacity
                onPress={() => setTorchOn(!torchOn)}
                className={`w-10 h-10 rounded-full items-center justify-center ${
                  torchOn ? 'bg-p01-cyan' : 'bg-black/50'
                }`}
              >
                <Ionicons
                  name={torchOn ? 'flash' : 'flash-outline'}
                  size={22}
                  color={torchOn ? '#0a0a0a' : '#ffffff'}
                />
              </TouchableOpacity>
            </View>
          </SafeAreaView>

          {/* Bottom Controls */}
          <SafeAreaView
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
            }}
            edges={['bottom']}
          >
            <View className="px-5 pb-6">
              <TouchableOpacity
                onPress={() => setMode('manual')}
                className="bg-p01-surface/90 py-4 rounded-xl items-center flex-row justify-center"
              >
                <Ionicons name="create-outline" size={20} color="#39c5bb" />
                <Text className="text-white font-medium ml-2">
                  Enter Address Manually
                </Text>
              </TouchableOpacity>

              {/* Re-enable scanning if paused */}
              {!isScanning && (
                <TouchableOpacity
                  onPress={() => setIsScanning(true)}
                  className="bg-p01-cyan/20 py-3 rounded-xl items-center mt-3"
                >
                  <Text className="text-p01-cyan font-medium">
                    Scan Again
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </SafeAreaView>
        </View>
      )}

      {/* Manual Input Mode */}
      {mode === 'manual' && (
        <SafeAreaView className="flex-1 bg-p01-void">
          <KeyboardAvoidingView
            className="flex-1"
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            {/* Header */}
            <View className="flex-row items-center justify-between px-5 py-4">
              <TouchableOpacity
                onPress={() => setMode('camera')}
                className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
              >
                <Ionicons name="arrow-back" size={24} color="#ffffff" />
              </TouchableOpacity>
              <Text className="text-white text-lg font-semibold">
                Enter Address
              </Text>
              <TouchableOpacity
                onPress={() => router.back()}
                className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
              >
                <Ionicons name="close" size={24} color="#ffffff" />
              </TouchableOpacity>
            </View>

            <View className="flex-1 px-5 pt-6">
              {/* Input */}
              <View className="mb-4">
                <Text className="text-p01-text-muted text-sm mb-2 font-medium">
                  WALLET ADDRESS
                </Text>
                <View
                  className={`bg-p01-surface rounded-xl px-4 py-4 border ${
                    error ? 'border-red-500' : 'border-p01-border'
                  }`}
                >
                  <TextInput
                    className="text-white text-base"
                    placeholder="Enter Solana address or .sol domain"
                    placeholderTextColor="#666666"
                    value={manualAddress}
                    onChangeText={(text) => {
                      setManualAddress(text);
                      setError('');
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                  />
                </View>
                {error && (
                  <Text className="text-red-500 text-xs mt-2">{error}</Text>
                )}
              </View>

              {/* Example Addresses */}
              <Card variant="outlined" padding="md">
                <Text className="text-p01-text-muted text-sm mb-3">
                  Examples:
                </Text>
                <View className="gap-2">
                  <TouchableOpacity
                    onPress={() =>
                      setManualAddress(
                        '7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm'
                      )
                    }
                  >
                    <Text className="text-p01-cyan text-xs font-mono">
                      7nxQB4Hy9Lm...8fKm (Address)
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setManualAddress('p01.sol')}>
                    <Text className="text-p01-cyan text-xs font-mono">
                      p01.sol (Domain)
                    </Text>
                  </TouchableOpacity>
                </View>
              </Card>
            </View>

            {/* Bottom Button */}
            <View className="px-5 pb-6">
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
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  overlayMiddle: {
    flexDirection: 'row',
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  scanArea: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_SIZE,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: '#39c5bb',
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 8,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 8,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 8,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 8,
  },
  scanLine: {
    position: 'absolute',
    top: '50%',
    left: 10,
    right: 10,
    height: 2,
    backgroundColor: '#39c5bb',
    shadowColor: '#39c5bb',
    shadowOpacity: 0.8,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
});
