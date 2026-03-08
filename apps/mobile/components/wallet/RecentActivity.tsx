import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { Colors, FontFamily, P01Colors } from '@/constants/theme';
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

const TX_CONFIG: Record<string, { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }> = {
  receive: { icon: 'arrow-down', color: P01Colors.cyan, bg: 'rgba(57, 197, 187, 0.10)' },
  send: { icon: 'arrow-up', color: P01Colors.pink, bg: 'rgba(255, 119, 168, 0.10)' },
  swap: { icon: 'swap-horizontal', color: P01Colors.blue, bg: 'rgba(59, 130, 246, 0.10)' },
};

export default function RecentActivity({ transactions, onSeeAll }: RecentActivityProps) {
  const items = transactions.slice(0, 3);

  return (
    <Animated.View entering={FadeInUp.delay(500)} style={styles.section}>
      {/* Section header */}
      <View style={styles.sectionHeader}>
        <View style={styles.headerLeft}>
          <View style={[styles.headerDot, { backgroundColor: P01Colors.pink }]} />
          <Text style={styles.sectionTitle}>Activity</Text>
        </View>
        {transactions.length > 0 && (
          <TouchableOpacity onPress={onSeeAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.seeAll}>See all</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Glass container */}
      <View style={styles.glassOuter}>
        <BlurView intensity={12} tint="dark" style={styles.glassInner}>
          {items.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="time-outline" size={32} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>No transactions yet</Text>
              <Text style={styles.emptySubtext}>Your activity will appear here</Text>
            </View>
          ) : (
            items.map((tx, i) => {
              const cfg = TX_CONFIG[tx.type] || TX_CONFIG.swap;
              const isLast = i === items.length - 1;
              return (
                <View key={tx.signature} style={[styles.txRow, !isLast && styles.txRowBorder]}>
                  <View style={[styles.txIcon, { backgroundColor: cfg.bg }]}>
                    <Ionicons name={cfg.icon} size={16} color={cfg.color} />
                  </View>
                  <View style={styles.txInfo}>
                    <Text style={styles.txType}>
                      {tx.type.charAt(0).toUpperCase() + tx.type.slice(1)}
                    </Text>
                    <Text style={styles.txDate}>{formatTxDate(tx.timestamp)}</Text>
                  </View>
                  <View style={styles.txAmount}>
                    <Text style={[styles.txAmountText, { color: tx.type === 'receive' ? P01Colors.cyan : Colors.text }]}>
                      {tx.type === 'receive' ? '+' : '-'}{tx.amount?.toFixed(4) || '0'} {tx.token || 'SOL'}
                    </Text>
                    <Text style={styles.txStatus}>
                      {tx.status === 'confirmed' ? 'Confirmed' : tx.status}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </BlurView>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 20 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerDot: { width: 4, height: 4, borderRadius: 2 },
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  seeAll: { color: Colors.textTertiary, fontSize: 13, fontFamily: FontFamily.medium },
  glassOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 119, 168, 0.05)',
  },
  glassInner: {
    backgroundColor: 'rgba(12, 12, 14, 0.6)',
    paddingHorizontal: 16,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 28,
    gap: 6,
  },
  emptyText: { color: Colors.textSecondary, fontSize: 14, fontFamily: FontFamily.medium },
  emptySubtext: { color: Colors.textTertiary, fontSize: 12, fontFamily: FontFamily.regular },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  txRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  txIcon: {
    width: 36, height: 36, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  txInfo: { flex: 1 },
  txType: { color: Colors.text, fontSize: 14, fontFamily: FontFamily.medium },
  txDate: { color: Colors.textTertiary, fontSize: 12, fontFamily: FontFamily.regular, marginTop: 2 },
  txAmount: { alignItems: 'flex-end' },
  txAmountText: { fontSize: 14, fontFamily: FontFamily.semibold },
  txStatus: { color: Colors.textTertiary, fontSize: 11, fontFamily: FontFamily.regular, marginTop: 2 },
});
