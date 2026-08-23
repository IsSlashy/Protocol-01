/**
 * ToggleRow — a switch with its reason next to it.
 *
 * 🎯 RETONED 2026-08-23. Same shape as `SettingsRow` so the two stack without a
 * seam; the palette comes from `constants/theme.ts` instead of a local copy.
 *
 * ⚠️ THE WHOLE ROW IS THE TARGET, not just the 51pt switch at the right edge.
 * A settings list where the only hit area is the control is the classic reason
 * a toggle takes three tries with a thumb.
 *
 * The label is the switch's accessible name, so a screen reader says
 * "Block screenshots, off" rather than "switch, off" eleven times in a row.
 */

import React from 'react';
import { Text, StyleSheet, Switch, TouchableOpacity, View } from 'react-native';

import { Colors, Spacing, FontFamily, FontSize } from '@/constants/theme';

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

export const ToggleRow: React.FC<ToggleRowProps> = ({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}) => {
  return (
    <TouchableOpacity
      style={[styles.row, disabled && styles.disabled]}
      onPress={disabled ? undefined : () => onValueChange(!value)}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled }}
    >
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>

      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        // The switch is decorative to a screen reader: the row above already
        // carries the name, the state and the action.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        trackColor={{ false: Colors.border, true: Colors.primaryDim }}
        thumbColor={value ? Colors.primary : Colors.textTertiary}
        ios_backgroundColor={Colors.border}
      />
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    minHeight: 52,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  disabled: {
    opacity: 0.4,
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
  description: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 18,
    marginTop: 2,
  },
});

export default ToggleRow;
