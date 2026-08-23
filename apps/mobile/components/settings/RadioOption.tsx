/**
 * RadioOption — one choice out of a set.
 *
 * 🚨 THE ACCENT IN HERE WAS THE WRONG CYAN. The local `COLORS` map hardcoded
 * `#06b6d4`, which is Tailwind's cyan-500, not the brand's `#39c5bb`. The two
 * are close enough that nobody caught it and far enough apart that the selected
 * radio never matched the switch three rows above it. That is the whole case
 * for reading `constants/theme.ts` instead of retyping a colour.
 *
 * ⚠️ `accessibilityRole="radio"` with `checked` state, not `selected`: a radio
 * announces as checked, and the group it belongs to reads as a set rather than
 * as four unrelated buttons.
 */

import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';

import { Colors, Spacing, FontFamily, FontSize } from '@/constants/theme';

interface RadioOptionProps {
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export const RadioOption: React.FC<RadioOptionProps> = ({
  label,
  description,
  selected,
  onSelect,
  disabled = false,
}) => {
  return (
    <TouchableOpacity
      style={[styles.row, disabled && styles.disabled]}
      onPress={disabled ? undefined : onSelect}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: selected, disabled }}
    >
      <View style={styles.text}>
        <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>

      <View style={[styles.ring, selected && styles.ringSelected]}>
        {selected ? <View style={styles.dot} /> : null}
      </View>
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
  labelSelected: {
    fontFamily: FontFamily.medium,
  },
  description: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 18,
    marginTop: 2,
  },
  ring: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringSelected: {
    borderColor: Colors.primary,
  },
  dot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: Colors.primary,
  },
});

export default RadioOption;
