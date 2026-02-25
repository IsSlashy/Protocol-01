import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface StealthPayment {
  stealthAddress: string;
  amount: number;
  signature: string;
}

interface StealthRecoveryModalProps {
  visible: boolean;
  isScanning: boolean;
  isSweeping: boolean;
  foundPayments: StealthPayment[];
  onScan: () => void;
  onSweep: () => void;
  onClose: () => void;
}

export default function StealthRecoveryModal({
  visible,
  isScanning,
  isSweeping,
  foundPayments,
  onScan,
  onSweep,
  onClose,
}: StealthRecoveryModalProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={[styles.iconWrap, { backgroundColor: P01Colors.greenDim }]}>
              <Ionicons name="scan" size={28} color={P01Colors.green} />
            </View>
            <View>
              <Text style={styles.title}>Recover Private Funds</Text>
              <Text style={styles.subtitle}>Scan for stealth payments</Text>
            </View>
          </View>

          {/* Scanning */}
          {isScanning && (
            <View style={styles.scanStatus}>
              <ActivityIndicator color={P01Colors.green} size="small" />
              <Text style={styles.scanStatusText}>Scanning for payments...</Text>
            </View>
          )}

          {/* Found Payments */}
          {!isScanning && foundPayments.length > 0 && (
            <View style={styles.payments}>
              <Text style={styles.paymentsTitle}>
                Found {foundPayments.length} payment(s)
              </Text>
              {foundPayments.map((payment, index) => (
                <View key={index} style={styles.paymentItem}>
                  <Ionicons name="checkmark-circle" size={20} color={P01Colors.green} />
                  <View style={styles.paymentInfo}>
                    <Text style={styles.paymentAmount}>{payment.amount} SOL</Text>
                    <Text style={styles.paymentAddress}>
                      {payment.stealthAddress.slice(0, 16)}...{payment.stealthAddress.slice(-8)}
                    </Text>
                  </View>
                </View>
              ))}
              <Text style={styles.paymentsHint}>
                These funds are on stealth addresses. Sweep to transfer to your wallet.
              </Text>
            </View>
          )}

          {/* Empty */}
          {!isScanning && foundPayments.length === 0 && (
            <View style={styles.empty}>
              <Ionicons name="search-outline" size={48} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>No stealth payments found</Text>
              <Text style={styles.emptyHint}>
                When someone sends you a private transfer, it will appear here.
              </Text>
            </View>
          )}

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
              <Text style={styles.cancelText}>Close</Text>
            </TouchableOpacity>
            {foundPayments.length > 0 ? (
              <TouchableOpacity
                style={[styles.confirmButton, { backgroundColor: P01Colors.green }]}
                onPress={onSweep}
                disabled={isSweeping}
              >
                {isSweeping ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.confirmText}>
                    Sweep {foundPayments.reduce((sum, p) => sum + p.amount, 0).toFixed(4)} SOL
                  </Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.confirmButton, { backgroundColor: P01Colors.green }]}
                onPress={onScan}
                disabled={isScanning}
              >
                {isScanning ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.confirmText}>Scan Again</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
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
    padding: Spacing.lg,
    paddingBottom: Spacing.lg + 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
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
  },
  scanStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: P01Colors.greenDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  scanStatusText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: P01Colors.green,
  },
  payments: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  paymentsTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: P01Colors.green,
    marginBottom: Spacing.sm,
  },
  paymentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  paymentInfo: {
    flex: 1,
  },
  paymentAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  paymentAddress: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
  },
  paymentsHint: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
    lineHeight: 16,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
  },
  emptyText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
  },
  emptyHint: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: Spacing.xs,
    textAlign: 'center',
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  confirmButton: {
    flex: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  confirmText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
});
