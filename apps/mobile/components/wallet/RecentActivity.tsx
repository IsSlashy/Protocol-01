/**
 * RecentActivity — the last three things that happened, and a way to the rest.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23.
 *   - the section had a PINK dot beside its title and a pink-tinted ring around
 *     its panel. Pink is retired (founder ruling); the send rows were pink too,
 *     which meant "money left your wallet" and "this is the activity section"
 *     were said in the same colour.
 *   - ⛔ ONE ACCENT. A received amount is the accent because it is the only
 *     state worth colouring; a send is plain text. Three tinted icon discs in a
 *     column is a colour key nobody asked for.
 *   - the `BlurView` is gone, for the reason `AssetsList` gives.
 *
 * ⚠️ The empty state says one thing, not two. It used to stack "No activity
 * yet" on "Transactions will appear here", which is the same sentence twice.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { formatTxDate } from '@/services/solana/transactions';
import { useT } from '@/i18n';

interface Transaction {
  signature: string;
  type: string;
  amount?: number;
  token?: string;
  timestamp: number;
  status: string;
}

interface RecentActivityProps {
  transactions: Transaction[];
  onSeeAll: () => void;
}

const TX_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  receive: 'arrow-down',
  send: 'arrow-up',
  swap: 'swap-horizontal',
};

export default function RecentActivity({ transactions, onSeeAll }: RecentActivityProps) {
  const t = useT();
  const items = transactions.slice(0, 3);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {t('wallet.recentActivity')}
        </Text>
        {transactions.length > 0 ? (
          <TouchableOpacity
            onPress={onSeeAll}
            style={styles.seeAllButton}
            accessibilityRole="button"
            accessibilityLabel={t('common.seeAll')}
          >
            <Text style={styles.seeAll}>{t('common.seeAll')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.panel}>
        {items.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{t('wallet.noActivity')}</Text>
          </View>
        ) : (
          items.map((tx, i) => {
            const received = tx.type === 'receive';
            const isLast = i === items.length - 1;
            return (
              <View key={tx.signature} style={[styles.txRow, !isLast && styles.txRowBorder]}>
                <View style={styles.txIcon}>
                  <Ionicons
                    name={TX_ICON[tx.type] ?? 'ellipse-outline'}
                    size={16}
                    color={Colors.textSecondary}
                  />
                </View>
                <View style={styles.txInfo}>
                  <Text style={styles.txType}>
                    {tx.type.charAt(0).toUpperCase() + tx.type.slice(1)}
                  </Text>
                  <Text style={styles.txDate}>{formatTxDate(tx.timestamp)}</Text>
                </View>
                <View style={styles.txAmount}>
                  <Text style={[styles.txAmountText, received && styles.txAmountReceived]}>
                    {received ? '+' : '-'}
                    {tx.amount?.toFixed(4) || '0'} {tx.token || 'SOL'}
                  </Text>
                  <Text style={styles.txStatus}>
                    {tx.status === 'confirmed' ? t('activity.confirmed') : tx.status}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: Spacing['2xl'] },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  seeAllButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: Spacing.lg,
  },
  seeAll: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
  },
  panel: {
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg,
  },
  empty: {
    paddingVertical: Spacing['2xl'],
    alignItems: 'center',
  },
  emptyText: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    minHeight: 60,
  },
  txRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  txIcon: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
    backgroundColor: Colors.surfaceTertiary,
  },
  txInfo: { flex: 1 },
  txType: { color: Colors.text, fontSize: FontSize.md, fontFamily: FontFamily.medium },
  txDate: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  txAmount: { alignItems: 'flex-end' },
  txAmountText: { fontSize: FontSize.md, fontFamily: FontFamily.mono, color: Colors.text },
  txAmountReceived: { color: Colors.primary },
  txStatus: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
});
