import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors, FontSize } from '@/constants/theme';
import type { CancelPreview } from '@/services/subscriptionVault';

export type CancelPhase = 'preview' | 'processing' | 'success' | 'error';

interface CancelConfirmModalProps {
  visible: boolean;
  preview: CancelPreview | null;
  /** Human-friendly denomination string, e.g. "0.1 SOL" */
  denominationLabel: string;
  /** Retailer display name */
  retailerLabel: string;
  phase: CancelPhase;
  /** Active status line while processing */
  progress: string | null;
  /** Error message for error phase */
  errorMessage: string | null;
  /** Tx signature after success */
  txSignature: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

function formatSol(lamports: bigint): string {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  if (sol === 0) return '0';
  if (sol < 0.0001) return sol.toExponential(2);
  return sol.toFixed(4).replace(/\.?0+$/, '');
}

export default function CancelConfirmModal({
  visible,
  preview,
  denominationLabel,
  retailerLabel,
  phase,
  progress,
  errorMessage,
  txSignature,
  onConfirm,
  onClose,
}: CancelConfirmModalProps) {
  const isBlocking = phase === 'processing';

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={() => {
        if (!isBlocking) onClose();
      }}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          {phase === 'preview' && preview && (
            <PreviewContent
              preview={preview}
              denominationLabel={denominationLabel}
              retailerLabel={retailerLabel}
              onConfirm={onConfirm}
              onClose={onClose}
            />
          )}
          {phase === 'processing' && (
            <ProcessingContent progress={progress} />
          )}
          {phase === 'success' && preview && (
            <SuccessContent
              preview={preview}
              txSignature={txSignature}
              onClose={onClose}
            />
          )}
          {phase === 'error' && (
            <ErrorContent errorMessage={errorMessage} onClose={onClose} />
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, accent ? { color: accent } : null]}>{value}</Text>
    </View>
  );
}

function PreviewContent({
  preview,
  denominationLabel,
  retailerLabel,
  onConfirm,
  onClose,
}: {
  preview: CancelPreview;
  denominationLabel: string;
  retailerLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const notesN = Number(preview.notesToReshield);
  const hasNotes = notesN > 0;
  const hasDust = preview.dustAmount > 0n;

  return (
    <>
      <View style={styles.iconWrap}>
        <Ionicons name="close-circle" size={48} color={Colors.error} />
      </View>

      <Text style={styles.title}>Cancel subscription</Text>
      <Text style={styles.subtitle}>
        Here&apos;s what you&apos;ll recover before the vault closes.
      </Text>

      <ScrollView
        style={styles.details}
        contentContainerStyle={{ paddingBottom: Spacing.sm }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={styles.sectionHead}>Going to retailer</Text>
          <Row label={retailerLabel} value={`${formatSol(preview.claimableAmount)} SOL`} />
          <Row
            label="Unclaimed periods"
            value={preview.claimablePeriods.toString()}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHead}>Coming back to you (private)</Text>
          <Row
            label={`${notesN}× ${denominationLabel} notes`}
            value={`${formatSol(preview.refundable - preview.dustAmount)} SOL`}
            accent={hasNotes ? P01Colors.cyan : undefined}
          />
          <Row
            label="Stealth dust (residual)"
            value={`${formatSol(preview.dustAmount)} SOL`}
            accent={hasDust ? P01Colors.pink : Colors.textTertiary}
          />
          <View style={styles.divider} />
          <Row
            label="Total recovered"
            value={`${formatSol(preview.refundable)} SOL`}
            accent={Colors.text}
          />
        </View>

        <Text style={styles.footnote}>
          Notes are re-shielded into the same pool. Dust is routed to a
          self-stealth address so no clear balance lands on your wallet.
        </Text>
      </ScrollView>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.btnGhost} onPress={onClose}>
          <Text style={styles.btnGhostText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnDanger} onPress={onConfirm}>
          <Text style={styles.btnDangerText}>Confirm cancel</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

function ProcessingContent({ progress }: { progress: string | null }) {
  return (
    <View style={styles.centerState}>
      <ActivityIndicator size="large" color={P01Colors.cyan} />
      <Text style={styles.title}>Cancelling…</Text>
      <Text style={styles.subtitle}>
        {progress ?? 'Submitting transaction…'}
      </Text>
      <Text style={styles.blockingNote}>
        Do not close the app until this completes.
      </Text>
    </View>
  );
}

function SuccessContent({
  preview,
  txSignature,
  onClose,
}: {
  preview: CancelPreview;
  txSignature: string | null;
  onClose: () => void;
}) {
  const notesN = Number(preview.notesToReshield);
  return (
    <>
      <View style={[styles.iconWrap, styles.iconWrapSuccess]}>
        <Ionicons name="checkmark-circle" size={48} color={P01Colors.cyan} />
      </View>

      <Text style={styles.title}>Cancelled</Text>
      <Text style={styles.subtitle}>
        Recovered {formatSol(preview.refundable)} SOL privately.
      </Text>

      <View style={styles.section}>
        <Row
          label={`${notesN} note${notesN === 1 ? '' : 's'} re-shielded`}
          value={`${formatSol(preview.refundable - preview.dustAmount)} SOL`}
          accent={P01Colors.cyan}
        />
        {preview.dustAmount > 0n && (
          <Row
            label="Dust → self-stealth"
            value={`${formatSol(preview.dustAmount)} SOL`}
            accent={P01Colors.pink}
          />
        )}
        {txSignature && (
          <Row
            label="Tx"
            value={`${txSignature.slice(0, 6)}…${txSignature.slice(-4)}`}
          />
        )}
      </View>

      <TouchableOpacity style={styles.btnPrimary} onPress={onClose}>
        <Text style={styles.btnPrimaryText}>Done</Text>
      </TouchableOpacity>
    </>
  );
}

function ErrorContent({
  errorMessage,
  onClose,
}: {
  errorMessage: string | null;
  onClose: () => void;
}) {
  return (
    <>
      <View style={[styles.iconWrap, styles.iconWrapError]}>
        <Ionicons name="alert-circle" size={48} color={Colors.error} />
      </View>
      <Text style={styles.title}>Cancel failed</Text>
      <Text style={styles.subtitle}>
        {errorMessage ?? 'Unknown error. No funds moved.'}
      </Text>
      <TouchableOpacity style={styles.btnPrimary} onPress={onClose}>
        <Text style={styles.btnPrimaryText}>Close</Text>
      </TouchableOpacity>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing['2xl'],
    borderWidth: 1,
    borderColor: Colors.border,
  },
  iconWrap: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.errorDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  iconWrapSuccess: {
    backgroundColor: P01Colors.cyanDim,
  },
  iconWrapError: {
    backgroundColor: Colors.errorDim,
  },
  title: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xl,
    color: Colors.text,
    textAlign: 'center',
    marginBottom: Spacing.xs,
  },
  subtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  blockingNote: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: Spacing.lg,
  },
  details: {
    maxHeight: 320,
  },
  section: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  sectionHead: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.xs,
  },
  rowLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    flexShrink: 1,
    marginRight: Spacing.sm,
  },
  rowValue: {
    fontFamily: FontFamily.monoMedium,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  footnote: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    lineHeight: 16,
    marginTop: Spacing.xs,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.md,
  },
  btnGhost: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  btnGhostText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  btnDanger: {
    flex: 1.4,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.error,
    alignItems: 'center',
  },
  btnDangerText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  btnPrimary: {
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyan,
    alignItems: 'center',
    marginTop: Spacing.md,
  },
  btnPrimaryText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.background,
  },
  centerState: {
    alignItems: 'center',
    paddingVertical: Spacing['2xl'],
  },
});
