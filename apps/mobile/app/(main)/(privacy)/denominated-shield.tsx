import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  FadeIn,
  FadeInDown,
  SlideInDown,
  SlideOutDown,
} from 'react-native-reanimated';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useWalletStore } from '@/stores/walletStore';
import { useAuth } from '@/providers/PrivyProvider';
import {
  type PoolConfig,
  SOL_POOLS,
  USDC_POOLS,
  SOL_POOLS_V3,
  USDC_POOLS_V3,
  parseFilledSubtrees,
  computeNewRootFromSubtreesV3,
  createCommitmentV3,
  goldilocksToLeBytes32,
  deriveNoteMaterial,
  deriveSeedFromSigner,
  slotToEpoch,
  pubkeyToField,
} from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { getKeypair } from '@/services/solana/wallet';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { Buffer } from 'buffer';
import { withKeepAwake } from '@/utils/keepAwakeDuring';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

type TokenTab = 'SOL' | 'USDC';

// ─── Main Screen ──────────────────────────────────────────────────
export default function DenominatedShieldScreen() {
  const router = useRouter();
  const [tokenTab, setTokenTab] = useState<TokenTab>('SOL');
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [selectedPool, setSelectedPool] = useState<PoolConfig | null>(null);
  const [resultModal, setResultModal] = useState<{
    visible: boolean;
    type: 'success' | 'error';
    title: string;
    message: string;
  }>({ visible: false, type: 'success', title: '', message: '' });

  const {
    isLoading,
    error,
    progress,
    poolCache,
    shieldNote,
    shieldNoteV3,
    refreshPoolInfo,
  } = useDenominatedPoolStore();

  // V3 pools listed AFTER v2 in the same UI grid so the migration is visible
  // V3 is the only shield path going forward. v2 pools STAY ACTIVE on the
  // unshield/transfer side so users can drain their existing v2 notes during
  // the 30-day deprecation window — the per-note routing uses
  // note.poolVersion to pick the correct path. New shields are V3 only.
  const pools = tokenTab === 'SOL' ? SOL_POOLS_V3 : USDC_POOLS_V3;
  const { publicKey: storePublicKey, initializeWithPrivy } = useWalletStore();
  const { walletAddress: privyWalletAddress } = useAuth();
  const walletPublicKey = privyWalletAddress || storePublicKey;
  const { isReady: starkReady, generateMerkleUpdateProof } = useStarkProver();

  useEffect(() => {
    if (privyWalletAddress && !storePublicKey) {
      initializeWithPrivy(privyWalletAddress);
    }
  }, [privyWalletAddress, storePublicKey]);

  const fetchBalance = useCallback(async () => {
    setLoadingBalance(true);
    try {
      if (walletPublicKey) {
        const connection = getConnection();
        const bal = await connection.getBalance(new PublicKey(walletPublicKey));
        setWalletBalance(bal);
      }
    } catch (err) {
      console.error('[DenomShield] Failed to fetch balance:', err);
    }
    setLoadingBalance(false);
  }, [walletPublicKey]);

  useEffect(() => {
    fetchBalance();
    refreshPoolInfo();
  }, [fetchBalance]);

  const balanceSol = walletBalance / LAMPORTS_PER_SOL;

  const handleSelectPool = useCallback((pool: PoolConfig) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedPool(pool);
  }, []);

  const handleConfirmShield = useCallback(async () => {
    if (!selectedPool) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Refresh balance right before check
    let currentBalance = walletBalance;
    try {
      if (walletPublicKey) {
        const connection = getConnection();
        currentBalance = await connection.getBalance(new PublicKey(walletPublicKey));
        setWalletBalance(currentBalance);
      }
    } catch {}

    const needed = Number(selectedPool.denominationAtomic);
    if (selectedPool.token === 'SOL' && currentBalance < needed + 50_000) {
      setSelectedPool(null);
      setResultModal({
        visible: true,
        type: 'error',
        title: 'Insufficient Balance',
        message: `You need ${selectedPool.denomination} SOL + fees.\nCurrent: ${(currentBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
      });
      return;
    }

    try {
      if (selectedPool.version === 'v3') {
        // V3 path: generate C6 (merkle_update) proof first, then call shieldNoteV3.
        // The shield-from-stealth pattern (used by v2 in the store) is skipped
        // here because V3 already adds two STARK txs to the wallet→pool path —
        // adding stealth on top would 2× the user's wait. TODO(v3-stealth-shield).
        if (!starkReady) {
          throw new Error('STARK prover not ready yet — try again in a moment.');
        }
        await withKeepAwake('p01-shield-v3', async () => {
          const connection = getConnection();

          // 1. Read pool tree state (V3 layout matches v2 byte-for-byte).
          const treeAcct = await connection.getAccountInfo(selectedPool.treePDA);
          if (!treeAcct) throw new Error('V3 merkle tree not initialized');
          const { leafCount, subtrees } = parseFilledSubtrees(treeAcct.data);

          // 2. Derive deterministic note material from wallet seed.
          // Use the same `deterministic` mechanic as v2 so V3 notes are
          // recoverable from seed via rescanPool.
          const localKp = await getKeypair().catch(() => null);
          let walletSeed: Uint8Array | null = null;
          if (localKp) {
            walletSeed = localKp.secretKey.slice(0, 32);
          } else {
            // Privy: ask for a one-per-session signature
            const { isPrivyWallet } = useWalletStore.getState();
            if (isPrivyWallet) {
              const { getPrivySigner, getPrivyMessageSigner } = await import('@/stores/walletStore');
              const signer = getPrivySigner();
              const messageSigner = getPrivyMessageSigner();
              if (signer && messageSigner && walletPublicKey) {
                const walletSigner = {
                  publicKey: new PublicKey(walletPublicKey),
                  signTransaction: signer,
                  signMessage: messageSigner,
                };
                walletSeed = await deriveSeedFromSigner(walletSigner);
              }
            }
          }
          if (!walletSeed) throw new Error('No wallet seed available — cannot derive V3 note');

          // V3 uses a fresh counter namespace from v2 (different commitment hash function),
          // so reusing the v2 shieldCounters key is safe — the derived nullifier PDAs differ.
          const counter = 0; // TODO(v3-counter): track per-pool counter for V3 the same way v2 does.
          const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, selectedPool.poolPDA, counter);

          const slot = await connection.getSlot('confirmed');
          const depositEpoch = slotToEpoch(slot);
          const tokenMintField = pubkeyToField(selectedPool.tokenMint);

          // 3. Compute commitment + new merkle state via Goldilocks helpers.
          const commitment = createCommitmentV3(nullifierPreimage, secret, depositEpoch, tokenMintField);
          const { newRoot, updatedSubtrees, pathElements: _pathElements, pathIndices: _pathIndices } =
            computeNewRootFromSubtreesV3(commitment, leafCount, subtrees);

          // 4. Generate C6 (merkle_update) STARK proof.
          // C6 public inputs (per stark/src/air/merkle_update.rs):
          //   [old_leaf=0, new_leaf=commitment_u64, old_root_u64, new_root_u64, depth_u64]
          // The prover takes the path that the new commitment will travel in
          // the v3 tree; we already have it from computeNewRootFromSubtreesV3.
          //
          // generateMerkleUpdateProof signature:
          //   (oldLeaf: string, newLeaf: string, pathElements: string[], pathIndices: number[])
          const oldLeafGl = '0';
          const newLeafGl = (commitment & ((1n << 64n) - 1n)).toString();
          const pathElementsGl = _pathElements.map(e => (e & ((1n << 64n) - 1n)).toString());
          const c6Result = await generateMerkleUpdateProof(
            oldLeafGl,
            newLeafGl,
            pathElementsGl,
            _pathIndices,
          );

          const c6ProofBytes = Buffer.from(c6Result.proofHex, 'hex');
          const c6PublicInputs = c6Result.publicInputs.map((s: string) => BigInt(s));

          // 5. Hand off to the store action which orchestrates submit+verify
          //    of the C6 buffer and the shield_denominated_v3 ix.
          await shieldNoteV3(
            selectedPool,
            {
              commitment,
              newRoot,
              // On-chain `insert_with_root_v3` requires exactly `tree_depth`
              // (=15) entries representing levels 1..=depth. computeNewRootFromSubtreesV3
              // returns depth+1 entries (levels 0..=depth) where index 0 is the
              // leaf itself — drop it.
              newSubtrees: updatedSubtrees.slice(1),
              secret,
              nullifierPreimage,
              depositEpoch,
              leafIndex: leafCount,
            },
            { proofBytes: c6ProofBytes, publicInputs: c6PublicInputs, proofSize: c6Result.proofSize },
          );
        });
      } else {
        await withKeepAwake('p01-shield', () => shieldNote(selectedPool));
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const pool = selectedPool;
      setSelectedPool(null);
      setResultModal({
        visible: true,
        type: 'success',
        title: 'Deposited!',
        message: `${pool.denomination} ${pool.token}${pool.version === 'v3' ? ' (V3)' : ''} is now in your private wallet.\nIt will be ready to use in ~1 hour.`,
      });
      fetchBalance();
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSelectedPool(null);
      setResultModal({
        visible: true,
        type: 'error',
        title: 'Deposit Failed',
        message: err.message || 'An unknown error occurred.',
      });
    }
  }, [selectedPool, walletBalance, walletPublicKey, shieldNote, shieldNoteV3, fetchBalance, starkReady, generateMerkleUpdateProof]);

  const getPoolNoteCount = (pool: PoolConfig): number => {
    const cached = poolCache[pool.poolPDA.toBase58()];
    return cached?.info.noteCount ?? 0;
  };

  return (
    <SafeAreaView style={st.container} edges={['top']}>
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>Deposit</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={st.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Balance */}
        <Animated.View entering={FadeIn.duration(300)}>
          <View style={st.balanceCard}>
            <Text style={st.balanceLabel}>Available</Text>
            <View style={st.balanceRow}>
              <Text style={st.balanceValue}>
                {loadingBalance ? '...' : balanceSol.toFixed(4)}
              </Text>
              <Text style={st.balanceSuffix}>SOL</Text>
            </View>
          </View>
        </Animated.View>

        {/* Token toggle */}
        <Animated.View entering={FadeInDown.delay(50).duration(250)}>
          <View style={st.tokenRow}>
            {(['SOL', 'USDC'] as TokenTab[]).map(tab => (
              <TouchableOpacity
                key={tab}
                style={[st.tokenBtn, tokenTab === tab && st.tokenBtnActive]}
                onPress={() => { Haptics.selectionAsync(); setTokenTab(tab); }}
              >
                <Text style={[st.tokenText, tokenTab === tab && st.tokenTextActive]}>
                  {tab}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>

        {/* Amount chips */}
        <Animated.View entering={FadeInDown.delay(100).duration(300)}>
          <Text style={st.sectionLabel}>Choose amount</Text>
          <View style={st.chipsGrid}>
            {pools.map((pool, i) => {
              const noteCount = getPoolNoteCount(pool);
              const canAfford = pool.token === 'SOL' ? balanceSol >= pool.denomination : true;
              const privacyLevel = noteCount === 0 ? 0 : noteCount < 10 ? 1 : noteCount < 100 ? 2 : 3;
              const privacyDots = ['', '\u25CF', '\u25CF\u25CF', '\u25CF\u25CF\u25CF'][privacyLevel];
              const privacyColor = [Colors.textTertiary, P01Colors.yellow, P01Colors.cyan, P01Colors.green][privacyLevel];

              return (
                <TouchableOpacity
                  key={pool.poolPDA.toBase58()}
                  style={[
                    st.chip,
                    !canAfford && st.chipDimmed,
                  ]}
                  onPress={() => handleSelectPool(pool)}
                  disabled={isLoading || !canAfford}
                  activeOpacity={0.7}
                >
                  <Text style={[st.chipAmount, !canAfford && st.chipAmountDim]}>
                    {pool.denomination}
                  </Text>
                  <Text style={st.chipToken}>{pool.token}</Text>
                  {pool.version === 'v3' && (
                    <View style={st.v3Badge}>
                      <Text style={st.v3BadgeText}>V3</Text>
                    </View>
                  )}
                  {noteCount > 0 && (
                    <Text style={[st.chipPrivacy, { color: privacyColor }]}>
                      {privacyDots}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={st.privacyLegend}>
            <Text style={st.legendText}>Privacy level: </Text>
            <Text style={[st.legendDot, { color: P01Colors.yellow }]}>{'\u25CF'} Low  </Text>
            <Text style={[st.legendDot, { color: P01Colors.cyan }]}>{'\u25CF\u25CF'} Med  </Text>
            <Text style={[st.legendDot, { color: P01Colors.green }]}>{'\u25CF\u25CF\u25CF'} High</Text>
          </View>
        </Animated.View>

        {/* Hint */}
        <View style={st.hint}>
          <Ionicons name="information-circle-outline" size={14} color={Colors.textTertiary} />
          <Text style={st.hintText}>
            Deposits with the same amount are indistinguishable from each other.
            More deposits = stronger privacy.
          </Text>
        </View>

        {error && !isLoading && (
          <View style={st.errorCard}>
            <Ionicons name="warning" size={16} color={Colors.error} />
            <Text style={st.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      {/* ─── Confirm Sheet ──────────────────────────────── */}
      {selectedPool && (
        <Modal
          visible
          transparent
          animationType="none"
          onRequestClose={() => { if (!isLoading) setSelectedPool(null); }}
          statusBarTranslucent
        >
          <View style={cs.overlay}>
            <TouchableOpacity
              style={cs.backdrop}
              activeOpacity={1}
              onPress={isLoading ? undefined : () => setSelectedPool(null)}
            />
            <Animated.View
              entering={SlideInDown.duration(200)}
              exiting={SlideOutDown.duration(150)}
              style={cs.sheet}
            >
              <View style={cs.dragRow}>
                <View style={cs.dragHandle} />
              </View>

              {/* Amount */}
              <View style={cs.amountRow}>
                <Text style={cs.amountValue}>{selectedPool.denomination}</Text>
                <Text style={cs.amountToken}>{selectedPool.token}</Text>
              </View>

              {/* Details */}
              <View style={cs.details}>
                <View style={cs.detailRow}>
                  <Text style={cs.detailLabel}>Your balance</Text>
                  <Text style={cs.detailValue}>{balanceSol.toFixed(4)} SOL</Text>
                </View>
                <View style={cs.detailRow}>
                  <Text style={cs.detailLabel}>Ready in</Text>
                  <Text style={cs.detailValue}>~1 hour</Text>
                </View>
                <View style={cs.detailRow}>
                  <Text style={cs.detailLabel}>Pool size</Text>
                  <Text style={cs.detailValue}>
                    {getPoolNoteCount(selectedPool)} deposits
                  </Text>
                </View>
              </View>

              {/* Processing */}
              {isLoading && (
                <Animated.View entering={FadeIn.duration(200)} style={cs.processingCard}>
                  <ActivityIndicator size="small" color={P01Colors.cyan} />
                  <Text style={cs.processingText}>{progress || 'Processing...'}</Text>
                </Animated.View>
              )}

              {/* Buttons */}
              <View style={cs.actions}>
                <TouchableOpacity
                  style={cs.cancelBtn}
                  onPress={() => setSelectedPool(null)}
                  disabled={isLoading}
                >
                  <Text style={cs.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[cs.confirmBtn, isLoading && { opacity: 0.5 }]}
                  onPress={handleConfirmShield}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <ActivityIndicator size="small" color="#000" />
                  ) : (
                    <Text style={cs.confirmText}>
                      Deposit {selectedPool.denomination} {selectedPool.token}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>

              <Text style={cs.finePrint}>
                Your deposit is stored locally on this device.
              </Text>
            </Animated.View>
          </View>
        </Modal>
      )}

      {/* ─── Result Modal ───────────────────────────────── */}
      {resultModal.visible && (
        <Modal visible transparent animationType="fade" statusBarTranslucent>
          <View style={rm.overlay}>
            <TouchableOpacity
              style={rm.backdrop}
              activeOpacity={1}
              onPress={() => setResultModal(m => ({ ...m, visible: false }))}
            />
            <View style={rm.card}>
              <View style={[rm.iconWrap, {
                backgroundColor: resultModal.type === 'success' ? P01Colors.cyanDim : Colors.errorDim,
              }]}>
                <Ionicons
                  name={resultModal.type === 'success' ? 'checkmark-circle' : 'alert-circle'}
                  size={40}
                  color={resultModal.type === 'success' ? P01Colors.cyan : Colors.error}
                />
              </View>
              <Text style={rm.title}>{resultModal.title}</Text>
              <Text style={rm.message}>{resultModal.message}</Text>
              <View style={rm.actions}>
                {resultModal.type === 'success' && (
                  <TouchableOpacity
                    style={rm.primaryBtn}
                    onPress={() => {
                      setResultModal(m => ({ ...m, visible: false }));
                      router.push('/(main)/(privacy)/denominated-notes' as any);
                    }}
                  >
                    <Text style={rm.primaryText}>View Notes</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={rm.secondaryBtn}
                  onPress={() => setResultModal(m => ({ ...m, visible: false }))}
                >
                  <Text style={rm.secondaryText}>
                    {resultModal.type === 'success' ? 'Done' : 'OK'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

// ─── Main Styles ──────────────────────────────────────────────────
const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary, justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 20, fontFamily: FontFamily.bold },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },

  // Balance
  balanceCard: {
    backgroundColor: '#0f0f12', borderRadius: 20, padding: 20, marginBottom: Spacing.lg,
  },
  balanceLabel: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginBottom: 4 },
  balanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  balanceValue: { fontSize: 32, fontFamily: FontFamily.bold, color: Colors.text },
  balanceSuffix: { fontSize: 16, fontFamily: FontFamily.medium, color: Colors.textSecondary },

  // Token toggle
  tokenRow: { flexDirection: 'row', gap: 8, marginBottom: Spacing.lg },
  tokenBtn: {
    paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20,
    backgroundColor: Colors.surfaceSecondary,
  },
  tokenBtnActive: { backgroundColor: P01Colors.cyanDim },
  tokenText: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.textSecondary },
  tokenTextActive: { color: P01Colors.cyan },

  // Chips
  sectionLabel: {
    fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.text, marginBottom: 12,
  },
  chipsGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12,
  },
  chip: {
    width: '30%' as any,
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 18,
    borderRadius: 16,
    backgroundColor: '#0f0f12',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.15)',
  },
  chipDimmed: { opacity: 0.35, borderColor: Colors.border },
  chipAmount: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  chipAmountDim: { color: Colors.textSecondary },
  chipToken: { fontSize: 12, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginTop: 2 },
  chipPrivacy: { fontSize: 8, marginTop: 4, letterSpacing: 2 },
  v3Badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(0, 224, 255, 0.18)',
  },
  v3BadgeText: {
    fontSize: 8,
    fontFamily: FontFamily.bold,
    color: P01Colors.cyan,
    letterSpacing: 0.5,
  },

  // Legend
  privacyLegend: {
    flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg,
  },
  legendText: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  legendDot: { fontSize: 11, fontFamily: FontFamily.medium },

  // Hint
  hint: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    padding: 12, backgroundColor: '#0f0f12', borderRadius: 12, marginBottom: Spacing.lg,
  },
  hintText: { flex: 1, fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary, lineHeight: 17 },

  // Error
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.errorDim, borderRadius: 12, padding: 12,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },
});

// ─── Confirm Sheet Styles ─────────────────────────────────────────
const cs = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: Spacing.xl, paddingBottom: 40,
  },
  dragRow: { alignItems: 'center', paddingTop: 10, paddingBottom: 16 },
  dragHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border },
  amountRow: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center',
    gap: 8, marginBottom: 20,
  },
  amountValue: { fontSize: 48, fontFamily: FontFamily.bold, color: Colors.text },
  amountToken: { fontSize: 20, fontFamily: FontFamily.medium, color: Colors.textSecondary },
  details: {
    backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 14, padding: 14, marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8,
  },
  detailLabel: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  detailValue: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.text },
  processingCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: P01Colors.cyanDim, borderRadius: 12, padding: 12, marginBottom: 12,
  },
  processingText: { fontSize: 13, fontFamily: FontFamily.medium, color: P01Colors.cyan },
  actions: { flexDirection: 'row', gap: 10 },
  cancelBtn: {
    flex: 0.35, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  cancelText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
  confirmBtn: {
    flex: 0.65, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    backgroundColor: P01Colors.cyan,
  },
  confirmText: { fontSize: 15, fontFamily: FontFamily.bold, color: '#000' },
  finePrint: {
    fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary,
    textAlign: 'center', marginTop: 12,
  },
});

// ─── Result Modal Styles ──────────────────────────────────────────
const rm = StyleSheet.create({
  overlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.75)',
  },
  backdrop: { ...StyleSheet.absoluteFillObject },
  card: {
    width: '85%', maxWidth: 360, backgroundColor: Colors.surface,
    borderRadius: 20, overflow: 'hidden', alignItems: 'center', padding: 24,
  },
  iconWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  title: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text, marginBottom: 8 },
  message: {
    fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 20, marginBottom: 20,
  },
  actions: { width: '100%', gap: 10 },
  primaryBtn: {
    paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    backgroundColor: P01Colors.cyan,
  },
  primaryText: { fontSize: 15, fontFamily: FontFamily.bold, color: '#000' },
  secondaryBtn: {
    paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  secondaryText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
});
