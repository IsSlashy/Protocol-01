/**
 * WalletHeader — the mark, the network, and two utilities.
 *
 * ⛔ THE 01 RASTER IS GONE. Founder ruling 2026-08-23. This file loaded
 * `assets/images/01-miku.png` at 80×32 and set "PROTOCOL 01" beside it in
 * Inter-Bold with a letterspacing of 1 — three retired things at once: the
 * numeral mark, the all-caps body-face wordmark, and a raster that no theme
 * change can reach. It now composes `components/common/Wordmark`, which draws
 * the real mark (a serif S cut by a cyan diagonal) in the display face the rest
 * of the app has just started using.
 *
 * 🎯 THE DEVNET PILL IS CAUTION, NOT DECORATION. It used to be a hot-pink
 * `DEVNET` in caps — the loudest element in the header, saying the least. Amber
 * is the system's caution colour and this is exactly what caution is for: the
 * money on this screen is not real. Sentence case, because the house style that
 * shouted in monospace is being removed.
 *
 * ⚠️ Both icon controls are 44pt and named. They were 40pt discs; the disc is
 * gone for the same reason `common/Header` dropped it — an icon does not need a
 * button drawn around it to be found.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Wordmark } from '@/components/common/Wordmark';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { isDevnet } from '@/services/solana/connection';
import { useT } from '@/i18n';

interface WalletHeaderProps {
  onScan: () => void;
  onSettings: () => void;
}

export default function WalletHeader({ onScan, onSettings }: WalletHeaderProps) {
  const t = useT();

  return (
    <View style={styles.header}>
      <View style={styles.left}>
        <Wordmark size={26} showText />
        {isDevnet() ? (
          <View style={styles.devnetPill}>
            <Text style={styles.devnetText}>Devnet</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.right}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={onScan}
          accessibilityRole="button"
          accessibilityLabel={t('send.scanQR')}
        >
          <Ionicons name="scan-outline" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={onSettings}
          accessibilityRole="button"
          accessibilityLabel={t('settings.title')}
        >
          <Ionicons name="settings-outline" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    minHeight: 56,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  devnetPill: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
    backgroundColor: Colors.warningDim,
  },
  devnetText: {
    color: Colors.yellow,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.medium,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
