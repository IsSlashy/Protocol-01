import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { Colors, FontFamily, Spacing, P01Colors } from '@/constants/theme';
import TokenIcon from '@/components/TokenIcon';
import { useT } from '@/i18n';

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

function AssetRow({
  icon,
  name,
  symbol,
  balance,
  usd,
  isLast,
}: {
  icon: React.ReactNode;
  name: string;
  symbol: string;
  balance: string;
  usd?: string;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.assetRow, !isLast && styles.assetRowBorder]}>
      {icon}
      <View style={styles.assetInfo}>
        <Text style={styles.assetName}>{name}</Text>
        <Text style={styles.assetSymbol}>{symbol}</Text>
      </View>
      <View style={styles.assetRight}>
        <Text style={styles.assetBalance}>{balance}</Text>
        {usd && <Text style={styles.assetUsd}>{usd}</Text>}
      </View>
    </View>
  );
}

export default function AssetsList({
  solBalance,
  formattedUsd,
  tokens,
  balanceHidden,
  formatAmount,
}: AssetsListProps) {
  const t = useT();
  const allAssets = [
    { key: 'sol', name: 'Solana', symbol: 'SOL', balance: solBalance, usd: formattedUsd, mint: '', logoUri: undefined },
    ...tokens.map(t => ({ key: t.mint, name: t.name, symbol: t.symbol, balance: String(t.uiBalance), usd: t.usdValue ? formatAmount(t.usdValue) : undefined, mint: t.mint, logoUri: t.logoUri })),
  ];

  return (
    <Animated.View entering={FadeInUp.delay(400)} style={styles.section}>
      {/* Section header */}
      <View style={styles.sectionHeader}>
        <View style={styles.headerDot} />
        <Text style={styles.sectionTitle}>{t('wallet.assets')}</Text>
        <Text style={styles.countBadge}>{allAssets.length}</Text>
      </View>

      {/* Glass container */}
      <View style={styles.glassOuter}>
        <BlurView intensity={12} tint="dark" style={styles.glassInner}>
          {allAssets.map((asset, i) => (
            <AssetRow
              key={asset.key}
              icon={<TokenIcon symbol={asset.symbol} logoURI={asset.logoUri} size={40} />}
              name={asset.name}
              symbol={asset.symbol}
              balance={balanceHidden ? '----' : asset.balance}
              usd={balanceHidden ? '----' : asset.usd}
              isLast={i === allAssets.length - 1}
            />
          ))}
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
    marginBottom: 12,
    gap: 8,
  },
  headerDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: P01Colors.cyan,
  },
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    flex: 1,
  },
  countBadge: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.medium,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
  },
  glassOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.06)',
  },
  glassInner: {
    backgroundColor: 'rgba(12, 12, 14, 0.6)',
    paddingHorizontal: 16,
  },
  assetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  assetRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  assetInfo: { flex: 1, marginLeft: 14 },
  assetName: { color: Colors.text, fontSize: 15, fontFamily: FontFamily.semibold },
  assetSymbol: { color: Colors.textTertiary, fontSize: 12, fontFamily: FontFamily.regular, marginTop: 2 },
  assetRight: { alignItems: 'flex-end' },
  assetBalance: { color: Colors.text, fontSize: 15, fontFamily: FontFamily.semibold },
  assetUsd: { color: Colors.textTertiary, fontSize: 12, fontFamily: FontFamily.regular, marginTop: 2 },
});
