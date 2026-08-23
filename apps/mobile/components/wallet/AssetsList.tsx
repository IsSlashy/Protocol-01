/**
 * AssetsList — what you hold, one row each.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23.
 *   - the section title sat behind a 4pt cyan dot and beside a count chip. Two
 *     pieces of chrome for a heading that already had a word. The accent is the
 *     only loud colour the system has; spending it on a dot spends it on
 *     nothing.
 *   - the rows lived inside a `BlurView` over `rgba(12,12,14,0.6)` with a
 *     cyan-tinted ring. Flat panel, one hairline — the same shape `ui/Card`
 *     and the extension's `Panel` draw.
 *   - the heading is the display face, not body-bold.
 *
 * ⚠️ A FIAT VALUE IS ONLY EVER SHOWN WHEN ONE WAS LOOKED UP. `usd` is optional
 * and a row with no price simply shows the balance. The price feed returns 0 on
 * failure (services/solana/balance.ts:117), so rendering whatever arrives would
 * quietly print "$0.00" beside real money.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
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
  /** Already formatted, and already known to be real. Omit when no price was fetched. */
  formattedUsd?: string;
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
        {usd ? <Text style={styles.assetUsd}>{usd}</Text> : null}
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
    {
      key: 'sol',
      name: 'Solana',
      symbol: 'SOL',
      balance: solBalance,
      usd: formattedUsd,
      mint: '',
      logoUri: undefined,
    },
    ...tokens.map((tok) => ({
      key: tok.mint,
      name: tok.name,
      symbol: tok.symbol,
      balance: String(tok.uiBalance),
      usd: tok.usdValue ? formatAmount(tok.usdValue) : undefined,
      mint: tok.mint,
      logoUri: tok.logoUri,
    })),
  ];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {t('wallet.assets')}
      </Text>

      <View style={styles.panel}>
        {allAssets.map((asset, i) => (
          <AssetRow
            key={asset.key}
            icon={<TokenIcon symbol={asset.symbol} logoURI={asset.logoUri} size={36} />}
            name={asset.name}
            symbol={asset.symbol}
            balance={balanceHidden ? '••••' : asset.balance}
            usd={balanceHidden ? undefined : asset.usd}
            isLast={i === allAssets.length - 1}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: Spacing['2xl'] },
  sectionTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
    marginBottom: Spacing.md,
  },
  panel: {
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg,
  },
  assetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    minHeight: 60,
  },
  assetRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  assetInfo: { flex: 1, marginLeft: Spacing.md },
  assetName: { color: Colors.text, fontSize: FontSize.md, fontFamily: FontFamily.medium },
  assetSymbol: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  assetRight: { alignItems: 'flex-end' },
  assetBalance: { color: Colors.text, fontSize: FontSize.md, fontFamily: FontFamily.mono },
  assetUsd: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
});
