import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { isDevnet } from '@/services/solana/connection';

interface WalletHeaderProps {
  onScan: () => void;
  onSettings: () => void;
}

export default function WalletHeader({ onScan, onSettings }: WalletHeaderProps) {
  return (
    <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
      <View style={styles.left}>
        <Image
          source={require('@/assets/images/01-miku.png')}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="Protocol 01 logo"
          accessibilityRole="image"
        />
        <View>
          <Text style={styles.brand} accessibilityRole="header">PROTOCOL 01</Text>
          {isDevnet() && (
            <View style={[styles.devnetBadge, { backgroundColor: P01Colors.pinkDim }]}>
              <Text style={[styles.devnetText, { color: P01Colors.pink }]}>DEVNET</Text>
            </View>
          )}
        </View>
      </View>
      <View style={styles.right}>
        <TouchableOpacity style={styles.button} onPress={onScan} accessibilityRole="button" accessibilityLabel="Scan QR code">
          <Ionicons name="scan-outline" size={20} color={Colors.text} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={onSettings} accessibilityRole="button" accessibilityLabel="Settings">
          <Ionicons name="settings-outline" size={20} color={Colors.text} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  left: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 80, height: 32, marginRight: Spacing.md },
  brand: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.bold,
    letterSpacing: 1,
  },
  devnetBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 2 },
  devnetText: { fontSize: 9, fontFamily: FontFamily.semibold, letterSpacing: 0.5 },
  right: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  button: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
