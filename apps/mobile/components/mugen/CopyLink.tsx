// ═══════════════════════════════════════════════════════════════════════════
// CopyLink — truncated monospace pubkey/sig.
// Tap: copies to clipboard + long-press opens in Solana Explorer (devnet).
// ═══════════════════════════════════════════════════════════════════════════

import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { GojoColors, Mono } from './SharedStyles';

export type CopyLinkType = 'tx' | 'address';

export interface CopyLinkProps {
  value: string;
  type: CopyLinkType;
  /** Override tint. Defaults to violet for address, blue for tx. */
  tint?: string;
  /** Optional label for a11y. */
  label?: string;
}

function shorten(value: string, type: CopyLinkType): string {
  if (type === 'tx') {
    return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
  }
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function explorerUrl(value: string, type: CopyLinkType): string {
  const base = type === 'tx' ? 'tx' : 'address';
  return `https://explorer.solana.com/${base}/${value}?cluster=devnet`;
}

export default function CopyLink({
  value,
  type,
  tint,
  label,
}: CopyLinkProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const effectiveTint = tint ?? (type === 'tx' ? GojoColors.blueLight : GojoColors.violetLight);
  const short = shorten(value, type);
  const a11y = label ?? (type === 'tx' ? 'transaction signature' : 'address');

  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(value);
      setCopied(true);
    } catch {
      // best-effort
    }
  }, [value]);

  const onOpenExplorer = useCallback(async () => {
    try {
      await Linking.openURL(explorerUrl(value, type));
    } catch {
      // ignore
    }
  }, [value, type]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy ${a11y}`}
        onPress={onCopy}
        onLongPress={onOpenExplorer}
        style={({ pressed }) => [
          styles.link,
          { borderColor: `${effectiveTint}30`, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.text, { color: effectiveTint }]} numberOfLines={1}>
          {short}
        </Text>
        <MaterialIcons
          name={copied ? 'check' : 'content-copy'}
          size={11}
          color={copied ? GojoColors.successLight : effectiveTint}
        />
      </Pressable>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${a11y} on Solana Explorer`}
        onPress={onOpenExplorer}
        hitSlop={6}
        style={({ pressed }) => [styles.explorerBtn, { opacity: pressed ? 0.6 : 1 }]}
      >
        <MaterialIcons name="open-in-new" size={11} color={effectiveTint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  text: {
    fontFamily: Mono,
    fontSize: 11,
  },
  explorerBtn: {
    padding: 2,
  },
});
