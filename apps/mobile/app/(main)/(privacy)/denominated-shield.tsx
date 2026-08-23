/**
 * Deposit — turn transparent SOL into one shielded note.
 *
 * 🎯 WHAT THIS SCREEN LOST, 2026-08-23
 * ────────────────────────────────────
 * It was a picker, then a bottom sheet that repeated the picker's numbers back
 * at you, then a full-screen success card with a Done button. Three surfaces,
 * two of which added no information the previous one had not already shown.
 *
 * The sheet is gone. Choosing a denomination shows what will happen and who
 * signs it, and there is ONE button. The success card is gone too: on success
 * the screen goes back to Shield, where the new note is sitting in the list
 * with its countdown running. That IS the receipt, and it is the place the user
 * was going anyway.
 *
 * ⚠️ THE DENOMINATION USUALLY ARRIVES ALREADY CHOSEN. The Shield tab carries
 * the picker inline now and passes `denomination` as a route param; this screen
 * preselects it. The grid stays because a deep link, or a holder of an older
 * note, can land here without one.
 *
 * ⛔ ONLY THE 1 SOL POOL TAKES NEW DEPOSITS (founder, 2026-08-21). Every other
 * pool is SHOWN and REFUSED WITH THE REASON rather than hidden — a denomination
 * that silently vanishes reads as a bug to someone who holds a note in it.
 *
 * 🚨 THE ONE THING THAT MAY NOT BE COLLAPSED AWAY is who signs the deposit, and
 * it is NOT the same for both tokens: on SOL a one-time key signs and the
 * wallet funds it with a public transfer; on USDC the wallet itself is the
 * depositor (`useEphemeralDepositor` is `pool.token === 'SOL' && localKp`,
 * stores/denominatedPoolStore.ts:1176). Both lines are keyed off the token, in
 * two places, and `app/privacy-claims.test.ts` fails if either one is dropped
 * or merged into a single reassuring sentence.
 *
 * ⚠️ NO LOGIC WAS TOUCHED. `handleConfirmShield` — the balance pre-check, the
 * filled_subtrees layout chooser, the C6 proof, the public-input invariant and
 * the two store calls — is the same code with the same arguments.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import { useDenominatedPoolStore, findSafeShieldCounter } from '@/stores/denominatedPoolStore';
import { useWalletStore } from '@/stores/walletStore';
import {
  type PoolConfig,
  SOL_POOLS,
  USDC_POOLS,
  SOL_POOLS_V3,
  USDC_POOLS_V3,
  parseFilledSubtrees,
  computeNewRootFromSubtreesV3,
  ZERO_VALUE_V3,
  MERKLE_DEPTH,
  createCommitmentV3,
  goldilocksToLeBytes32,
  deriveNoteMaterial,
  slotToEpoch,
  pubkeyToField,
} from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { getKeypair } from '@/services/solana/wallet';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { Buffer } from 'buffer';
import { withKeepAwake } from '@/utils/keepAwakeDuring';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';

type TokenTab = 'SOL' | 'USDC';

/** ⛔ The only pool open to new deposits. See the header note. */
const OPEN_TOKEN: TokenTab = 'SOL';
const OPEN_DENOMINATION = 1;

const isOpenPool = (pool: PoolConfig) =>
  pool.token === OPEN_TOKEN && pool.denomination === OPEN_DENOMINATION;

// ─── Main Screen ──────────────────────────────────────────────────
export default function DenominatedShieldScreen() {
  const router = useRouter();
  const t = useT();
  const params = useLocalSearchParams<{ denomination?: string }>();
  const [tokenTab, setTokenTab] = useState<TokenTab>('SOL');
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [selectedPool, setSelectedPool] = useState<PoolConfig | null>(null);
  // Synchronous re-tap guard. The store's isLoading flips ~500ms-2s after
  // press (we await getBalance RPC first), leaving a window where double-tap
  // would fire two parallel shields → counter collision. `submitting` is
  // flipped on tap immediately and reset in the finally block.
  const [submitting, setSubmitting] = useState(false);
  /**
   * The refusal a user needs, next to the control that produced it, with
   * `accessibilityRole="alert"`. It used to be a modal — a dialog that has to
   * be dismissed before the number it is complaining about can be seen again.
   */
  const [failure, setFailure] = useState<string | null>(null);

  const {
    isLoading,
    error,
    progress,
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
  // Local wallet only (Privy removed — spec §3 Phase 1).
  const { publicKey: walletPublicKey } = useWalletStore();
  const { isReady: starkReady, generateMerkleUpdateProof } = useStarkProver();

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

  /**
   * Preselect. The Shield tab already asked the question, so this screen does
   * not ask it again; it states the consequence and executes.
   */
  useEffect(() => {
    if (selectedPool) return;
    const wanted = params.denomination ? Number(params.denomination) : OPEN_DENOMINATION;
    const match = pools.find(p => p.denomination === wanted && isOpenPool(p))
      ?? pools.find(isOpenPool);
    if (match) setSelectedPool(match);
  }, [params.denomination, pools, selectedPool]);

  const balanceSol = walletBalance / LAMPORTS_PER_SOL;

  const handleSelectPool = useCallback((pool: PoolConfig) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setFailure(null);
    setSelectedPool(pool);
  }, []);

  const handleConfirmShield = useCallback(async () => {
    if (!selectedPool) return;
    if (submitting) return; // re-tap guard (sync — fires before isLoading flips)
    setSubmitting(true);
    setFailure(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
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
      setFailure(
        `Not enough SOL. This deposit needs ${selectedPool.denomination} SOL plus network fees, ` +
        `and your wallet holds ${(currentBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL.`,
      );
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

          // Current on-chain root (low 8 bytes LE of MerkleTreeStateV3.root @ offset 8+32).
          let onChainRoot = 0n;
          for (let b = 7; b >= 0; b--) onChainRoot = (onChainRoot << 8n) | BigInt(treeAcct.data[8 + 32 + b]);

          // 2. Derive deterministic note material from wallet seed.
          // Use the same `deterministic` mechanic as v2 so V3 notes are
          // recoverable from seed via rescanPool.
          // Local keypair is the only seed source (Privy removed — spec §3 Phase 1).
          const localKp = await getKeypair().catch(() => null);
          const walletSeed: Uint8Array | null = localKp ? localKp.secretKey.slice(0, 32) : null;
          if (!walletSeed) throw new Error('No wallet seed available — cannot derive V3 note');

          // V3 uses the SAME shieldCounters store entry as v2 — the derived
          // nullifier PDAs differ by hash function, so a counter shared between
          // the two namespaces is fine. Without this, every V3 shield would
          // re-use counter=0 → same (np, secret) → same nullifier → only one
          // V3 unshield ever possible per pool per wallet (the v3-counter bug
          // surfaced live on devnet 2026-05-03 when re-shielding into SOL 0.1
          // V3 produced a note that `refreshNoteStatuses` immediately marked
          // 'spent' because the previous V3 unshield's nullifier was still
          // on-chain).
          //
          // findSafeShieldCounter walks counters from `startCounter`, checks
          // BOTH BN254 and Goldilocks nullifier PDAs, and returns the first
          // one with no on-chain nullifier — robust against (a) cross-device
          // shields the local store doesn't know about and (b) post-wipe
          // resync gaps.
          const poolKey = selectedPool.poolPDA.toBase58();
          const startCounter = useDenominatedPoolStore.getState().shieldCounters[poolKey] ?? 0;
          const counter = await findSafeShieldCounter(connection, walletSeed, selectedPool.poolPDA, startCounter);
          const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, selectedPool.poolPDA, counter);

          const slot = await connection.getSlot('confirmed');
          const depositEpoch = slotToEpoch(slot);
          const tokenMintField = pubkeyToField(selectedPool.tokenMint);

          // 3. Compute commitment + new merkle state via Goldilocks helpers.
          const commitment = createCommitmentV3(nullifierPreimage, secret, depositEpoch, tokenMintField);

          // filled_subtrees-layout chooser (ports the extension's proven fix).
          // insert_with_root_v3 stores filled_subtrees[0] = the last leaf and
          // [i+1] = the level-i sibling (merkle_tree_v3.rs:176-184); past clients
          // also wrote it shifted, so the canonical layout can't be assumed.
          // Reconstruct old_root BOTH ways and use whichever reproduces the live
          // on-chain root. Without this, the C6 proof bakes a WRONG old_root →
          // public_inputs_hash mismatch → InvalidProof(6000) at
          // shield_denominated_v3.rs:105 on every pool with ≥2 leaves (root-caused
          // + live-verified on devnet 2026-06-03; mobile had no guard, the
          // extension did). Abort before the ~2-min proof if neither matches so we
          // never burn STARK rent on a guaranteed on-chain reject.
          const direct = computeNewRootFromSubtreesV3(commitment, leafCount, subtrees);
          const sliced = computeNewRootFromSubtreesV3(commitment, leafCount, subtrees.slice(1));
          const oldRootDirect = computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, subtrees).newRoot;
          const oldRootSliced = computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, subtrees.slice(1)).newRoot;
          let chosen: typeof direct;
          if (oldRootDirect === onChainRoot) {
            chosen = direct;
          } else if (oldRootSliced === onChainRoot) {
            chosen = sliced;
          } else {
            throw new Error(
              `Shield pre-flight failed: cannot reconstruct the on-chain Merkle root (${onChainRoot}) ` +
              `from the pool's filled_subtrees for leaf #${leafCount}. Neither layout matched ` +
              `(direct=${oldRootDirect}, shifted=${oldRootSliced}). The tree state has diverged from ` +
              `this client — not generating a proof that would be rejected. Retry shortly.`,
            );
          }
          const { newRoot, updatedSubtrees, pathElements: _pathElements, pathIndices: _pathIndices } = chosen;

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

          // Defensive invariant: the prover's public inputs MUST match what the
          // on-chain handler binds — old_root = merkle_tree.root (shield_v3.rs
          // :92-94 low 8 LE), new_root = the `newRoot` arg. The chooser already
          // guarantees this (it picks the layout whose fold reproduces
          // onChainRoot), so this only fires if the prover's fold ever diverges
          // from computeNewRootFromSubtreesV3 — in which case abort before
          // burning ~0.04 SOL of relay/proof rent on a guaranteed InvalidProof.
          if (c6PublicInputs[2] !== onChainRoot || c6PublicInputs[3] !== (newRoot & ((1n << 64n) - 1n))) {
            throw new Error(
              `Shield aborted: prover/chain public-input mismatch (old_root ` +
              `prover=${c6PublicInputs[2]} chain=${onChainRoot}). Tree state diverged — retry shortly.`,
            );
          }

          // 5. Hand off to the store action which orchestrates submit+verify
          //    of the C6 buffer and the shield_denominated_v3 ix.
          await shieldNoteV3(
            selectedPool,
            {
              commitment,
              newRoot,
              // On-chain `insert_with_root_v3` requires EXACTLY `tree_depth`
              // (=MERKLE_DEPTH=15) entries (merkle_tree_v3.rs:164-167, reusing
              // the InvalidMerkleRoot code for the length guard). The on-chain
              // filled_subtrees Vec is depth+1 (=16) long, so the chooser's
              // `updatedSubtrees` is 16 on the DIRECT path but only 15 on the
              // SLICED path (its input was subtrees.slice(1)). The old
              // `.slice(1)` worked for DIRECT (16→15) but produced 14 on SLICED
              // → InvalidMerkleRoot(6002). `.slice(0, MERKLE_DEPTH)` yields the
              // canonical 15 (levels 0..=14) for BOTH layouts; a future shield's
              // sliced-read reconstructs the root from exactly these values.
              newSubtrees: updatedSubtrees.slice(0, MERKLE_DEPTH),
              secret,
              nullifierPreimage,
              depositEpoch,
              leafIndex: leafCount,
              counter,
            },
            { proofBytes: c6ProofBytes, publicInputs: c6PublicInputs, proofSize: c6Result.proofSize },
          );
        });
      } else {
        await withKeepAwake('p01-shield', () => shieldNote(selectedPool));
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // ⛔ No success card, no Done button. The note is on the Shield screen
      // with its countdown already running, which is both the receipt and
      // where the user was going next.
      router.back();
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFailure(err.message || 'The deposit did not go through.');
    }
    } finally {
      setSubmitting(false);
    }
  }, [selectedPool, walletBalance, walletPublicKey, shieldNote, shieldNoteV3, router, starkReady, generateMerkleUpdateProof, submitting]);

  const busy = isLoading || submitting;
  const canAfford = useMemo(
    () => (selectedPool && selectedPool.token === 'SOL'
      ? balanceSol >= selectedPool.denomination
      : true),
    [selectedPool, balanceSol],
  );

  return (
    <SafeAreaView style={st.container} edges={['top']}>
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={st.headerTitle} accessibilityRole="header">{t('privacy.deposit')}</Text>
        <View style={st.headerSpacer} />
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={st.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Balance — a line, not a card. It informs one decision. */}
        <Text style={st.balanceLabel}>In your wallet</Text>
        <View style={st.balanceRow}>
          <Text style={st.balanceValue}>{loadingBalance ? '—' : balanceSol.toFixed(4)}</Text>
          <Text style={st.balanceUnit}>SOL</Text>
        </View>

        {/* Token toggle */}
        <View style={st.tokenRow}>
          {(['SOL', 'USDC'] as TokenTab[]).map(tab => {
            const active = tokenTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                style={[st.tokenBtn, active && st.tokenBtnActive]}
                onPress={() => {
                  Haptics.selectionAsync();
                  setTokenTab(tab);
                  setSelectedPool(null);
                  setFailure(null);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={tab}
              >
                <Text style={[st.tokenText, active && st.tokenTextActive]}>{tab}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Denominations. Closed pools are shown and refused, never hidden. */}
        <Text style={st.sectionLabel}>Amount</Text>
        <View style={st.chipsGrid}>
          {pools.map((pool) => {
            const open = isOpenPool(pool);
            const selected = selectedPool?.poolPDA.equals(pool.poolPDA) ?? false;
            return (
              <TouchableOpacity
                key={pool.poolPDA.toBase58()}
                style={[st.chip, selected && st.chipSelected, !open && st.chipClosed]}
                onPress={() => handleSelectPool(pool)}
                disabled={busy || !open}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: !open }}
                accessibilityLabel={
                  `${pool.denomination} ${pool.token}${open ? '' : ', closed to new deposits'}`
                }
              >
                <Text style={[st.chipAmount, selected && st.chipAmountSelected]}>
                  {pool.denomination}
                </Text>
                <Text style={st.chipToken}>{open ? pool.token : 'closed'}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/*
          The refusal, with its reason. Founder decision 2026-08-21: one
          denomination, because a crowd does not add across pools, it splits.
        */}
        <Text style={st.refusal}>
          Only the {OPEN_DENOMINATION} SOL pool takes new deposits. Every deposit lands there so
          the crowd stays in one place instead of splitting across six. Notes you already hold in
          the other pools stay spendable, and you can withdraw or send them as usual.
        </Text>

        <Text style={st.note}>
          Deposits with the same amount are indistinguishable from each other.
        </Text>

        {/*
          Who signs the deposit, per token. This is the one thing the deposit
          copy could not say truthfully before 71b51cc1 and can now — but only
          for SOL. `useEphemeralDepositor` is
          `pool.token === 'SOL' && localKp !== null`
          (stores/denominatedPoolStore.ts:1176), so a USDC deposit still goes
          out under the wallet's own signature and the store warns about it at
          :1235-1239. Keying the line off `tokenTab` keeps the two cases from
          ever being collapsed into one reassuring sentence.
        */}
        <View style={st.disclosure}>
          <Ionicons
            name={tokenTab === 'SOL' ? 'key-outline' : 'eye-outline'}
            size={16}
            color={tokenTab === 'SOL' ? Colors.primary : Colors.yellow}
          />
          <Text style={st.disclosureText}>
            {tokenTab === 'SOL'
              ? t('shieldUnshield.depositSignerSol')
              : t('shieldUnshield.depositSignerUsdc')}
          </Text>
        </View>

        {/*
          Kept from the old confirm sheet's fine print. This is a fund-safety
          warning, not a privacy claim, and dropping it as a side effect of a
          layout pass would be a regression in its own right.
        */}
        <Text style={st.note}>{t('privacy.notesStoredLocally')}</Text>

        {/* ─── The one action ─────────────────────────────── */}
        {selectedPool && (
          <>
            {/*
              The last surface before the deposit is signed, so it repeats who
              signs rather than only saying where the note is kept.
              `selectedPool.token` is what actually routes the depositor choice,
              so read it here rather than `tokenTab`.
            */}
            <Text style={st.finePrint}>
              {selectedPool.token === 'SOL'
                ? t('shieldUnshield.depositSignerSol')
                : t('shieldUnshield.depositSignerUsdc')}
            </Text>

            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={busy}
              disabled={busy || !canAfford}
              style={st.action}
              onPress={handleConfirmShield}
              accessibilityLabel={`Deposit ${selectedPool.denomination} ${selectedPool.token}`}
            >
              {`Deposit ${selectedPool.denomination} ${selectedPool.token}`}
            </Button>

            {/* ⚠️ The progress line lives OUTSIDE the button. A loading button
                renders a spinner and drops its children, and a proof that runs
                for two minutes behind a bare spinner is indistinguishable from
                a hang. */}
            {busy && (
              <Text style={st.progress} accessibilityLiveRegion="polite">
                {progress || 'Depositing. Keep the app open; the proof runs on this phone.'}
              </Text>
            )}

            {!canAfford && !busy && (
              <Text style={st.error} accessibilityRole="alert">
                Your wallet holds {balanceSol.toFixed(4)} SOL, and this deposit needs{' '}
                {selectedPool.denomination} SOL plus network fees.
              </Text>
            )}
          </>
        )}

        {/* Errors sit under the control that produced them and announce
            themselves: a wallet flow that fails quietly costs money. */}
        {failure && (
          <Text style={st.error} accessibilityRole="alert">{failure}</Text>
        )}
        {error && !isLoading && !failure && (
          <Text style={st.error} accessibilityRole="alert">{error}</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    minHeight: 56,
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
    paddingHorizontal: Spacing.xs,
  },
  headerSpacer: { width: 44 },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing['6xl'] },

  // Balance
  balanceLabel: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  balanceValue: {
    fontSize: FontSize['3xl'],
    fontFamily: FontFamily.display,
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  balanceUnit: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },

  // Token toggle
  tokenRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing['3xl'],
  },
  tokenBtn: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  tokenBtnActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryDim },
  tokenText: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  tokenTextActive: { color: Colors.text },

  // Denominations
  sectionLabel: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
    marginTop: Spacing['3xl'],
    marginBottom: Spacing.md,
  },
  chipsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  chip: {
    width: '31%',
    flexGrow: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  chipSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryDim },
  chipClosed: { opacity: 0.4 },
  chipAmount: {
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  chipAmountSelected: { color: Colors.text },
  chipToken: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },

  refusal: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.yellow,
    lineHeight: 19,
    marginTop: Spacing.lg,
  },
  note: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 19,
    marginTop: Spacing.lg,
  },

  disclosure: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  disclosureText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 19,
  },

  finePrint: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 17,
    marginTop: Spacing['3xl'],
  },
  action: { marginTop: Spacing.md },
  progress: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: Spacing.md,
  },
  error: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.error,
    lineHeight: 19,
    marginTop: Spacing.md,
  },
});
