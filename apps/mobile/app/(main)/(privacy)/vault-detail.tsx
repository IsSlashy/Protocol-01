/**
 * One subscription vault, in detail.
 *
 * 🎯 RESTYLED ON THE REALIGNED THEME 2026-08-23. What was here:
 *   - `#8B5CF6`, a violet, on the mode badge, the progress rows and the
 *     spinner. The design system has one accent and violet is not in it — the
 *     colour was hardcoded in six places, so the theme sweep could not touch it.
 *   - five bordered cards stacked one per fact, each one a panel around a
 *     label and a value. They are hairline rows now: a border per fact is a
 *     border between a thing and the same thing.
 *   - "Vault Detail" set in Inter-Bold, i.e. body text one weight louder.
 *
 * ⚠️ `STATUS_LABEL` still comes from `entitlementStatus`, never `isActive`.
 */

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
  type SubscriptionOutlook,
  computeSubscriptionOutlook,
  entitlementStatus,
} from '@/services/subscriptionVault';
import { getConnection } from '@/services/solana/connection';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { Badge } from '@/components/ui';
import {
  Colors,
  FontFamily,
  FontSize,
  BorderRadius,
  Spacing,
  Layout,
} from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

const SECURE_SECRET_PREFIX = 'p01_vault_secret_';

/**
 * Never label this row from `isActive`. The program writes it `true` at
 * subscribe and `false` NOWHERE, so a subscription that has spent every period
 * it paid for still reports `true` and this row used to read "Active".
 * "Ended" is that state. "Checking" is the state where the slot poll has not
 * landed, which must not be rendered as the optimistic answer either.
 */
const STATUS_LABEL: Record<ReturnType<typeof entitlementStatus>, string> = {
  inactive: 'Inactive',
  paused: 'Paused',
  unknown: 'Checking',
  current: 'Active',
  ended: 'Ended',
};

/** The same five states, in the four tones the design system has. */
const STATUS_TONE: Record<ReturnType<typeof entitlementStatus>, 'neutral' | 'good' | 'warn'> = {
  inactive: 'neutral',
  paused: 'warn',
  unknown: 'neutral',
  current: 'good',
  ended: 'neutral',
};

export default function VaultDetailScreen() {
  const router = useRouter();
  const t = useT();
  const { vaultAddress } = useLocalSearchParams<{ vaultAddress: string }>();
  const {
    vaults,
    refreshVault,
    pauseNormalAction,
    resumeNormalAction,
    pausePrivateStarkAction,
    resumePrivateStarkAction,
    isLoading,
    progress,
  } = useSubscriptionVaultStore();
  const { isReady: starkReady, generateProof: starkGenerate } = useStarkProver();

  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null);
  const [starkStatus, setStarkStatus] = useState<string | null>(null);
  // Needed for the Status row: without a slot the funded window cannot be
  // evaluated, and `isActive` alone reports every subscription as Active for
  // ever because the program never writes it false.
  const [currentSlot, setCurrentSlot] = useState<number | null>(null);

  // Where the money stands. NOT a refund quote — `outstandingToRetailer` is
  // what the RETAILER will still receive. A subscription is a one-way prepaid
  // envelope and nothing here can ever return to the subscriber.
  const [outlook, setOutlook] = useState<SubscriptionOutlook | null>(null);

  const storedVault = vaults.find(v => v.vaultAddress === vaultAddress);
  const isPrivate = storedVault?.isPrivateMode ?? false;

  useEffect(() => {
    const load = async () => {
      if (vaultAddress) {
        const info = await refreshVault(vaultAddress);
        setVaultInfo(info);
      }
      try {
        const slot = await getConnection().getSlot('confirmed');
        setCurrentSlot(slot);
      } catch {
        // Leave it null — the Status row says "Checking", never "Active".
      }
    };
    load();
  }, [vaultAddress, refreshVault]);

  // Recompute where the money stands whenever the vault or the slot moves.
  useEffect(() => {
    if (vaultInfo && currentSlot !== null) {
      setOutlook(computeSubscriptionOutlook(vaultInfo, currentSlot));
    } else {
      setOutlook(null);
    }
  }, [vaultInfo, currentSlot]);

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

  const header = (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={() => router.back()}
        style={styles.iconBtn}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={1}>Vault</Text>
      <View style={styles.headerSpacer} />
    </View>
  );

  if (!vaultInfo) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <Text style={styles.loadingText}>Loading…</Text>
      </SafeAreaView>
    );
  }

  const status = entitlementStatus(vaultInfo, currentSlot ?? 0);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* ── The headline: what it costs, and whether it is running ── */}
        <View style={styles.headline}>
          <Text style={styles.headlineLabel}>Rate</Text>
          <View style={styles.headlineRow}>
            <Text style={styles.headlineAmount}>
              {(Number(vaultInfo.rate) / 1e9).toFixed(3)}
            </Text>
            <Text style={styles.headlineUnit}>SOL per period</Text>
          </View>
          <View style={styles.headlineMeta}>
            <Badge variant={STATUS_TONE[status]} size="sm">{STATUS_LABEL[status]}</Badge>
            {isPrivate && (
              <Badge variant="neutral" size="sm">
                {starkReady ? 'Private · prover ready' : 'Private'}
              </Badge>
            )}
          </View>
        </View>

        {/* ── The facts, as rows. One rule between them, not five borders. ── */}
        <View style={styles.facts}>
          <Fact label="Retailer" value={vaultInfo.retailer} mono />
          <Fact
            label="Total deposited"
            value={`${(Number(vaultInfo.totalDeposited) / 1e9).toFixed(3)} SOL`}
            mono
          />
          <Fact label="Claimed periods" value={String(Number(vaultInfo.claimedPeriods))} mono />
        </View>

        {/* STARK progress */}
        {starkStatus && (
          <View style={styles.progressRow}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <Text style={styles.progressText}>{starkStatus}</Text>
          </View>
        )}

        {/* ── The one control a vault has ── */}
        <View style={styles.actions}>
          {vaultInfo.isActive && !vaultInfo.isPaused && (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={handlePause}
              disabled={isLoading}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Pause this subscription"
              accessibilityState={{ disabled: isLoading, busy: isLoading }}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={Colors.text} />
              ) : (
                <>
                  <Ionicons name="pause" size={18} color={Colors.text} />
                  <Text style={styles.actionText}>Pause</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {vaultInfo.isActive && vaultInfo.isPaused && (
            <TouchableOpacity
              style={[styles.actionBtn, styles.actionBtnPrimary]}
              onPress={handleResume}
              disabled={isLoading}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Resume this subscription"
              accessibilityState={{ disabled: isLoading, busy: isLoading }}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={Colors.background} />
              ) : (
                <>
                  <Ionicons name="play" size={18} color={Colors.background} />
                  <Text style={[styles.actionText, styles.actionTextPrimary]}>Resume</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/*
          The no-refund rule, in the space the Cancel button used to occupy.
          A subscription is a one-way prepaid envelope: money in this vault can
          only ever be paid out to the retailer, and the protocol has no
          instruction that could send any of it back.
        */}
        <View style={styles.noRefundCard}>
          <Ionicons name="information-circle-outline" size={16} color={Colors.textSecondary} />
          {/*
            Read through `t()` so the fr and ja copy the i18n parity test
            guarantees actually renders here. Hardcoding English made that
            guarantee vacuous on this screen.
          */}
          <Text style={styles.noRefundText}>
            {t('streams.noRefundNotice')}
            {outlook !== null
              ? ` ${(Number(outlook.outstandingToRetailer) / 1e9).toFixed(3)} SOL ${t('streams.stillOwedSuffix')}`
              : ''}
          </Text>
        </View>

        {/* Progress from store */}
        {isLoading && progress && (
          <View style={styles.progressRow}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <Text style={styles.progressText}>{progress}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text
        style={[styles.factValue, mono && styles.factValueMono]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Layout.screenPadding,
    paddingBottom: Layout.tabBarTotalHeight + Spacing['4xl'],
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  headerSpacer: { width: 44 },

  loadingText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing['4xl'],
  },

  // Headline
  headline: { paddingTop: Spacing['2xl'] },
  headlineLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  headlineAmount: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['4xl'],
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  headlineUnit: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  headlineMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },

  // Facts
  facts: { marginTop: Spacing['3xl'] },
  fact: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.lg,
    minHeight: 48,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  factLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  factValue: {
    flexShrink: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.text,
    textAlign: 'right',
  },
  factValueMono: { fontFamily: FontFamily.mono },

  // Progress
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginTop: Spacing.xl,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.primaryMuted,
  },
  progressText: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
  },

  // Actions
  actions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing['2xl'],
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 52,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  actionBtnPrimary: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  actionText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  actionTextPrimary: { color: Colors.background },

  // No-refund notice
  noRefundCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
  },
  noRefundText: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textSecondary,
  },
});
