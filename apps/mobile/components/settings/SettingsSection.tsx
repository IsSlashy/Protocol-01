/**
 * SettingsSection — an eyebrow and a panel of rows separated by hairlines.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23, and put to work. This component
 * existed and NOTHING imported it: all six settings screens hand-rolled their
 * own `SectionTitle` + `GlassCard` + `GlassDivider` trio, six times, with the
 * fill written out as a hex literal in each one. That is why a theme sweep over
 * `constants/theme.ts` could not reach any of them — and why the settings
 * screens were the last part of the app still on the old greyscale.
 *
 * ⛔ THE EYEBROW IS NOT SHOUTED ANY MORE. Every section header in this group
 * was `title.toUpperCase()` with a letter-spaced bold, i.e. the house style the
 * brand is removing. It is sentence case now, quiet, in the body face. The
 * section is found by the gap above it, not by volume.
 *
 * ⚠️ THE HAIRLINES ARE INSERTED HERE, between children, rather than written by
 * the caller between every pair of rows. A divider is a property of the list,
 * not of the row, and every screen that drew its own got the last one wrong at
 * least once (a rule under the final row, against the panel edge).
 * `React.Children.toArray` drops `null`/`false`, so a conditional row does not
 * leave a stray rule behind it.
 */

import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

interface SettingsSectionProps {
  /** Sentence case. It is a label, not a banner. */
  title?: string;
  /** A quiet line under the panel, for a fact the rows cannot carry. */
  footer?: string;
  style?: ViewStyle;
  children: React.ReactNode;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  footer,
  style,
  children,
}) => {
  const rows = React.Children.toArray(children);

  return (
    <View style={[styles.wrap, style]}>
      {title ? <Text style={styles.eyebrow}>{title}</Text> : null}

      <View style={styles.panel}>
        {rows.map((row, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <View style={styles.hairline} /> : null}
            {row}
          </React.Fragment>
        ))}
      </View>

      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    marginTop: Spacing['2xl'],
    paddingHorizontal: Spacing.xl,
  },
  eyebrow: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    letterSpacing: 0.2,
    marginBottom: Spacing.sm,
  },
  panel: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.borderSoft,
    marginLeft: Spacing.lg,
  },
  footer: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.xs,
  },
});

export default SettingsSection;
