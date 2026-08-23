/**
 * PrivacySummaryPill — the private balance, as one line on the front door.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23.
 *   - the label was an all-caps, letterspaced "PRIVACY SUMMARY". That house
 *     style is being removed everywhere; it is sentence case now, and the copy
 *     says what the number is rather than naming a report.
 *   - the row was a `BlurView` over a translucent grey with a cyan-tinted ring.
 *     A blur costs a frame on every scroll and said nothing the panel fill and
 *     one hairline do not.
 *   - the whole row is one target and it is 56pt, so the amount and the label
 *     are both part of the same tap rather than decoration beside it.
 *
 * ⚠️ The prop names and the `onPress` destination are unchanged: the arithmetic
 * that produces these three numbers lives on the wallet screen and is not this
 * component's business.
 */

import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
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
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`${t('wallet.privacySummary')}, ${total.toFixed(4)} SOL`}
    >
      <Ionicons name="shield-half-outline" size={18} color={Colors.primary} />
      <Text style={styles.label}>{t('wallet.privacySummary')}</Text>
      <Text style={styles.amount}>{total.toFixed(4)} SOL</Text>
      <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 56,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  label: {
    flex: 1,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.text,
  },
  amount: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
});
