import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { Colors, FontFamily, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

interface PrivacySummaryPillProps {
  shieldedBalance: number;
  confidentialBalance: number;
  denominatedBalance?: number;
  onPress: () => void;
}

export default function PrivacySummaryPill({
  shieldedBalance,
  confidentialBalance,
  denominatedBalance = 0,
  onPress,
}: PrivacySummaryPillProps) {
  const t = useT();
  const total = shieldedBalance + confidentialBalance + denominatedBalance;

  return (
    <Animated.View entering={FadeInUp.delay(300)} style={styles.outer}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Private balance ${total.toFixed(4)} SOL`} accessibilityHint="Opens privacy dashboard">
        <BlurView intensity={12} tint="dark" style={styles.pill}>
          <View style={styles.iconWrap}>
            <Ionicons name="shield-half" size={16} color={P01Colors.cyan} />
          </View>
          <View style={styles.info}>
            <Text style={styles.label}>{t('wallet.privacySummary')}</Text>
            <Text style={styles.amount}>{total.toFixed(4)} SOL</Text>
          </View>
          <Ionicons name="chevron-forward" size={14} color={Colors.textTertiary} />
        </BlurView>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.06)',
    marginBottom: 20,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(12, 12, 14, 0.6)',
    gap: 12,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(57, 197, 187, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1 },
  label: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  amount: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginTop: 1,
  },
});
