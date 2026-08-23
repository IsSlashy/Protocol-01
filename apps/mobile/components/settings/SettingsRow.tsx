/**
 * SettingsRow — a label, an optional value, and a way in.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23, in `StyleSheet.create` rather
 * than inline objects. The old file carried its own `COLORS` map at the top —
 * a fourth copy of the palette, in a component whose whole job is to look the
 * same everywhere.
 *
 * The rules baked in here, the same four the extension's `Row` states:
 *   - the target is at least 44pt tall, so a row is never a near-miss
 *   - a row with no `onPress` is not a button and does not announce itself as
 *     one; it renders as plain content with no chevron
 *   - the chevron is drawn only where there is somewhere to go
 *   - `danger` recolours the label and the icon, and nothing else. A
 *     destructive row should be findable, not the loudest thing on the screen.
 *
 * ⚠️ `description` is new and optional. Six rows in this group were passing the
 * same string as both label and description, or duplicating the label in a
 * sublabel, because there was nowhere else to put a second line.
 */

import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

interface SettingsRowProps {
  label: string;
  /** A second line under the label. Sentence case, one line of reason. */
  description?: string;
  /** Right-aligned state: the current value of whatever the row leads to. */
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  /** Replaces the chevron. For a row that acts in place rather than navigates. */
  rightIcon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  danger?: boolean;
  accessibilityLabel?: string;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  label,
  description,
  value,
  onPress,
  showChevron = true,
  leftIcon,
  rightIcon,
  disabled = false,
  danger = false,
  accessibilityLabel,
}) => {
  const tint = danger ? Colors.error : Colors.primary;

  const body = (
    <>
      {leftIcon ? (
        <View style={styles.icon}>
          <Ionicons name={leftIcon} size={17} color={tint} />
        </View>
      ) : null}

      <View style={styles.text}>
        <Text style={[styles.label, danger && styles.labelDanger]} numberOfLines={1}>
          {label}
        </Text>
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>

      {value ? (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}

      {rightIcon ? (
        <Ionicons name={rightIcon} size={18} color={Colors.textTertiary} />
      ) : showChevron && onPress ? (
        <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
      ) : null}
    </>
  );

  // A row that does not lead anywhere is content, not a control. Announcing it
  // as a button is how a screen reader user ends up tapping at nothing.
  if (!onPress) {
    return <View style={[styles.row, disabled && styles.disabled]}>{body}</View>;
  }

  return (
    <TouchableOpacity
      style={[styles.row, disabled && styles.disabled]}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (value ? `${label}, ${value}` : label)}
      accessibilityState={{ disabled }}
    >
      {body}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 52,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  disabled: {
    opacity: 0.4,
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
  },
  labelDanger: {
    color: Colors.error,
  },
  description: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 18,
    marginTop: 2,
  },
  value: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    maxWidth: '45%',
  },
});

export default SettingsRow;
