/**
 * Protocol 01 - QR Code Generator
 *
 * Generates scannable QR codes for sharing wallet/mesh identity
 * Uses react-native-qrcode-svg for proper QR code generation
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

interface QRCodeProps {
  value: string;
  size?: number;
  color?: string;
  backgroundColor?: string;
  logo?: React.ReactNode;
}

export function QRCodeGenerator({
  value,
  size = 200,
  color = '#ffffff',
  backgroundColor = '#0a0a0c',
  logo,
}: QRCodeProps) {
  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <QRCode
        value={value}
        size={size}
        color={color}
        backgroundColor={backgroundColor}
        ecl="M"
      />
      {logo && (
        <View style={styles.logoContainer}>
          {logo}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
    position: 'absolute',
    backgroundColor: '#0a0a0c',
    borderRadius: 8,
    padding: 8,
  },
});

export default QRCodeGenerator;
