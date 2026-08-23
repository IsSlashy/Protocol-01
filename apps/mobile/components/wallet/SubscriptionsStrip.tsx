/**
 * SubscriptionsStrip — what you already pay for, as one line on the front door.
 *
 * 🎯 WHY IT EXISTS. Merchant subscriptions are the product (founder ruling
 * 2026-08-23) and the wallet home screen did not mention them once. It offered
 * Send, Receive and Swap — two parked features and a token swap — while the
 * thing the protocol is for lived two taps away behind a tab named after a
 * parked one. A front door should show what the product does.
 *
 * ⚠️ IT READS, IT DOES NOT FETCH. The stream store is read as-is; nothing here
 * initialises it or triggers a sync, because this is a UI pass and the wallet
 * screen is not where that decision belongs. Before the Subs tab has hydrated
 * the strip says so honestly — "None yet" — rather than showing a zero it has
 * not verified.
 *
 * Sibling of `PrivacySummaryPill`, and deliberately the same shape: two rows
 * that look alike are two rows a thumb learns once.
 */

import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { useT } from '@/i18n';

interface SubscriptionsStripProps {
  /** Subscriptions currently being paid. */
  activeCount: number;
  /** Next payment, as a timestamp in ms. Omitted when nothing is scheduled. */
  nextPaymentAt?: number;
  onPress: () => void;
}

/** Coarse on purpose: an exact countdown implies a precision the scheduler has not got. */
function whenLabel(at: number): string | null {
  const days = Math.ceil((at - Date.now()) / 86_400_000);
  if (!Number.isFinite(days)) return null;
  if (days <= 0) return 'due now';
  if (days === 1) return 'next in 1 day';
  return `next in ${days} days`;
}

export default function SubscriptionsStrip({
  activeCount,
  nextPaymentAt,
  onPress,
}: SubscriptionsStripProps) {
  const t = useT();

  const when = nextPaymentAt ? whenLabel(nextPaymentAt) : null;
  const detail =
    activeCount === 0
      ? 'None yet'
      : when
        ? `${activeCount} active · ${when}`
        : `${activeCount} active`;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`${t('wallet.subscriptions')}, ${detail}`}
    >
      <Ionicons name="repeat-outline" size={18} color={Colors.primary} />
      <Text style={styles.label}>{t('wallet.subscriptions')}</Text>
      <Text style={styles.detail}>{detail}</Text>
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
  detail: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
});
