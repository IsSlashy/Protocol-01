import React from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface AmountInputModalProps {
  visible: boolean;
  action: string;       // 'Shield' | 'Unshield' | 'Deposit' | 'Withdraw' | 'Transfer'
  subtitle: string;
  iconName: keyof typeof Ionicons.glyphMap;
  accentColor: string;
  dimColor: string;
  amount: string;
  onChangeAmount: (val: string) => void;
  maxAmount: number;
  maxLabel?: string;    // e.g. "4.2000 SOL"
  tokenSymbol?: string; // e.g. "SOL" | "USDC"
  isProcessing: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** Optional extra content between header and amount input (e.g. recipient address) */
  children?: React.ReactNode;
}

const PRESETS = [
  { label: '25%', factor: 0.25 },
  { label: '50%', factor: 0.5 },
  { label: '75%', factor: 0.75 },
  { label: 'MAX', factor: 1 },
] as const;

/**
 * Attempt to darken a hex color by a fixed amount for gradient end-stop.
 * Falls back to the same color if parsing fails.
 */
function darkenHex(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const r = Math.max(0, parseInt(clean.substring(0, 2), 16) - amount);
  const g = Math.max(0, parseInt(clean.substring(2, 4), 16) - amount);
  const b = Math.max(0, parseInt(clean.substring(4, 6), 16) - amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export default function AmountInputModal({
  visible,
  action,
  subtitle,
  iconName,
  accentColor,
  dimColor,
  amount,
  onChangeAmount,
  maxAmount,
  maxLabel,
  tokenSymbol,
  isProcessing,
  onConfirm,
  onClose,
  children,
}: AmountInputModalProps) {
  const isConfirmDisabled = isProcessing || !amount || parseFloat(amount) <= 0;
  const gradientEnd = darkenHex(accentColor, 40);

  const handlePreset = (factor: number) => {
    if (maxAmount <= 0) return;
    const val = factor === 1
      ? maxAmount.toString()
      : (maxAmount * factor).toFixed(4).replace(/\.?0+$/, '');
    onChangeAmount(val);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={[styles.content, { borderTopColor: `${accentColor}33` }]}>
          {/* Drag handle */}
          <View style={styles.dragHandleRow}>
            <View style={styles.dragHandle} />
          </View>

          {/* Header */}
          <View style={styles.header}>
            <View style={[styles.iconWrap, { backgroundColor: dimColor }]}>
              <Ionicons name={iconName} size={28} color={accentColor} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>{action} {tokenSymbol || 'SOL'}</Text>
              <Text style={styles.subtitle}>{subtitle}</Text>
            </View>
          </View>

          {/* Extra content slot (e.g. recipient address for transfer) */}
          {children}

          {/* Amount input section */}
          <View style={styles.inputSection}>
            <View style={styles.inputLabelRow}>
              <Text style={styles.inputLabel}>Amount</Text>
              <TouchableOpacity
                onPress={() => onChangeAmount(maxAmount > 0 ? maxAmount.toString() : '0')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.maxButton, { color: accentColor }]}>
                  {maxLabel || `${maxAmount.toFixed(4)} ${tokenSymbol || 'SOL'}`}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={amount}
                onChangeText={onChangeAmount}
                placeholder="0.00"
                placeholderTextColor={Colors.textTertiary}
                keyboardType="decimal-pad"
                selectionColor={accentColor}
              />
              <Text style={styles.inputSuffix}>{tokenSymbol || 'SOL'}</Text>
            </View>
            <View style={[styles.inputUnderline, { backgroundColor: `${accentColor}40` }]} />

            {/* Quick amount presets */}
            <View style={styles.presetRow}>
              {PRESETS.map((p) => (
                <TouchableOpacity
                  key={p.label}
                  style={[styles.presetChip, { backgroundColor: dimColor }]}
                  onPress={() => handlePreset(p.factor)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.presetLabel, { color: accentColor }]}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Action buttons */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.cancelButton, { borderColor: `${accentColor}4D` }]}
              onPress={onClose}
              disabled={isProcessing}
              activeOpacity={0.7}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onConfirm}
              disabled={isConfirmDisabled}
              activeOpacity={0.8}
              style={[styles.confirmTouchable, isConfirmDisabled && styles.confirmDisabled]}
            >
              <LinearGradient
                colors={[accentColor, gradientEnd] as [string, string]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.confirmGradient}
              >
                {isProcessing ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <Text style={styles.confirmText}>{action}</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  content: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    borderTopWidth: 1,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg + 40,
  },

  /* Drag handle */
  dragHandleRow: {
    alignItems: 'center',
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
  },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  headerText: {
    flex: 1,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },

  /* Input section */
  inputSection: {
    marginBottom: Spacing.lg,
  },
  inputLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  inputLabel: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  maxButton: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: 32,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
    padding: 0,
  },
  inputSuffix: {
    fontSize: 18,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
    marginLeft: 6,
  },
  inputUnderline: {
    height: 1,
    borderRadius: 0.5,
    marginBottom: Spacing.md,
  },

  /* Preset chips */
  presetRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  presetChip: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  presetLabel: {
    fontSize: 13,
    fontFamily: FontFamily.semibold,
  },

  /* Actions */
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  cancelButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  confirmTouchable: {
    flex: 1,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  confirmGradient: {
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.md,
  },
  confirmDisabled: {
    opacity: 0.5,
  },
  confirmText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
});
