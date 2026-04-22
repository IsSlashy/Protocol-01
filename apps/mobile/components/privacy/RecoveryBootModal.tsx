import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors, FontSize } from '@/constants/theme';
import { useWalletStore } from '@/stores/walletStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';

/**
 * Blocking boot-time recovery dialog.
 *
 * On first foreground after a wallet becomes active, checks whether we've
 * already run on-chain rescan for this pubkey. If not, fires `rescanPool()`
 * for every denominated pool, shows a blocking progress modal, then records
 * the recovery so the next cold boot skips it.
 *
 * Triggered automatically — no user action required. Shown as a blocking
 * modal with lazy loading so the user always knows what's being recovered.
 */

const RECOVERY_FLAG_PREFIX = 'p01_auto_recovery_v1_';
const RECOVERY_STALE_HOURS = 24 * 7; // rerun if >7 days since last success

type Phase = 'idle' | 'checking' | 'scanning' | 'success' | 'error';

/**
 * Sum human-readable `denomination` values across notes.
 * Notes are single-token per pool (SOL or USDC) — for display we lump them
 * together since the user typically holds one at a time on devnet. If USDC
 * support expands we can split per-token.
 */
function sumNoteDenominations(notes: Array<{ denomination: number }>): number {
  return notes.reduce((sum, n) => sum + (n.denomination ?? 0), 0);
}

function formatDenom(value: number): string {
  if (value === 0) return '0';
  return value.toFixed(4).replace(/\.?0+$/, '');
}

export default function RecoveryBootModal() {
  const pubkey = useWalletStore(s => s.publicKey);
  const rescanPool = useDenominatedPoolStore(s => s.rescanPool);
  const progress = useDenominatedPoolStore(s => s.progress);
  const notes = useDenominatedPoolStore(s => s.notes);

  const [phase, setPhase] = useState<Phase>('idle');
  const [recoveredCount, setRecoveredCount] = useState(0);
  const [recoveredAmount, setRecoveredAmount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const started = useRef(false);

  // Auto-trigger once a wallet pubkey is available and we haven't run for it yet.
  useEffect(() => {
    if (!pubkey || started.current) return;
    started.current = true;

    (async () => {
      try {
        setPhase('checking');
        const flagKey = `${RECOVERY_FLAG_PREFIX}${pubkey}`;
        const raw = await AsyncStorage.getItem(flagKey);
        const lastRun = raw ? parseInt(raw, 10) : 0;
        const ageHours = (Date.now() - lastRun) / 3_600_000;
        if (lastRun > 0 && ageHours < RECOVERY_STALE_HOURS) {
          setPhase('idle');
          return;
        }

        setPhase('scanning');
        const notesBefore = useDenominatedPoolStore.getState().notes.length;
        const amountBefore = sumNoteDenominations(
          useDenominatedPoolStore.getState().notes,
        );

        const recovered = await rescanPool(undefined, {
          maxCounter: 256,
          epochsBack: 50,
          maxSignatures: 1000,
        });

        const notesAfter = useDenominatedPoolStore.getState().notes.length;
        const amountAfter = sumNoteDenominations(
          useDenominatedPoolStore.getState().notes,
        );

        setRecoveredCount(Math.max(recovered, notesAfter - notesBefore));
        setRecoveredAmount(Math.max(0, amountAfter - amountBefore));

        await AsyncStorage.setItem(flagKey, Date.now().toString());
        setPhase('success');
      } catch (err) {
        console.warn('[RecoveryBootModal] scan failed:', err);
        setErrorMessage((err as Error).message ?? 'Unknown error');
        setPhase('error');
      }
    })();
  }, [pubkey, rescanPool]);

  // Don't render anything when idle — modal is transparent.
  const visible = phase === 'scanning' || phase === 'success' || phase === 'error';
  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {phase === 'scanning' && (
            <ScanningBody progress={progress} />
          )}
          {phase === 'success' && (
            <SuccessBody
              count={recoveredCount}
              amount={recoveredAmount}
              totalHeld={notes.length}
              onClose={() => setPhase('idle')}
            />
          )}
          {phase === 'error' && (
            <ErrorBody
              message={errorMessage}
              onDismiss={() => setPhase('idle')}
              onRetry={async () => {
                started.current = false;
                setErrorMessage(null);
                setPhase('idle');
              }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ScanningBody({ progress }: { progress: string | null }) {
  return (
    <>
      <View style={styles.iconWrap}>
        <ActivityIndicator size="large" color={P01Colors.cyan} />
      </View>
      <Text style={styles.title}>Recovering your notes</Text>
      <Text style={styles.subtitle}>
        {progress ?? 'Scanning the pools for anything your seed owns…'}
      </Text>
      <View style={styles.stepsBlock}>
        <Step label="Deriving wallet seed" done />
        <Step label="Fetching on-chain commitments" active={progress?.toLowerCase().includes('scanning') ?? false} />
        <Step label="Reconstructing matching notes" active={progress?.toLowerCase().includes('commitment') ?? false} />
      </View>
      <Text style={styles.footnote}>
        This runs once per week so a reset or reinstall never leaves notes
        behind. It&apos;s safe to wait — nothing is signed.
      </Text>
    </>
  );
}

function SuccessBody({
  count,
  amount,
  totalHeld,
  onClose,
}: {
  count: number;
  amount: number;
  totalHeld: number;
  onClose: () => void;
}) {
  const nothing = count === 0;
  return (
    <>
      <View style={[styles.iconWrap, styles.iconSuccess]}>
        <Ionicons
          name={nothing ? 'checkmark-circle' : 'shield-checkmark'}
          size={40}
          color={P01Colors.cyan}
        />
      </View>
      <Text style={styles.title}>
        {nothing ? 'All good' : `Recovered ${count} note${count === 1 ? '' : 's'}`}
      </Text>
      <Text style={styles.subtitle}>
        {nothing
          ? 'No missing notes found. Your state matches the chain.'
          : `Added ${formatDenom(amount)} back to your shielded balance.`}
      </Text>

      <View style={styles.section}>
        <Row label="Notes recovered" value={count.toString()} accent={nothing ? undefined : P01Colors.cyan} />
        <Row label="Value recovered" value={formatDenom(amount)} />
        <Row label="Total notes held" value={totalHeld.toString()} />
      </View>

      <TouchableOpacity style={styles.btnPrimary} onPress={onClose}>
        <Text style={styles.btnPrimaryText}>Continue</Text>
      </TouchableOpacity>
    </>
  );
}

function ErrorBody({
  message,
  onDismiss,
  onRetry,
}: {
  message: string | null;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <View style={[styles.iconWrap, styles.iconError]}>
        <Ionicons name="alert-circle" size={40} color={Colors.error} />
      </View>
      <Text style={styles.title}>Recovery failed</Text>
      <Text style={styles.subtitle}>
        {message ?? 'Something went wrong. Your existing notes are unchanged.'}
      </Text>
      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.btnGhost} onPress={onDismiss}>
          <Text style={styles.btnGhostText}>Skip for now</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnPrimary} onPress={onRetry}>
          <Text style={styles.btnPrimaryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, accent ? { color: accent } : null]}>{value}</Text>
    </View>
  );
}

function Step({
  label,
  done,
  active,
}: {
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  const color = done ? P01Colors.cyan : active ? Colors.text : Colors.textTertiary;
  const icon: keyof typeof Ionicons.glyphMap = done
    ? 'checkmark-circle'
    : active
      ? 'ellipse'
      : 'ellipse-outline';
  return (
    <View style={styles.stepRow}>
      <Ionicons name={icon} size={14} color={color} />
      <Text style={[styles.stepText, { color }]}>{label}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
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
    borderColor: P01Colors.cyanDim,
  },
  iconWrap: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  iconSuccess: {
    backgroundColor: P01Colors.cyanDim,
  },
  iconError: {
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
    lineHeight: 20,
  },
  stepsBlock: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.xs,
    gap: Spacing.sm,
  },
  stepText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
  },
  section: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
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
  footnote: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    textAlign: 'center',
    lineHeight: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.md,
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
  btnPrimary: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyan,
    alignItems: 'center',
    marginTop: Spacing.xs,
  },
  btnPrimaryText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.background,
  },
});
