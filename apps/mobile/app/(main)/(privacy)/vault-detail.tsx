import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';

import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import {
  type VaultInfo,
  type CancelPreview,
  computeCancelPreview,
} from '@/services/subscriptionVault';
import { ALL_POOLS } from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import CancelConfirmModal, {
  type CancelPhase,
} from '@/components/privacy/CancelConfirmModal';

const SECURE_SECRET_PREFIX = 'p01_vault_secret_';

export default function VaultDetailScreen() {
  const router = useRouter();
  const { vaultAddress } = useLocalSearchParams<{ vaultAddress: string }>();
  const {
    vaults,
    refreshVault,
    pauseNormalAction,
    resumeNormalAction,
    cancelNormalAction,
    pausePrivateStarkAction,
    resumePrivateStarkAction,
    cancelPrivateStarkAction,
    isLoading,
    progress,
  } = useSubscriptionVaultStore();
  const { isReady: starkReady, generateProof: starkGenerate } = useStarkProver();

  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null);
  const [starkStatus, setStarkStatus] = useState<string | null>(null);

  // Cancel modal state ──────────────────────────────────────────────────────
  const [cancelVisible, setCancelVisible] = useState(false);
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>('preview');
  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [cancelProgress, setCancelProgress] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelTx, setCancelTx] = useState<string | null>(null);
  const [cancelPoolLabel, setCancelPoolLabel] = useState<string>('');

  const storedVault = vaults.find(v => v.vaultAddress === vaultAddress);
  const isPrivate = storedVault?.isPrivateMode ?? false;

  useEffect(() => {
    const load = async () => {
      if (vaultAddress) {
        const info = await refreshVault(vaultAddress);
        setVaultInfo(info);
      }
    };
    load();
  }, [vaultAddress, refreshVault]);

  // Load subscriber secret from SecureStore
  const loadSecret = useCallback(async (): Promise<bigint> => {
    if (!vaultAddress) throw new Error('No vault address');
    const secretStr = await SecureStore.getItemAsync(`${SECURE_SECRET_PREFIX}${vaultAddress}`);
    if (!secretStr) throw new Error('Subscriber secret not found. Was this vault created on this device?');
    return BigInt(secretStr);
  }, [vaultAddress]);

  const handlePause = async () => {
    if (!vaultAddress) return;
    try {
      if (isPrivate) {
        if (!starkReady) {
          p01Alert('Prover initializing', 'STARK prover not ready yet — try again in a moment.');
          return;
        }
        const secret = await loadSecret();
        setStarkStatus('Generating STARK ownership proof...');
        const starkResult = await starkGenerate(secret.toString());

        setStarkStatus('Submitting STARK pause...');
        await pausePrivateStarkAction(vaultAddress, {
          proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
          commitment: BigInt(starkResult.commitment),
          proofSize: starkResult.proofSize,
        });
      } else {
        await pauseNormalAction(vaultAddress);
      }
      p01Alert('Success', 'Subscription paused');
      const info = await refreshVault(vaultAddress);
      setVaultInfo(info);
      setStarkStatus(null);
    } catch (err) {
      setStarkStatus(null);
      p01Alert('Error', (err as Error).message);
    }
  };

  const handleResume = async () => {
    if (!vaultAddress) return;
    try {
      if (isPrivate) {
        if (!starkReady) {
          p01Alert('Prover initializing', 'STARK prover not ready yet — try again in a moment.');
          return;
        }
        const secret = await loadSecret();
        setStarkStatus('Generating STARK ownership proof...');
        const starkResult = await starkGenerate(secret.toString());

        setStarkStatus('Submitting STARK resume...');
        await resumePrivateStarkAction(vaultAddress, {
          proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
          commitment: BigInt(starkResult.commitment),
          proofSize: starkResult.proofSize,
        });
      } else {
        await resumeNormalAction(vaultAddress);
      }
      p01Alert('Success', 'Subscription resumed');
      const info = await refreshVault(vaultAddress);
      setVaultInfo(info);
      setStarkStatus(null);
    } catch (err) {
      setStarkStatus(null);
      p01Alert('Error', (err as Error).message);
    }
  };

  const openCancelModal = async () => {
    if (!vaultAddress || !vaultInfo) return;
    try {
      const connection = getConnection();
      const slot = await connection.getSlot('confirmed');
      const pool = ALL_POOLS.find(
        p => p.poolPDA.toBase58() === vaultInfo.sourcePool,
      );
      const denom = pool?.denominationAtomic ?? 0n;
      setCancelPreview(computeCancelPreview(vaultInfo, slot, denom));
      setCancelPoolLabel(pool ? `${pool.denomination} ${pool.token}` : '—');
      setCancelPhase('preview');
      setCancelProgress(null);
      setCancelError(null);
      setCancelTx(null);
      setCancelVisible(true);
    } catch (err) {
      p01Alert('Error', (err as Error).message);
    }
  };

  const confirmCancel = async () => {
    if (!vaultAddress || !vaultInfo) return;
    setCancelPhase('processing');
    setCancelProgress('Preparing…');

    try {
      let sig = '';
      if (isPrivate) {
        if (!starkReady) {
          throw new Error('STARK prover not ready yet — try again in a moment.');
        }
        const secret = await loadSecret();
        setCancelProgress('Generating STARK ownership proof…');
        const starkResult = await starkGenerate(secret.toString());

        setCancelProgress('Submitting cancel transaction…');
        sig = await cancelPrivateStarkAction(vaultAddress, secret, {
          proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
          commitment: BigInt(starkResult.commitment),
          proofSize: starkResult.proofSize,
        });
      } else {
        setCancelProgress('Submitting cancel transaction…');
        sig = await cancelNormalAction(vaultAddress, vaultInfo.retailer);
      }

      setCancelTx(sig);
      setCancelPhase('success');
    } catch (err) {
      setCancelError((err as Error).message);
      setCancelPhase('error');
    }
  };

  const closeCancelModal = () => {
    const wasSuccess = cancelPhase === 'success';
    setCancelVisible(false);
    // Slight delay so the modal fades out cleanly before we pop the screen.
    if (wasSuccess) {
      setTimeout(() => router.back(), 150);
    }
  };

  if (!vaultInfo) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Vault Detail</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={styles.loadingText}>Loading...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Vault Detail</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Mode badge */}
        {isPrivate && (
          <View style={styles.privateBadge}>
            <Ionicons name="hardware-chip" size={16} color="#8B5CF6" />
            <Text style={styles.privateBadgeText}>
              Private Mode {starkReady ? '— STARK Ready' : ''}
            </Text>
          </View>
        )}

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Status</Text>
          <Text style={styles.detailValue}>
            {!vaultInfo.isActive ? 'Cancelled' : vaultInfo.isPaused ? 'Paused' : 'Active'}
          </Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Retailer</Text>
          <Text style={styles.detailValue}>{vaultInfo.retailer}</Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Total Deposited</Text>
          <Text style={styles.detailValue}>
            {(Number(vaultInfo.totalDeposited) / 1e9).toFixed(3)} SOL
          </Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Rate</Text>
          <Text style={styles.detailValue}>
            {(Number(vaultInfo.rate) / 1e9).toFixed(3)} SOL per period
          </Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Claimed Periods</Text>
          <Text style={styles.detailValue}>{Number(vaultInfo.claimedPeriods)}</Text>
        </View>

        {/* STARK progress */}
        {starkStatus && (
          <View style={styles.starkProgress}>
            <ActivityIndicator size="small" color="#8B5CF6" />
            <Text style={styles.starkProgressText}>{starkStatus}</Text>
          </View>
        )}

        <View style={styles.actions}>
          {vaultInfo.isActive && !vaultInfo.isPaused && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: P01Colors.yellowDim }]}
              onPress={handlePause}
              disabled={isLoading}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={P01Colors.yellow} />
              ) : (
                <Text style={[styles.actionText, { color: P01Colors.yellow }]}>Pause</Text>
              )}
            </TouchableOpacity>
          )}

          {vaultInfo.isActive && vaultInfo.isPaused && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: P01Colors.cyanDim }]}
              onPress={handleResume}
              disabled={isLoading}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={P01Colors.cyan} />
              ) : (
                <Text style={[styles.actionText, { color: P01Colors.cyan }]}>Resume</Text>
              )}
            </TouchableOpacity>
          )}

          {vaultInfo.isActive && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.errorDim }]}
              onPress={openCancelModal}
              disabled={isLoading}
            >
              <Text style={[styles.actionText, { color: Colors.error }]}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Progress from store */}
        {isLoading && progress && (
          <View style={styles.starkProgress}>
            <ActivityIndicator size="small" color={P01Colors.cyan} />
            <Text style={[styles.starkProgressText, { color: P01Colors.cyan }]}>{progress}</Text>
          </View>
        )}
      </ScrollView>

      <CancelConfirmModal
        visible={cancelVisible}
        preview={cancelPreview}
        denominationLabel={cancelPoolLabel}
        retailerLabel={
          vaultInfo?.retailer
            ? `${vaultInfo.retailer.slice(0, 6)}…${vaultInfo.retailer.slice(-4)}`
            : 'Retailer'
        }
        phase={cancelPhase}
        progress={cancelProgress ?? progress ?? null}
        errorMessage={cancelError}
        txSignature={cancelTx}
        onConfirm={confirmCancel}
        onClose={closeCancelModal}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing['3xl'],
  },
  privateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(139, 92, 246, 0.08)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.2)',
  },
  privateBadgeText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: '#8B5CF6',
  },
  detailCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  detailLabel: {
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    color: Colors.textTertiary,
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  starkProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(139, 92, 246, 0.08)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.2)',
  },
  starkProgressText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: '#8B5CF6',
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  actionText: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
  },
});
