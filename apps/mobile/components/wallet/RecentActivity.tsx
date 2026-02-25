import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import { formatTxDate } from '@/services/solana/transactions';

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

export default function RecentActivity({ transactions, onSeeAll }: RecentActivityProps) {
  return (
    <Animated.View entering={FadeInUp.delay(500)} style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>RECENT ACTIVITY</Text>
        <TouchableOpacity onPress={onSeeAll}>
          <Text style={styles.seeAll}>See All</Text>
        </TouchableOpacity>
      </View>

      {transactions.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="time-outline" size={40} color={Colors.textTertiary} />
          <Text style={styles.emptyText}>No transactions yet</Text>
          <Text style={styles.emptySubtext}>Your transaction history will appear here</Text>
        </View>
      ) : (
        transactions.slice(0, 3).map((tx) => (
          <View key={tx.signature} style={styles.txRow}>
            <View
              style={[
                styles.txIcon,
                {
                  backgroundColor:
                    tx.type === 'receive' ? Colors.successDim
                      : tx.type === 'send' ? Colors.errorDim
                      : Colors.blueDim,
                },
              ]}
            >
              <Ionicons
                name={tx.type === 'receive' ? 'arrow-down' : tx.type === 'send' ? 'arrow-up' : 'swap-horizontal'}
                size={18}
                color={tx.type === 'receive' ? Colors.success : tx.type === 'send' ? Colors.error : Colors.blue}
              />
            </View>
            <View style={styles.txInfo}>
              <Text style={styles.txType}>{tx.type.charAt(0).toUpperCase() + tx.type.slice(1)}</Text>
              <Text style={styles.txDate}>{formatTxDate(tx.timestamp)}</Text>
            </View>
            <View style={styles.txAmount}>
              <Text style={[styles.txAmountText, { color: tx.type === 'receive' ? Colors.success : Colors.text }]}>
                {tx.type === 'receive' ? '+' : '-'}{tx.amount?.toFixed(4) || '0'} {tx.token || 'SOL'}
              </Text>
              <Text style={styles.txStatus}>{tx.status === 'confirmed' ? 'Confirmed' : tx.status}</Text>
            </View>
          </View>
        ))
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 24 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  sectionTitle: { color: Colors.textSecondary, fontSize: 13, fontFamily: FontFamily.semibold, letterSpacing: 1 },
  seeAll: { color: Colors.primary, fontSize: 13, fontFamily: FontFamily.medium },
  empty: {
    alignItems: 'center',
    paddingVertical: 32,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyText: { color: Colors.textSecondary, fontSize: 15, fontFamily: FontFamily.medium, marginTop: Spacing.md },
  emptySubtext: { color: Colors.textTertiary, fontSize: 13, fontFamily: FontFamily.regular, marginTop: 4 },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    padding: 16,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  txIcon: {
    width: 40, height: 40, borderRadius: 9999,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  txInfo: { flex: 1 },
  txType: { color: Colors.text, fontSize: 15, fontFamily: FontFamily.medium },
  txDate: { color: Colors.textSecondary, fontSize: 13, fontFamily: FontFamily.regular, marginTop: 2 },
  txAmount: { alignItems: 'flex-end' },
  txAmountText: { fontSize: 15, fontFamily: FontFamily.semibold },
  txStatus: { color: Colors.textTertiary, fontSize: 12, fontFamily: FontFamily.regular, marginTop: 2 },
});
