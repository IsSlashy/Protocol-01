import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import {
  fetchCryptoPrices,
  fetchOrders,
  getSeedOrders,
  PAYMENT_METHOD_CONFIG,
  type MugenOrder,
  type CryptoPrice,
  type PaymentMethod,
} from '@/services/mugen';

// Mugen Gojo Theme Colors
const MUGEN = {
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.12)',
  violet: '#8b5cf6',
  violetDim: 'rgba(139, 92, 246, 0.12)',
  cyan: '#60a5fa',
  success: '#22c55e',
  warning: '#eab308',
};

const PAYMENT_COLORS: Record<PaymentMethod, string> = {
  bank: MUGEN.blue,
  revolut: MUGEN.violet,
  wise: MUGEN.success,
  sepa: MUGEN.cyan,
  zelle: '#7c3aed',
  cash: MUGEN.warning,
};

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export default function BuyP2PScreen() {
  const router = useRouter();
  const { publicKey } = useWalletStore();

  const [orders, setOrders] = useState<MugenOrder[]>([]);
  const [prices, setPrices] = useState<CryptoPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tokenFilter, setTokenFilter] = useState<string>('all');
  const [selectedOrder, setSelectedOrder] = useState<MugenOrder | null>(null);

  const solPrice = prices.find(p => p.symbol === 'SOL')?.usd ?? 0;

  // Fetch data
  const loadData = useCallback(async () => {
    try {
      const [fetchedPrices, fetchedOrders] = await Promise.all([
        fetchCryptoPrices(),
        fetchOrders(),
      ]);
      setPrices(fetchedPrices);
      // Use real orders if available, otherwise seed orders
      setOrders(fetchedOrders.length > 0 ? fetchedOrders : getSeedOrders());
    } catch (err) {
      console.error('[buy-p2p] Load error:', err);
      setOrders(getSeedOrders());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    loadData();
  }, [loadData]);

  const filteredOrders = orders.filter(o => {
    if (o.orderType !== 'sell_crypto') return false; // Only show sell orders (user is buying)
    if (tokenFilter !== 'all' && o.token !== tokenFilter) return false;
    return true;
  });

  const handleTakeOrder = useCallback((order: MugenOrder) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (!publicKey) {
      p01Alert('Wallet Required', 'Connect your wallet to buy crypto.', [
        { text: 'OK' },
      ]);
      return;
    }

    setSelectedOrder(order);
    const pricePerUnit = (order.fiatAmount / 100) / order.cryptoAmount;
    p01Alert(
      `Buy ${order.cryptoAmount} ${order.token}`,
      `Price: $${(order.fiatAmount / 100).toFixed(2)} ${order.fiatCurrency}\n` +
      `Rate: $${pricePerUnit.toFixed(2)} per ${order.token}\n` +
      `Payment: ${order.paymentMethods.map(m => PAYMENT_METHOD_CONFIG[m].name).join(', ')}\n\n` +
      `The seller's crypto will be locked in an on-chain escrow. ` +
      `You'll send fiat directly to the seller via your chosen payment method.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Take Order',
          onPress: () => handleConfirmTake(order),
        },
      ],
    );
  }, [publicKey]);

  const handleConfirmTake = useCallback(async (order: MugenOrder) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    // TODO: Wire to sdk.exchange.takeOrder()
    // For now, show the payment instructions
    p01Alert(
      'Escrow Created',
      `${order.cryptoAmount} ${order.token} locked in escrow.\n\n` +
      `Send $${(order.fiatAmount / 100).toFixed(2)} to the seller via ${order.paymentMethods[0]}.\n\n` +
      `The seller will share their payment details in the encrypted chat. ` +
      `Once you've sent the fiat, confirm your payment to notify the seller.`,
      [
        { text: 'OK', onPress: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) },
      ],
      'success',
    );
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.duration(400)} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Buy Crypto</Text>
          <Text style={styles.headerSubtitle}>
            P01 Network • No KYC • ZK Compliance
          </Text>
        </View>
        <View style={styles.priceBadge}>
          <Text style={styles.priceLabel}>SOL</Text>
          <Text style={styles.priceValue}>
            {solPrice > 0 ? `$${solPrice.toFixed(0)}` : '...'}
          </Text>
        </View>
      </Animated.View>

      {/* Token filter */}
      <Animated.View entering={FadeInDown.delay(100).duration(300)} style={styles.filterRow}>
        {['all', 'SOL', 'USDC', 'USDT'].map(t => (
          <TouchableOpacity
            key={t}
            onPress={() => { setTokenFilter(t); Haptics.selectionAsync(); }}
            style={[
              styles.filterChip,
              tokenFilter === t && styles.filterChipActive,
            ]}
          >
            <Text style={[
              styles.filterChipText,
              tokenFilter === t && styles.filterChipTextActive,
            ]}>
              {t === 'all' ? 'All' : t}
            </Text>
          </TouchableOpacity>
        ))}
      </Animated.View>

      {/* Content */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={MUGEN.blue} />
          <Text style={styles.loadingText}>Loading orders from Solana...</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={MUGEN.blue} />
          }
        >
          {/* Info card */}
          <Animated.View entering={FadeInDown.delay(200).duration(400)} style={styles.infoCard}>
            <LinearGradient
              colors={['rgba(59,130,246,0.08)', 'rgba(139,92,246,0.04)']}
              style={styles.infoGradient}
            >
              <Ionicons name="shield-checkmark" size={20} color={MUGEN.blue} />
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={styles.infoTitle}>P01 Network — Buy with Privacy</Text>
                <Text style={styles.infoDesc}>
                  Buy crypto with IBAN, Revolut, or Wise. Payments are secured by on-chain escrow. No KYC — ZK compliance proofs only.
                </Text>
              </View>
            </LinearGradient>
          </Animated.View>

          {/* Orders */}
          {filteredOrders.map((order, index) => (
            <Animated.View
              key={order.address}
              entering={FadeInUp.delay(300 + index * 80).duration(400)}
            >
              <TouchableOpacity
                style={styles.orderCard}
                onPress={() => handleTakeOrder(order)}
                activeOpacity={0.7}
              >
                {/* Token badge + amount */}
                <View style={styles.orderTop}>
                  <View style={[styles.tokenBadge, { borderColor: order.token === 'SOL' ? MUGEN.blue + '40' : MUGEN.violet + '40' }]}>
                    <Text style={[styles.tokenBadgeText, { color: order.token === 'SOL' ? MUGEN.cyan : '#a78bfa' }]}>
                      {order.token}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.orderAmount}>
                      {order.cryptoAmount} {order.token}
                    </Text>
                    <Text style={styles.orderPrice}>
                      ${(order.fiatAmount / 100).toFixed(2)} {order.fiatCurrency}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.orderRate}>
                      ${((order.fiatAmount / 100) / order.cryptoAmount).toFixed(2)}/{order.token}
                    </Text>
                    <Text style={styles.orderTime}>{timeAgo(order.createdAt)} ago</Text>
                  </View>
                </View>

                {/* Bottom: seller + payment methods */}
                <View style={styles.orderBottom}>
                  <View style={styles.sellerInfo}>
                    <Text style={styles.sellerAddress}>{order.maker}</Text>
                    <View style={styles.repBadge}>
                      <Ionicons name="star" size={10} color={MUGEN.success} />
                      <Text style={styles.repText}>
                        {order.reputation.positive}/{order.reputation.trades}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.paymentMethods}>
                    {order.paymentMethods.map(m => (
                      <View
                        key={m}
                        style={[styles.paymentBadge, { borderColor: PAYMENT_COLORS[m] + '30', backgroundColor: PAYMENT_COLORS[m] + '10' }]}
                      >
                        <Text style={[styles.paymentBadgeText, { color: PAYMENT_COLORS[m] }]}>
                          {m.toUpperCase()}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>

                {/* Buy button */}
                <LinearGradient
                  colors={[MUGEN.blue, '#7c3aed']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.buyButton}
                >
                  <Text style={styles.buyButtonText}>Buy {order.token}</Text>
                  <Ionicons name="arrow-forward" size={16} color="white" />
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>
          ))}

          {/* Empty state */}
          {filteredOrders.length === 0 && !loading && (
            <View style={styles.emptyState}>
              <Ionicons name="wallet-outline" size={48} color={Colors.textTertiary} />
              <Text style={styles.emptyTitle}>No orders available</Text>
              <Text style={styles.emptyDesc}>
                No sellers available right now. Check back soon.
              </Text>
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  headerSubtitle: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: MUGEN.blue,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  priceBadge: {
    backgroundColor: MUGEN.blueDim,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: MUGEN.blue + '20',
    alignItems: 'center',
  },
  priceLabel: {
    fontSize: 9,
    fontFamily: FontFamily.mono,
    color: MUGEN.blue,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  priceValue: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginTop: 1,
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipActive: {
    backgroundColor: MUGEN.blueDim,
    borderColor: MUGEN.blue + '40',
  },
  filterChipText: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
  },
  filterChipTextActive: {
    color: MUGEN.blue,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    fontFamily: FontFamily.mono,
    color: Colors.textSecondary,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  infoCard: {
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: MUGEN.blue + '15',
  },
  infoGradient: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
  },
  infoTitle: {
    fontSize: 13,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginBottom: 4,
  },
  infoDesc: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  orderCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  orderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  tokenBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: 'rgba(59,130,246,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tokenBadgeText: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    letterSpacing: 0.5,
  },
  orderAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  orderPrice: {
    fontSize: 13,
    fontFamily: FontFamily.mono,
    color: MUGEN.cyan,
    marginTop: 2,
  },
  orderRate: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textSecondary,
  },
  orderTime: {
    fontSize: 10,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  orderBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  sellerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sellerAddress: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
  },
  repBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(34,197,94,0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  repText: {
    fontSize: 10,
    fontFamily: FontFamily.mono,
    color: MUGEN.success,
  },
  paymentMethods: {
    flexDirection: 'row',
    gap: 4,
  },
  paymentBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  paymentBadgeText: {
    fontSize: 8,
    fontFamily: FontFamily.mono,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  buyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
  },
  buyButtonText: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: 'white',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
  },
  emptyDesc: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    maxWidth: 280,
  },
});
