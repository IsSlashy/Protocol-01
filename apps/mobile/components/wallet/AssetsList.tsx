import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import TokenIcon from '@/components/TokenIcon';

interface Token {
  mint: string;
  symbol: string;
  name: string;
  logoUri?: string;
  uiBalance: string | number;
  usdValue?: number;
}

interface AssetsListProps {
  solBalance: string;
  formattedUsd: string;
  tokens: Token[];
  balanceHidden: boolean;
  formatAmount: (val: number) => string;
}

export default function AssetsList({
  solBalance,
  formattedUsd,
  tokens,
  balanceHidden,
  formatAmount,
}: AssetsListProps) {
  return (
    <Animated.View entering={FadeInUp.delay(400)} style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>ASSETS</Text>
      </View>

      {/* SOL */}
      <View style={styles.assetRow}>
        <View style={styles.assetLeft}>
          <TokenIcon symbol="SOL" size={44} />
          <View style={styles.assetInfo}>
            <Text style={styles.assetName}>Solana</Text>
            <Text style={styles.assetSymbol}>SOL</Text>
          </View>
        </View>
        <View style={styles.assetRight}>
          <Text style={styles.assetBalance}>{balanceHidden ? '----' : solBalance}</Text>
          <Text style={styles.assetUsd}>{balanceHidden ? '----' : formattedUsd}</Text>
        </View>
      </View>

      {/* Owned tokens */}
      {tokens.map((token) => (
        <View key={token.mint} style={styles.assetRow}>
          <View style={styles.assetLeft}>
            <TokenIcon symbol={token.symbol} logoURI={token.logoUri} size={44} />
            <View style={styles.assetInfo}>
              <Text style={styles.assetName}>{token.name}</Text>
              <Text style={styles.assetSymbol}>{token.symbol}</Text>
            </View>
          </View>
          <View style={styles.assetRight}>
            <Text style={styles.assetBalance}>{balanceHidden ? '----' : token.uiBalance}</Text>
            {token.usdValue ? (
              <Text style={styles.assetUsd}>{balanceHidden ? '----' : formatAmount(token.usdValue)}</Text>
            ) : null}
          </View>
        </View>
      ))}
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
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
  },
  assetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surfaceSecondary,
    padding: 16,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  assetLeft: { flexDirection: 'row', alignItems: 'center' },
  assetInfo: { marginLeft: Spacing.md },
  assetName: { color: Colors.text, fontSize: 15, fontFamily: FontFamily.semibold },
  assetSymbol: { color: Colors.textSecondary, fontSize: 13, fontFamily: FontFamily.regular, marginTop: 2 },
  assetRight: { alignItems: 'flex-end' },
  assetBalance: { color: Colors.text, fontSize: 15, fontFamily: FontFamily.semibold },
  assetUsd: { color: Colors.textSecondary, fontSize: 13, fontFamily: FontFamily.regular, marginTop: 2 },
});
