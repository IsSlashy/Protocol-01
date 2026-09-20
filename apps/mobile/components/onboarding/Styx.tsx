/**
 * The onboarding vocabulary, in the site's voice.
 *
 * Until 2026-09-13 each onboarding screen set its own type: 'white' at weight
 * '900' with 6pt of tracking on the welcome, Inter-Bold titles everywhere, a
 * '#a0a0a0' grey that exists in no palette, icon bubbles with a teal glow, and
 * cyan buttons with white labels and an elevation halo. The theme had been
 * realigned on the web system three weeks earlier and these screens did not
 * read it, so the first five screens a person sees were the ones least like
 * the product they were opening.
 *
 * These are the site's own pieces restated for the phone (apps/web/app/_styx/
 * styx.css): a mono overline, a Newsreader statement at 300, a lede in the
 * muted paper, one hairline with the teal seal on its head, a PAPER button
 * (paper ground, ink label, no glow), a ghost link, and the amber devnet line
 * every surface carries. Every colour is a token; a screen built from these
 * cannot drift on its own.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Colors, FontFamily, Layout } from '../../constants/theme';
import { StyxRiver, type StyxRiverProps } from '../styx/StyxRiver';

/** The screen: ink, safe area, the site's side gutter, optionally the river. */
export const Screen: React.FC<{
  children: React.ReactNode;
  river?: StyxRiverProps | false;
  style?: ViewStyle;
}> = ({ children, river = false, style }) => (
  <View style={styles.root}>
    {river ? <StyxRiver {...river} /> : null}
    <SafeAreaView style={[styles.safe, style]} pointerEvents="box-none">
      {children}
    </SafeAreaView>
  </View>
);

/** Mono, uppercase, faint. The one place a screen names itself. */
export const Overline: React.FC<{ children: React.ReactNode; accent?: boolean }> = ({
  children,
  accent,
}) => (
  <Text style={[styles.overline, accent && { color: Colors.primary }]} allowFontScaling={false}>
    {children}
  </Text>
);

/** The statement. Newsreader 300, tight, never bold. */
export const Title: React.FC<{ children: React.ReactNode; size?: number; center?: boolean }> = ({
  children,
  size = 34,
  center,
}) => (
  <Text
    style={[
      styles.title,
      { fontSize: size, lineHeight: Math.round(size * 1.08) },
      center && { textAlign: 'center' },
    ]}
  >
    {children}
  </Text>
);

/** Body copy under a statement. */
export const Lede: React.FC<{ children: React.ReactNode; center?: boolean; size?: number }> = ({
  children,
  center,
  size = 16,
}) => (
  <Text style={[styles.lede, { fontSize: size, lineHeight: Math.round(size * 1.5) }, center && { textAlign: 'center' }]}>
    {children}
  </Text>
);

/** Evidence: an address, a count, a step. Mono. */
export const Mono: React.FC<{ children: React.ReactNode; color?: string; size?: number; center?: boolean }> = ({
  children,
  color = Colors.textSecondary,
  size = 13,
  center,
}) => (
  <Text style={[styles.mono, { color, fontSize: size }, center && { textAlign: 'center' }]}>{children}</Text>
);

/** A hairline, with the teal seal on its head when asked. */
export const Hairline: React.FC<{ seal?: boolean; style?: ViewStyle }> = ({ seal, style }) => (
  <View style={[styles.hairline, style]}>
    {seal ? <View style={styles.seal} /> : null}
  </View>
);

/** The paper button. Paper ground, ink label, no glow, no pill. */
export const PaperButton: React.FC<{
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}> = ({ label, onPress, disabled, accessibilityLabel }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: !!disabled }}
    style={({ pressed }) => [
      styles.paperButton,
      disabled && styles.paperButtonDisabled,
      pressed && !disabled && { opacity: 0.85 },
    ]}
  >
    <Text style={[styles.paperButtonLabel, disabled && { color: Colors.textTertiary }]}>{label}</Text>
  </Pressable>
);

/** A quiet text link. `accent` for the action word. */
export const GhostLink: React.FC<{
  children: React.ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
  center?: boolean;
}> = ({ children, onPress, accessibilityLabel, center = true }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="link"
    accessibilityLabel={accessibilityLabel}
    hitSlop={8}
    style={({ pressed }) => [styles.ghost, center && { alignItems: 'center' }, pressed && { opacity: 0.6 }]}
  >
    <Text style={styles.ghostText}>{children}</Text>
  </Pressable>
);

export const Accent: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text style={{ color: Colors.primary }}>{children}</Text>
);

/** The amber devnet line every surface carries. One sentence, never more. */
export const DevnetLine: React.FC<{ tag: string; children: React.ReactNode }> = ({ tag, children }) => (
  <Animated.View entering={FadeIn.delay(600).duration(600)} style={styles.devnet}>
    <Text style={styles.devnetTag}>{tag}</Text>
    <Text style={styles.devnetText}>{children}</Text>
  </Animated.View>
);

/** A panel: one step above the ink, one hairline around it. No radius theatre. */
export const Panel: React.FC<{ children: React.ReactNode; style?: ViewStyle; tone?: 'ink' | 'warn' | 'error' }> = ({
  children,
  style,
  tone = 'ink',
}) => (
  <View
    style={[
      styles.panel,
      tone === 'warn' && { backgroundColor: Colors.warningDim, borderColor: Colors.warning },
      tone === 'error' && { backgroundColor: Colors.errorDim, borderColor: Colors.error },
      style,
    ]}
  >
    {children}
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  safe: { flex: 1, paddingHorizontal: Layout.screenPadding + 4 },
  overline: {
    fontFamily: FontFamily.monoMedium,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: Colors.textTertiary,
  },
  title: {
    fontFamily: FontFamily.display,
    color: Colors.text,
    letterSpacing: -0.6,
  },
  lede: {
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  mono: {
    fontFamily: FontFamily.mono,
    letterSpacing: 0.2,
  },
  hairline: {
    height: 1,
    backgroundColor: Colors.border,
    position: 'relative',
  },
  seal: {
    position: 'absolute',
    left: 0,
    top: -1,
    width: 32,
    height: 3,
    backgroundColor: Colors.primary,
  },
  /* .styx-btn: paper ground, ink label, mono uppercase at 0.12em, radius 0. */
  paperButton: {
    minHeight: 52,
    backgroundColor: Colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
    paddingHorizontal: 20,
  },
  paperButtonDisabled: {
    backgroundColor: Colors.border,
  },
  paperButtonLabel: {
    fontFamily: FontFamily.monoMedium,
    fontSize: 13,
    color: Colors.background,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  ghost: { minHeight: 44, justifyContent: 'center' },
  ghostText: {
    fontFamily: FontFamily.regular,
    fontSize: 15,
    color: Colors.textSecondary,
  },
  devnet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: Colors.borderSoft,
  },
  devnetTag: {
    fontFamily: FontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: Colors.warning,
  },
  devnetText: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.textTertiary,
  },
  panel: {
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 0,
    padding: 18,
  },
});
