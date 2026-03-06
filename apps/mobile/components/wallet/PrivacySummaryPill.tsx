import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface PrivacySummaryPillProps {
  shieldedBalance: number;
  confidentialBalance: number;
  onPress: () => void;
}

export default function PrivacySummaryPill({
  shieldedBalance,
  confidentialBalance,
  onPress,
}: PrivacySummaryPillProps) {
  const total = shieldedBalance + confidentialBalance;

  return (
    <Animated.View entering={FadeInUp.delay(300)}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Private balance ${total.toFixed(4)} SOL`} accessibilityHint="Opens privacy dashboard">
        <LinearGradient
          colors={[P01Colors.cyanDim, P01Colors.blueDim]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.pill}
        >
          <Ionicons name="shield-half" size={18} color={P01Colors.cyan} />
          <View style={styles.info}>
            <Text style={styles.label}>Private Balance</Text>
            <Text style={styles.amount}>{total.toFixed(4)} SOL</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
        </LinearGradient>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: `${P01Colors.cyan}25`,
  },
  info: { flex: 1 },
  label: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  amount: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
});
