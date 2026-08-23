/**
 * CurrencyModal — pick the currency prices are shown in.
 *
 * 🚨 THIS FILE WAS THE LAST TAILWIND HOLDOUT IN THE GROUP. Every colour in it
 * was a utility class — `bg-p01-surface`, `text-white`, `text-p01-gray`,
 * `bg-p01-cyan/10` — which resolve in `tailwind.config.js`, a file nobody edits
 * when the design changes. So the 2026-08-23 token sweep moved the six screens
 * around this sheet and left the sheet itself on the old palette, still setting
 * its labels in pure white. It is `StyleSheet.create` on `Colors.*` now, like
 * the rest of the app.
 *
 * ⛔ THE SYMBOL DISC IS GONE. Every row carried a 40pt circle containing `$`,
 * `€`, `¥` — the same glyph that is already the first character of the row's
 * own label. It was decoration standing in for information.
 *
 * ⚠️ Selecting closes the sheet. There is no Apply step: the choice IS the
 * action, and a confirmation that adds no information is a tap tax.
 */

import React from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';
import { Currency, CURRENCY_SYMBOLS } from '../../stores/settingsStore';

interface CurrencyModalProps {
  visible: boolean;
  currentCurrency: Currency;
  onSelect: (currency: Currency) => void;
  onClose: () => void;
}

const CURRENCIES: { code: Currency; name: string }[] = [
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CHF', name: 'Swiss Franc' },
];

export const CurrencyModal: React.FC<CurrencyModalProps> = ({
  visible,
  currentCurrency,
  onSelect,
  onClose,
}) => {
  const handleSelect = (currency: Currency) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect(currency);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close currency picker"
        />

        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Currency</Text>
            <TouchableOpacity
              onPress={onClose}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} bounces={false}>
            {CURRENCIES.map((item, i) => {
              const isSelected = item.code === currentCurrency;
              return (
                <TouchableOpacity
                  key={item.code}
                  style={[styles.row, i > 0 && styles.rowRule]}
                  onPress={() => handleSelect(item.code)}
                  activeOpacity={0.7}
                  accessibilityRole="radio"
                  accessibilityLabel={`${item.code}, ${item.name}`}
                  accessibilityState={{ checked: isSelected }}
                >
                  <View style={styles.rowText}>
                    <Text style={[styles.code, isSelected && styles.codeSelected]}>
                      {item.code} {CURRENCY_SYMBOLS[item.code]}
                    </Text>
                    <Text style={styles.name}>{item.name}</Text>
                  </View>
                  {isSelected ? (
                    <Ionicons name="checkmark" size={20} color={Colors.primary} />
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    // Colors.background at 72%: the scrim is the ground with alpha, not a colour.
    backgroundColor: 'rgba(7, 7, 9, 0.72)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius['2xl'],
    borderTopRightRadius: BorderRadius['2xl'],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    paddingBottom: Spacing['4xl'],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  title: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  close: {
    width: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  list: {
    maxHeight: 380,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  rowRule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  code: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
  },
  codeSelected: {
    color: Colors.primary,
    fontFamily: FontFamily.medium,
  },
  name: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
});

export default CurrencyModal;
