/**
 * Protocol 01 - QR Scanner Component
 *
 * Scans QR codes to add mesh contacts
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Platform,
  TextInput,
  Alert,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
} from 'react-native-reanimated';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCAN_SIZE = SCREEN_WIDTH * 0.75;

const COLORS = {
  primary: '#39c5bb',
  cyan: '#39c5bb',
  pink: '#ff77a8',
  background: '#0a0a0c',
  surface: '#0f0f12',
  surfaceSecondary: '#151518',
  border: '#2a2a30',
  text: '#ffffff',
  textSecondary: '#888892',
};

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
  title?: string;
  subtitle?: string;
}

export function QRScanner({
  onScan,
  onClose,
  title = 'Scan QR Code',
  subtitle = 'Point your camera at a P-01 QR code',
}: QRScannerProps) {
  // Camera permissions hook - called at top level
  const [permission, requestPermission] = useCameraPermissions();

  const [scanned, setScanned] = useState(false);
  const [torch, setTorch] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualInput, setManualInput] = useState('');

  // Scan line animation
  const scanLineY = useSharedValue(0);

  useEffect(() => {
    scanLineY.value = withRepeat(
      withSequence(
        withTiming(SCAN_SIZE - 8, { duration: 2000 }),
        withTiming(0, { duration: 2000 })
      ),
      -1,
      false
    );
  }, []);

  const scanLineStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: scanLineY.value }],
  }));

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;

    // Accept P-01 URLs, Solana URLs, or raw addresses
    if (data.startsWith('p01://') || data.startsWith('solana:') || data.length >= 32) {
      setScanned(true);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      onScan(data);
    }
  };

  const handleManualSubmit = () => {
    const trimmed = manualInput.trim();
    if (trimmed.length >= 32 || trimmed.startsWith('p01://') || trimmed.startsWith('solana:')) {
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      onScan(trimmed);
    } else {
      Alert.alert('Invalid Address', 'Please enter a valid Solana address');
    }
  };

  // Manual input mode
  if (showManual) {
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={['rgba(57, 197, 187, 0.05)', 'transparent']}
          style={styles.gradient}
        />

        <View style={styles.manualHeader}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={28} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Enter Address</Text>
          <Text style={styles.subtitle}>Paste a Solana wallet address</Text>
        </View>

        <View style={styles.manualContent}>
          <View style={styles.inputBox}>
            <Ionicons name="wallet-outline" size={20} color={COLORS.textSecondary} />
            <TextInput
              style={styles.input}
              placeholder="Solana address..."
              placeholderTextColor={COLORS.textSecondary}
              value={manualInput}
              onChangeText={setManualInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <TouchableOpacity onPress={handleManualSubmit} style={styles.submitBtn}>
            <LinearGradient
              colors={[COLORS.cyan, COLORS.pink]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.submitGradient}
            >
              <Text style={styles.submitText}>Add Contact</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setShowManual(false)} style={styles.switchBtn}>
            <Ionicons name="camera" size={20} color={COLORS.cyan} />
            <Text style={styles.switchText}>Use Camera</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Permission not determined yet
  if (!permission) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.loadingText}>Loading camera...</Text>
      </View>
    );
  }

  // Permission denied - show request screen
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={['rgba(57, 197, 187, 0.05)', 'transparent']}
          style={styles.gradient}
        />

        <View style={styles.permissionContainer}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={28} color={COLORS.text} />
          </TouchableOpacity>

          <View style={styles.permissionIcon}>
            <Ionicons name="camera" size={48} color={COLORS.cyan} />
          </View>

          <Text style={styles.permissionTitle}>Camera Access</Text>
          <Text style={styles.permissionText}>
            Allow camera access to scan QR codes
          </Text>

          <TouchableOpacity onPress={requestPermission} style={styles.permissionBtn}>
            <LinearGradient
              colors={[COLORS.cyan, COLORS.pink]}
              style={styles.permissionBtnGradient}
            >
              <Text style={styles.permissionBtnText}>Enable Camera</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setShowManual(true)} style={styles.manualBtn}>
            <Text style={styles.manualBtnText}>Enter Manually Instead</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Camera view
  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />

      {/* Dark overlay with cutout */}
      <View style={styles.overlay}>
        {/* Top section */}
        <View style={styles.overlayTop}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={28} color={COLORS.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </View>
        </View>

        {/* Middle section with scan frame */}
        <View style={styles.overlayMiddle}>
          <View style={styles.overlaySide} />

          <View style={styles.scanFrame}>
            {/* Corners */}
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />

            {/* Scan line */}
            <Animated.View style={[styles.scanLine, scanLineStyle]}>
              <LinearGradient
                colors={['transparent', COLORS.cyan, 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.scanLineGradient}
              />
            </Animated.View>
          </View>

          <View style={styles.overlaySide} />
        </View>

        {/* Bottom section */}
        <View style={styles.overlayBottom}>
          <TouchableOpacity
            onPress={() => setTorch(!torch)}
            style={[styles.actionBtn, torch && styles.actionBtnActive]}
          >
            <Ionicons
              name={torch ? 'flash' : 'flash-outline'}
              size={24}
              color={torch ? COLORS.primary : COLORS.text}
            />
            <Text style={[styles.actionText, torch && { color: COLORS.primary }]}>
              Flash
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setShowManual(true)}
            style={styles.actionBtn}
          >
            <Ionicons name="keypad" size={24} color={COLORS.text} />
            <Text style={styles.actionText}>Manual</Text>
          </TouchableOpacity>

          {scanned && (
            <TouchableOpacity
              onPress={() => setScanned(false)}
              style={styles.actionBtn}
            >
              <Ionicons name="refresh" size={24} color={COLORS.cyan} />
              <Text style={[styles.actionText, { color: COLORS.cyan }]}>Retry</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  gradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 300,
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: 16,
  },

  // Overlay
  overlay: {
    flex: 1,
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingTop: 50,
    alignItems: 'center',
  },
  overlayMiddle: {
    flexDirection: 'row',
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
  },

  // Close button
  closeBtn: {
    position: 'absolute',
    top: 50,
    left: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },

  // Header
  headerCenter: {
    alignItems: 'center',
    marginTop: 30,
  },
  title: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },

  // Scan frame
  scanFrame: {
    width: SCAN_SIZE,
    height: SCAN_SIZE,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderColor: COLORS.cyan,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 16,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 16,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 16,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 16,
  },
  scanLine: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 4,
  },
  scanLineGradient: {
    flex: 1,
    borderRadius: 2,
  },

  // Action buttons
  actionBtn: {
    alignItems: 'center',
    padding: 12,
  },
  actionBtnActive: {
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    borderRadius: 12,
  },
  actionText: {
    color: COLORS.text,
    fontSize: 12,
    marginTop: 4,
  },

  // Permission screen
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  permissionIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: COLORS.cyan + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  permissionTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  permissionText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 32,
  },
  permissionBtn: {
    borderRadius: 16,
    overflow: 'hidden',
    width: '100%',
  },
  permissionBtnGradient: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  permissionBtnText: {
    color: '#0a0a0c',
    fontSize: 16,
    fontWeight: 'bold',
  },
  manualBtn: {
    marginTop: 20,
    padding: 12,
  },
  manualBtnText: {
    color: COLORS.cyan,
    fontSize: 14,
  },

  // Manual input screen
  manualHeader: {
    alignItems: 'center',
    paddingTop: 100,
    paddingHorizontal: 20,
  },
  manualContent: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 40,
  },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 16,
    paddingHorizontal: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  input: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    paddingVertical: 18,
  },
  submitBtn: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  submitGradient: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  submitText: {
    color: '#0a0a0c',
    fontSize: 16,
    fontWeight: 'bold',
  },
  switchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 24,
    padding: 12,
  },
  switchText: {
    color: COLORS.cyan,
    fontSize: 15,
    fontWeight: '600',
  },
});

export default QRScanner;
