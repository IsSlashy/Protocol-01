import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useElapsedSeconds, formatElapsedLabel } from '@/hooks/useElapsedSeconds';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import { useStreamStore } from '@/stores/streamStore';
import {
  receiptFromJSON,
  findPoolByPDA,
  ALL_POOLS_V3,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
  C3_SUBTREE_DEPTH,
} from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { loadStreams } from '@/services/solana/streams';
import {
  useServiceRegistry,
  useRegistryService,
  findServicesByRetailer,
  formatPriceSOL,
  formatInterval,
  type ServiceEntry,
} from '@/services/solana/serviceRegistry';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { licenseServiceTag } from '@/services/license/derive';
import { chooseSubscribeRoute } from '@/services/subscriptionVault/subscribePrivateStarkV4';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { useT } from '@/i18n';
import {
  Colors,
  FontFamily,
  FontSize,
  BorderRadius,
  Spacing,
  Layout,
} from '@/constants/theme';
import { Badge } from '@/components/ui';
import { p01Alert } from '@/stores/alertStore';
import { withKeepAwake } from '@/utils/keepAwakeDuring';

/**
 * ⛔ `GlassCard` IS GONE. It stacked a `BlurView` behind a three-stop diagonal
 * gradient — cyan into pink into transparent — and every panel on this screen
 * used it, so the screen rendered as frosted glass over a colour the brand
 * retired. The site draws a panel as a fill and a hairline rule. So does this.
 */
function Panel({ children, style }: { children: React.ReactNode; style?: any }) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

export default function SubscribePrivateScreen() {
  const router = useRouter();
  const t = useT();
  // Optional prefill — used by the P2P streams flow when the user toggles
  // "Private mode" on `(streams)/create.tsx` and gets routed here. Reading
  // params via the framework router so deep-links work too.
  const params = useLocalSearchParams<{
    retailer?: string;
    rate?: string;
    intervalSlots?: string;
    mode?: 'merchant' | 'stream-p2p';
    /** Registry entry PDA: the screen is being opened for a registered service. */
    service?: string;
  }>();
  const isP2PMode = params.mode === 'stream-p2p';

  const { notes } = useDenominatedPoolStore();
  const {
    subscribePrivateStarkAction,
    prepareSubscribeV4Action,
    subscribePrivateStarkV4Action,
    isLoading,
    progress,
    setProgress,
    resetOperationState,
  } = useSubscriptionVaultStore();
  const {
    isReady: starkReady,
    generateProof: starkGenerate,
    generatePoolCommitmentProof,
    generateMerklePathProof,
    generateSpendProof,
  } = useStarkProver();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [retailer, setRetailer] = useState(params.retailer ?? '');
  const [rate, setRate] = useState(params.rate ?? '');
  const [intervalSlots, setIntervalSlots] = useState(params.intervalSlots ?? '7200');
  const [starkStatus, setStarkStatusLocal] = useState<string | null>(null);
  // [PERF 2026-09-06] Visible clock for the whole flow (proof + upload + vault).
  const elapsed = useElapsedSeconds(isLoading || starkStatus !== null);
  const setStarkStatus = useCallback((s: string | null) => {
    setStarkStatusLocal(s);
    setProgress(s);
  }, [setProgress]);

  // The registry decides the terms for a registered retailer. A merchant
  // checks a key with `verifyMerchantLicense`, which refuses any vault whose
  // rate or interval differs from the merchant's registry entry, so the values
  // typed on this screen may only reach the vault for a retailer the registry
  // does not know. Unverified entries count: the merchant's check does not
  // look at the badge.
  const registry = useServiceRegistry({ verifiedOnly: false });
  const pdaLookup = useRegistryService(params.service);
  const [pickedServicePda, setPickedServicePda] = useState<string | null>(null);

  // Opened for a registry entry: the retailer is the entry's, not typed.
  const routedEntry = pdaLookup.status === 'found' ? pdaLookup.entry : null;
  useEffect(() => {
    if (routedEntry) setRetailer(routedEntry.retailer.toBase58());
  }, [routedEntry]);

  const trimmedRetailer = retailer.trim();
  const registryMatches = useMemo<ServiceEntry[]>(
    () => (routedEntry ? [routedEntry] : findServicesByRetailer(registry.services, trimmedRetailer)),
    [routedEntry, registry.services, trimmedRetailer],
  );
  const otherMintMatches = useMemo(
    () =>
      routedEntry
        ? 0
        : findServicesByRetailer(registry.services, trimmedRetailer, { nativeSolOnly: false }).length -
          registryMatches.length,
    [routedEntry, registry.services, trimmedRetailer, registryMatches.length],
  );
  // One match locks the terms; several need a pick; none is free-form.
  const lockedEntry: ServiceEntry | null =
    registryMatches.length === 1
      ? registryMatches[0]
      : registryMatches.find(s => s.pda.toBase58() === pickedServicePda) ?? null;
  const needsPick = registryMatches.length > 1 && !lockedEntry;
  // Nothing is written until the registry has answered: it is the only way to
  // know whether the typed values are allowed to reach the vault.
  const registryPending = params.service ? pdaLookup.status === 'loading' : registry.loading;
  const registryGate: string | null = params.service
    ? pdaLookup.status === 'missing'
      ? 'This merchant is no longer listed in the registry.'
      : pdaLookup.status === 'error'
        ? `The registry entry could not be read: ${pdaLookup.error ?? 'unknown error'}`
        : null
    : registry.error && !lockedEntry
      ? `The registry could not be read: ${registry.error}`
      : null;

  const matureNotes = notes.filter(n => n.status === 'mature');

  const handleSubmit = async () => {
    if (!selectedNoteId) {
      p01Alert('Select Note', 'Please select a mature note to use for the private subscription.');
      return;
    }

    const trimmedRetailer = retailer.trim();
    if (!trimmedRetailer) {
      p01Alert('Missing Retailer', 'Please enter a retailer address.');
      return;
    }
    let retailerKey: PublicKey;
    try {
      retailerKey = new PublicKey(trimmedRetailer);
    } catch {
      p01Alert('Invalid Retailer', 'The retailer address is not a valid Solana public key.');
      return;
    }

    if (registryPending) {
      p01Alert('Registry not read yet', 'Wait for the registry to answer before opening the vault.');
      return;
    }
    if (registryGate) {
      p01Alert('Registry unavailable', registryGate);
      return;
    }
    if (needsPick) {
      p01Alert('Choose a plan', 'This retailer has several registry entries. Pick the one you are subscribing to.');
      return;
    }

    let rateLamports: bigint;
    let intervalSlotsNum: bigint;
    if (lockedEntry) {
      // Verbatim from the entry, bigint for bigint: that is what the merchant
      // compares the vault against. No float on this path.
      retailerKey = lockedEntry.retailer;
      rateLamports = lockedEntry.priceAtomic;
      intervalSlotsNum = lockedEntry.intervalSlots;
      if (rateLamports <= 0n || intervalSlotsNum <= 0n) {
        p01Alert('Invalid registry entry', 'This registry entry has a zero price or interval and cannot be subscribed to.');
        return;
      }
    } else {
      const rateFloat = parseFloat(rate || '0');
      if (!Number.isFinite(rateFloat) || rateFloat <= 0) {
        p01Alert('Invalid Rate', 'Please enter a positive payment rate in SOL.');
        return;
      }
      // round, not floor: floor(2.01 * 1e9) is 2009999999.
      rateLamports = BigInt(Math.round(rateFloat * 1e9));
      if (rateLamports <= 0n) {
        p01Alert('Invalid Rate', 'Rate must be greater than zero after lamport conversion.');
        return;
      }

      const intervalSlotsInt = parseInt(intervalSlots, 10);
      if (!Number.isFinite(intervalSlotsInt) || intervalSlotsInt <= 0) {
        p01Alert('Invalid Interval', 'Interval must be a positive number of slots.');
        return;
      }
      intervalSlotsNum = BigInt(intervalSlotsInt);
    }
    const rateSOL = Number(rateLamports) / 1e9;

    const note = notes.find(n => n.id === selectedNoteId);
    if (!note) {
      p01Alert('Note Not Found', 'Selected note could not be located — try selecting another.');
      return;
    }
    // V2+V3/V4-aware lookup by poolPDA. The 2026-05-07 V4 seed bump moved active
    // pools into ALL_POOLS_V3, so the old findPool(token, denomination) (V2-only)
    // rejected every current note with "Pool Unavailable". Mirrors the working
    // (streams)/subscribe.tsx path.
    const poolConfig = findPoolByPDA(note.poolPDA);
    if (!poolConfig) {
      p01Alert('Pool Unavailable', `No pool registered for ${note.token} ${note.denomination}.`);
      return;
    }
    // Diagnostic — surface which note + pool the user is binding to. The pool
    // version determines which proof system the on-chain ix expects, and a
    // mismatch later (e.g. Pay Now using V2 path against a V3 note) silently
    // breaks renewals.
    if (__DEV__) {
      console.log('[Sub:Create] note+pool selected', {
        noteId: note.id,
        token: note.token,
        denomination: note.denomination,
        noteStatus: note.status,
        notePoolVersion: (note as any).poolVersion ?? 'unknown',
        poolPDA: poolConfig.poolPDA.toBase58(),
        poolVersion: poolConfig.version ?? 'v2',
        retailer: retailerKey.toBase58().slice(0, 8) + '…',
        rateLamports: rateLamports.toString(),
        intervalSlots: intervalSlotsNum.toString(),
        registrySlug: lockedEntry?.slug ?? null,
        matureNotesAvailable: matureNotes.length,
      });
    }
    if (rateLamports > poolConfig.denominationAtomic) {
      p01Alert(
        'Rate Exceeds Note',
        `Per-period rate (${rateSOL} ${note.token}) cannot be larger than the note denomination (${note.denomination} ${note.token}).`,
      );
      return;
    }

    try {
      if (!starkReady) {
        p01Alert('Prover initializing', 'STARK prover not ready yet — try again in a moment.');
        return;
      }

      await withKeepAwake('p01-subscribe-private', async () => {
      const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));

      const vaultConfig = {
        retailer: retailerKey,
        rate: rateLamports,
        intervalSlots: intervalSlotsNum,
      };

      const subscriberSecret = receipt.secret;

      setStarkStatus('Computing STARK commitment...');
      const ownershipResult = await starkGenerate(subscriberSecret.toString());
      const vkHashSubscriber = sha256(Buffer.from(ownershipResult.commitment, 'hex'));
      if (__DEV__) {
        // Hash the secret rather than logging it — never the raw bigint.
        const secretHash = sha256(Buffer.from(subscriberSecret.toString(), 'utf8'))
          .slice(0, 8).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
        console.log('[Sub:Create] STARK ownership commitment', {
          commitmentHexPrefix: ownershipResult.commitment.slice(0, 16),
          vkHashPrefix: Buffer.from(vkHashSubscriber).slice(0, 4).toString('hex'),
          subscriberSecretHash8: secretHash,
          durationMs: ownershipResult.durationMs,
        });
      }

      // ── ROUTE: CIRCUIT 7, OR THE C1 + C3 PAIR ───────────────────────────
      //
      // THE ROUTE IS PER NOTE, NOT A MIGRATION. `subscribe_private_stark` (v3)
      // stays reachable indefinitely: a note whose blinding is an epoch can be
      // spent nowhere else, and the v4 prepare has no stored-path fast path, so
      // a note whose root aged out of the pool's 100-root ring still needs the
      // v3 rebuild. Neither leg is legacy.
      //
      // `chooseSubscribeRoute` asks `whySubscribeCircuit7Cannot(receipt)`
      // SYNCHRONOUSLY FIRST, then tries the prepare, and falls back to the pair
      // ONLY on `SubscribeV4Unprovable` — an allow-list. A wrong felt count or a
      // transcript bound to the wrong terms is a broken PROVER, and answering
      // that by publishing the commitment on v3 and reporting success is the
      // exact failure the pair exists to remove. Everything else rethrows.
      //
      // NOTHING after the prepare falls back: once the proof is uploaded and
      // the nullifier PDA initialised, a v3 retry pays rent twice and dies on
      // the double-spend guard with the note already spent.
      const serviceTag = licenseServiceTag(lockedEntry?.slug, retailerKey.toBase58());
      const route = await chooseSubscribeRoute(receipt, () =>
        prepareSubscribeV4Action(
          receipt,
          poolConfig,
          vaultConfig,
          subscriberSecret,
          BigInt(ownershipResult.commitment),
          vkHashSubscriber,
          generateSpendProof,
          serviceTag,
        ),
      );
      if (route.version === 'v3') {
        console.warn(
          '[Sub:Create] circuit 7 could not prove this note; falling back to the C1 + C3 ' +
          'pair, which publishes the note commitment:',
          route.reason,
        );
      }

      let sig: string;
      let vaultAddress: string;
      if (route.version === 'v4') {
        setStarkStatus('Submitting the circuit-7 subscription...');
        ({ signature: sig, vaultAddress } = await subscribePrivateStarkV4Action(
          receipt,
          poolConfig,
          vaultConfig,
          subscriberSecret,
          BigInt(ownershipResult.commitment),
          route.prepared,
          serviceTag,
        ));
      } else {
      // Byte for byte what this screen did before circuit 7 existed.
      setStarkStatus('Generating STARK pool commitment proof...');
      const starkResult = await generatePoolCommitmentProof(
        receipt.nullifierPreimage.toString(),
        receipt.secret.toString(),
        receipt.depositEpoch.toString(),
        receipt.tokenMint.toString(),
      );

      const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
      const publicInputs = starkResult.publicInputs.map(s => BigInt(s));
      if (__DEV__) {
        console.log('[Sub:Create] pool_commitment proof', {
          circuitId: starkResult.circuitId,
          proofSize: starkResult.proofSize,
          publicInputsCount: publicInputs.length,
          // public inputs[0] = nullifier hash on this circuit; safe to log prefix.
          nullifierHashPrefix: publicInputs[0]?.toString(16).slice(0, 16) ?? 'none',
          durationMs: starkResult.durationMs,
        });
      }

      // C3 (merkle_path) proof — NEW on-chain hardening requirement.
      // subscribe_private_stark now demands a second STARK buffer proving the
      // C1 commitment is a leaf in the pool tree at `merkle_root`. We rebuild
      // the merkle path fresh from the on-chain V3 leaves (the stored receipt
      // root may be stale / missing for recovered notes), then prove it.
      // Mirrors the C3 flow in (privacy)/denominated-unshield.tsx exactly so
      // the public-inputs hashing matches the on-chain reconstruction
      // sha256(leaf_u64_le || root[..8] || depth=15_u64_le).
      setStarkStatus('Building Merkle proof (C3)...');
      const poolV3 = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === poolConfig.poolPDA.toBase58());
      if (!poolV3) {
        throw new Error(
          'Private subscribe requires a V3 pool (subscribe_private_stark uses V3 tree/merkle_path). ' +
          'No V3 pool registered for this note.',
        );
      }
      const conn = getConnection();
      // 5000 sig limit — devnet Helius 429s truncate low limits; a missed
      // LeafInserted event gap-fills with ZERO_VALUE and produces a root that
      // doesn't exist on-chain → InvalidProof / InvalidMerkleRoot.
      const SIG_SCAN_LIMIT = 5000;
      const leafScan = await fetchPoolLeavesByIndex(conn, poolV3.poolPDA, { maxSignatures: SIG_SCAN_LIMIT });
      const merkleProof = buildMerkleProofFromLeavesV3({
        leavesByIndex: leafScan.leavesByIndex,
        targetLeafIndex: receipt.leafIndex,
      });
      const { root: c3Root, pathElements: c3Path, pathIndices: c3Indices } = merkleProof;

      setStarkStatus('Generating Merkle path proof (C3)...');
      // [C3-D12] Bottom 12 levels into the circuit; the top 3 travel to the
      // instruction for the on-chain walk.
      const U64 = (1n << 64n) - 1n;
      if (c3Path.length < C3_SUBTREE_DEPTH) {
        throw new Error(
          `Merkle path has ${c3Path.length} elements, need at least ` +
          `${C3_SUBTREE_DEPTH} for the C3 circuit.`,
        );
      }
      const c3Result = await generateMerklePathProof(
        (receipt.commitment & U64).toString(),
        c3Path.slice(0, C3_SUBTREE_DEPTH).map(e => (e & U64).toString()),
        c3Indices.slice(0, C3_SUBTREE_DEPTH),
      );
      // ⛔ POOL root from the walk, not the proof's public input 1.
      const c3Walk = {
        merkleRoot: c3Root,
        siblings: c3Path.slice(C3_SUBTREE_DEPTH).map(e => e & U64),
        directions: c3Indices.slice(C3_SUBTREE_DEPTH),
      };
      const c3Bytes = Buffer.from(c3Result.proofHex, 'hex');
      const c3Inputs = c3Result.publicInputs.map((s: string) => BigInt(s));
      if (__DEV__) {
        console.log('[Sub:Create] merkle_path (C3) proof', {
          circuitId: c3Result.circuitId,
          proofSize: c3Result.proofSize,
          publicInputsCount: c3Inputs.length,
          // [leaf, subtree_root, depth] — prefix safe to log (public on-chain).
          subtreeRootPrefix: c3Inputs[1]?.toString(16).slice(0, 16) ?? 'none',
          depth: c3Inputs[2]?.toString() ?? 'none',
          durationMs: c3Result.durationMs,
        });
      }

      setStarkStatus('Submitting STARK subscription...');
      ({ signature: sig, vaultAddress } = await subscribePrivateStarkAction(
        receipt,
        poolConfig,
        vaultConfig,
        subscriberSecret,
        BigInt(ownershipResult.commitment),
        vkHashSubscriber,
        {
          proofBytes,
          publicInputs,
          proofSize: starkResult.proofSize,
        },
        {
          proofBytes: c3Bytes,
          publicInputs: c3Inputs,
          proofSize: c3Result.proofSize,
        },
        c3Walk,
        // Service tag for the license-key commitment: the registry slug for a
        // registered service, else the retailer address. One rule, shared with
        // LicenseKeyCard (licenseServiceTag).
        licenseServiceTag(lockedEntry?.slug, retailerKey.toBase58()),
      ));
      }

      if (__DEV__) {
        console.log('[Sub:Create] subscribe action returned', {
          route: route.version,
          sigPrefix: sig.slice(0, 16),
          // Pool version we created against — Pay Now / processDuePayments
          // must select the matching V2/V3 unshield path for this same note.
          poolVersion: poolConfig.version ?? 'v2',
        });
      }
      setStarkStatus(null);
      // The store wrote the Stream row from the terms it sent; the license
      // key is shown on that row's detail screen.
      await useStreamStore.getState().refresh().catch(() => {});
      const row = (await loadStreams().catch(() => [])).find(s => s.vaultAddress === vaultAddress);
      p01Alert(
        'Success',
        `Private subscription created!\nTx: ${sig.slice(0, 16)}...`,
        row
          ? [
              { text: 'View subscription', onPress: () => router.replace(`/(main)/(streams)/${row.id}` as any) },
              { text: 'Done', style: 'cancel', onPress: () => router.back() },
            ]
          : undefined,
      );
      if (!row) router.back();
      });
    } catch (err) {
      if (__DEV__) {
        console.warn('[Sub:Create] FAILED', {
          message: (err as Error).message,
          stack: (err as Error).stack?.split('\n').slice(0, 4).join(' | '),
        });
      }
      setStarkStatus(null);
      p01Alert('Error', (err as Error).message);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* ── Header ── */}
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
        <Text style={styles.headerTitle} numberOfLines={1}>Private subscription</Text>
        <View style={styles.headerSpacer} />
      </View>

      {(isLoading || starkStatus) && (
        <View style={styles.stickyProgress}>
          <ActivityIndicator size="small" color={Colors.primary} />
          <Text style={styles.stickyProgressText} numberOfLines={2}>
            {formatElapsedLabel(starkStatus ?? progress ?? 'Processing...', elapsed)}
          </Text>
          <TouchableOpacity
            style={styles.stickyCancel}
            onPress={() => {
              setStarkStatus(null);
              resetOperationState();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel stuck operation"
          >
            <Ionicons name="close" size={16} color={Colors.text} />
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Prover state ──
            One line, because it carries exactly one decision: whether the
            button below can do anything yet. It used to be a 40pt tinted
            square, a title, a subtitle and a status dot, in violet. */}
        <Animated.View entering={FadeInDown.delay(40)} style={styles.proverRow}>
          <View style={[styles.proverDot, starkReady && styles.proverDotReady]} />
          <Text style={styles.proverText}>
            {starkReady
              ? 'Prover ready — proofs are generated on this phone.'
              : 'Preparing the prover…'}
          </Text>
        </Animated.View>

        {/* ── 1. The note that funds it ── */}
        <Animated.View entering={FadeInDown.delay(80)}>
          <Text style={styles.sectionTitle}>Note</Text>

          {matureNotes.length === 0 ? (
            <Panel>
              <Text style={styles.emptyTitle}>No matured note</Text>
              <Text style={styles.emptyText}>
                Shield SOL first. A note is spendable once it matures, and the wait is
                enforced on chain — no screen can shorten it.
              </Text>
            </Panel>
          ) : (
            <View style={styles.noteList}>
              {matureNotes.map((note, i) => {
                const selected = selectedNoteId === note.id;
                return (
                  <Animated.View key={note.id} entering={FadeInUp.delay(110 + i * 40)}>
                    <TouchableOpacity
                      style={[styles.noteCard, selected && styles.noteCardSelected]}
                      onPress={() => setSelectedNoteId(note.id)}
                      activeOpacity={0.7}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`${note.denomination} ${note.token} note`}
                    >
                      <View style={[styles.radio, selected && styles.radioSelected]}>
                        {selected && <View style={styles.radioDot} />}
                      </View>
                      <View style={styles.noteBody}>
                        <Text style={styles.noteAmount}>
                          {note.denomination} {note.token}
                        </Text>
                        <Text style={styles.noteMeta}>Matured, ready to spend</Text>
                      </View>
                      <Badge variant="good" size="sm">Ready</Badge>
                    </TouchableOpacity>
                  </Animated.View>
                );
              })}
            </View>
          )}
        </Animated.View>

        {/* ── 2. Who gets paid ── */}
        <Animated.View entering={FadeInUp.delay(160)}>
          <Text style={styles.sectionTitle}>Retailer address</Text>
          <TextInput
            style={[styles.input, !!routedEntry && styles.inputLocked]}
            value={retailer}
            onChangeText={setRetailer}
            editable={!routedEntry}
            placeholder="Solana public key"
            placeholderTextColor={Colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Retailer address"
          />
          {registryGate && (
            <View style={styles.registryGate} accessibilityRole="alert">
              <Text style={styles.registryGateText}>{registryGate}</Text>
              <TouchableOpacity
                onPress={() => (params.service ? pdaLookup.retry() : void registry.refresh())}
                accessibilityRole="button"
                style={styles.registryRetry}
              >
                <Text style={styles.registryRetryText}>Try again</Text>
              </TouchableOpacity>
            </View>
          )}
        </Animated.View>

        {/* ── 3. How much, per period ──
            For a registered retailer the terms are the registry's and cannot
            be edited here: a merchant's registry check refuses a vault whose
            rate or interval differs from its entry by a single lamport or
            slot. Typing is for retailers the registry does not know. */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <Text style={styles.sectionTitle}>Rate per period</Text>

          {needsPick && (
            <View style={styles.pickList}>
              <Text style={styles.registryHint}>
                This retailer has several registry entries. Pick the one you are subscribing to.
              </Text>
              {registryMatches.map(s => (
                <TouchableOpacity
                  key={s.pda.toBase58()}
                  style={styles.pickRow}
                  onPress={() => setPickedServicePda(s.pda.toBase58())}
                  activeOpacity={0.7}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: false }}
                  accessibilityLabel={`${s.name || s.slug}, ${formatPriceSOL(s.priceAtomic)} SOL ${formatInterval(s.intervalSlots)}`}
                >
                  <View style={styles.radio} />
                  <View style={styles.noteBody}>
                    <Text style={styles.pickName}>{s.name || s.slug}</Text>
                    <Text style={styles.pickTerms}>
                      {formatPriceSOL(s.priceAtomic)} SOL {formatInterval(s.intervalSlots)}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {lockedEntry ? (
            <Panel>
              <View style={styles.lockedHeader}>
                <Text style={styles.lockedName} numberOfLines={1}>
                  {lockedEntry.name || lockedEntry.slug}
                </Text>
                <Badge variant={lockedEntry.verified ? 'good' : 'neutral'} size="sm">
                  {lockedEntry.verified ? 'Verified' : 'Registered'}
                </Badge>
              </View>
              <Text style={styles.lockedTerms}>
                {formatPriceSOL(lockedEntry.priceAtomic)} SOL {formatInterval(lockedEntry.intervalSlots)}
                {' '}({lockedEntry.intervalSlots.toString()} slots)
              </Text>
              <Text style={styles.lockedNote}>
                Rate and interval are copied from this merchant&apos;s registry entry and cannot be
                edited here. That is what makes the license key pass the merchant&apos;s registry
                check. The key is tagged with the entry&apos;s id, {lockedEntry.slug}.
              </Text>
              {registryMatches.length > 1 && (
                <TouchableOpacity
                  onPress={() => setPickedServicePda(null)}
                  accessibilityRole="button"
                  style={styles.lockedChange}
                >
                  <Text style={styles.lockedChangeText}>Choose another plan</Text>
                </TouchableOpacity>
              )}
            </Panel>
          ) : (
            <>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.inputFlex}
                  value={rate}
                  onChangeText={setRate}
                  placeholder="1"
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="decimal-pad"
                  accessibilityLabel="Rate per period in SOL"
                />
                <Text style={styles.inputSuffix}>SOL</Text>
              </View>
              <Text style={[styles.sectionTitle, styles.sectionTitleTight]}>Interval</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.inputFlex}
                  value={intervalSlots}
                  onChangeText={setIntervalSlots}
                  placeholder="7200"
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="number-pad"
                  accessibilityLabel="Interval in slots"
                />
                <Text style={styles.inputSuffix}>
                  slots{Number.isFinite(parseInt(intervalSlots, 10)) && parseInt(intervalSlots, 10) > 0
                    ? `, ${formatInterval(BigInt(parseInt(intervalSlots, 10)))}`
                    : ''}
                </Text>
              </View>
              {registryPending ? (
                <Text style={styles.registryHint}>Checking the registry for this retailer.</Text>
              ) : trimmedRetailer.length > 0 && !registryGate ? (
                <View style={styles.freeFormCard} accessibilityRole="alert">
                  <Text style={styles.freeFormTitle}>Not in the registry</Text>
                  <Text style={styles.freeFormBody}>
                    A free-form subscription is not recognised by a merchant&apos;s registry check.
                    The vault carries the rate and interval typed here, and only a merchant who
                    accepts this exact address, rate and interval by hand can verify its key.
                    {otherMintMatches > 0
                      ? ' This retailer is registered for another token; this app pays in SOL only.'
                      : ''}
                  </Text>
                </View>
              ) : (
                <Text style={styles.registryHint}>
                  If the retailer is in the registry, its rate and interval are filled in here.
                </Text>
              )}
            </>
          )}
        </Animated.View>

        {/* Progress, in place, once something is running. */}
        {(isLoading || starkStatus) && (
          <Animated.View entering={FadeInUp.delay(240)}>
            <Panel style={styles.progressPanel}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.progressText}>
                {formatElapsedLabel(starkStatus ?? progress ?? 'Processing...', elapsed)}
              </Text>
            </Panel>
          </Animated.View>
        )}

        {/*
          THE ONE-WAY WARNING. It sits on the paying screen, directly above the
          button that moves the money -- not in settings, not in a tooltip. The
          note is deposited into a SubscriptionVault in full and the protocol has
          no instruction that can ever pay any of it back.

          It is read through `t()` DELIBERATELY, even though the rest of this
          screen is English-only. This is the screen that opens the ZK vault, so
          it is the one place the fr and ja copy has to be reachable -- the
          i18n parity test asserts those translations exist and differ from
          English, and a hardcoded English block here made that assertion
          vacuous on exactly the path where the money becomes irrecoverable.
        */}
        <Animated.View entering={FadeInUp.delay(280)}>
          <View style={styles.oneWayCard}>
            <View style={styles.oneWayHeader}>
              <Ionicons name="warning-outline" size={16} color={Colors.yellow} />
              <Text style={styles.oneWayTitle}>{t('subscribe.oneWayTitle')}</Text>
            </View>
            <Text style={styles.oneWayBody}>{t('subscribe.oneWayBody')}</Text>
            <Text style={styles.oneWayBody}>{t('subscribe.pauseResumeBody')}</Text>
          </View>
        </Animated.View>

        {/* ── The one action ── */}
        <Animated.View entering={FadeInUp.delay(320)}>
          <TouchableOpacity
            style={[styles.submitBtn, isLoading && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={isLoading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ disabled: isLoading, busy: isLoading }}
          >
            <Ionicons name="lock-closed" size={18} color={Colors.background} />
            <Text style={styles.submitText}>Open the vault</Text>
          </TouchableOpacity>
        </Animated.View>

        {/*
          'No private data leaves your phone' was false here for the same
          reason it was false on the privacy home screen: the proof is
          uploaded, and subscribe_private_stark carries the deposit's note
          commitment as `stark_commitment`
          (services/subscriptionVault/index.ts:549 -> :768). The wallet also
          signs this instruction (:552), so it is on chain by name.
        */}
        <Animated.View entering={FadeInUp.delay(360)}>
          <Text style={styles.footnote}>
            STARK proofs are generated on-device — your note's secrets are never sent to a
            server. Your wallet still signs this subscription, and the proof carries the same
            note commitment your deposit published.
          </Text>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
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

  // Panel: a fill and a rule.
  panel: {
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },

  // Prover state
  proverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.xl,
  },
  proverDot: {
    width: 7,
    height: 7,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.textTertiary,
  },
  proverDotReady: { backgroundColor: Colors.primary },
  proverText: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Sections
  sectionTitle: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: Spacing['3xl'],
    marginBottom: Spacing.md,
  },
  sectionTitleTight: { marginTop: Spacing.lg },

  // Registry: the terms a merchant will compare the vault against.
  registryGate: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.warningDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
  },
  registryGateText: {
    flex: 1,
    minWidth: 160,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textSecondary,
  },
  registryRetry: {
    minHeight: 44,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  registryRetryText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  registryHint: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    lineHeight: 17,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
  },
  pickList: { gap: Spacing.sm, marginBottom: Spacing.md },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 56,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  pickName: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  pickTerms: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  lockedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  lockedName: {
    flexShrink: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  lockedTerms: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.text,
    marginTop: Spacing.sm,
  },
  lockedNote: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    lineHeight: 17,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
  },
  lockedChange: {
    minHeight: 44,
    justifyContent: 'center',
    marginTop: Spacing.xs,
  },
  lockedChangeText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  freeFormCard: {
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.warningDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
    gap: Spacing.xs,
  },
  freeFormTitle: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.yellow,
  },
  freeFormBody: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    lineHeight: 17,
    color: Colors.textSecondary,
  },

  // Empty
  emptyTitle: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.lg,
    color: Colors.text,
  },
  emptyText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textSecondary,
    marginTop: Spacing.xs,
  },

  // Notes
  noteList: { gap: Spacing.sm },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 60,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  noteCardSelected: {
    backgroundColor: Colors.primaryDim,
    borderColor: Colors.primaryMuted,
  },
  noteBody: { flex: 1, minWidth: 0 },
  noteAmount: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  noteMeta: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: BorderRadius.full,
    borderWidth: 2,
    borderColor: Colors.textTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: Colors.primary },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary,
  },

  // Inputs — 44pt floor, visible label above, never a placeholder as the label.
  input: {
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
  },
  inputLocked: { color: Colors.textSecondary },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  inputFlex: {
    flex: 1,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    padding: 0,
  },
  inputSuffix: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
  },

  // Sticky progress, under the header, visible for the whole long flow.
  stickyProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Layout.screenPadding,
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.primaryMuted,
  },
  stickyProgressText: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  stickyCancel: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // In-place progress
  progressPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginTop: Spacing.xl,
  },
  progressText: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // The one-way warning. Amber is caution, and this is the only amber here.
  oneWayCard: {
    marginTop: Spacing['3xl'],
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.warningDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
    gap: Spacing.sm,
  },
  oneWayHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  oneWayTitle: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.yellow,
  },
  oneWayBody: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textSecondary,
  },

  // Submit
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 52,
    marginTop: Spacing.xl,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.lg,
    color: Colors.background,
  },

  footnote: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    lineHeight: 17,
    color: Colors.textTertiary,
    marginTop: Spacing.lg,
  },
});
