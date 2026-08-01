import React, { useCallback, useState } from 'react';
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
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import {
  receiptFromJSON,
  findPoolByPDA,
  ALL_POOLS_V3,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
} from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { licenseServiceTag } from '@/services/license/derive';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { withKeepAwake } from '@/utils/keepAwakeDuring';

function GlassCard({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[styles.glassOuter, style]}>
      <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
        <LinearGradient
          colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {children}
      </BlurView>
    </View>
  );
}

export default function SubscribePrivateScreen() {
  const router = useRouter();
  // Optional prefill — used by the P2P streams flow when the user toggles
  // "Private mode" on `(streams)/create.tsx` and gets routed here. Reading
  // params via the framework router so deep-links work too.
  const params = useLocalSearchParams<{
    retailer?: string;
    rate?: string;
    intervalSlots?: string;
    mode?: 'merchant' | 'stream-p2p';
  }>();
  const isP2PMode = params.mode === 'stream-p2p';

  const { notes } = useDenominatedPoolStore();
  const {
    subscribePrivateStarkAction,
    isLoading,
    progress,
    setProgress,
    resetOperationState,
  } = useSubscriptionVaultStore();
  const { isReady: starkReady, generateProof: starkGenerate, generatePoolCommitmentProof, generateMerklePathProof } = useStarkProver();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [retailer, setRetailer] = useState(params.retailer ?? '');
  const [rate, setRate] = useState(params.rate ?? '');
  const [intervalSlots, setIntervalSlots] = useState(params.intervalSlots ?? '7200');
  const [starkStatus, setStarkStatusLocal] = useState<string | null>(null);
  const setStarkStatus = useCallback((s: string | null) => {
    setStarkStatusLocal(s);
    setProgress(s);
  }, [setProgress]);

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

    const rateFloat = parseFloat(rate || '0');
    if (!Number.isFinite(rateFloat) || rateFloat <= 0) {
      p01Alert('Invalid Rate', 'Please enter a positive payment rate in SOL.');
      return;
    }
    const rateLamports = BigInt(Math.floor(rateFloat * 1e9));
    if (rateLamports <= 0n) {
      p01Alert('Invalid Rate', 'Rate must be greater than zero after lamport conversion.');
      return;
    }

    const intervalSlotsInt = parseInt(intervalSlots, 10);
    if (!Number.isFinite(intervalSlotsInt) || intervalSlotsInt <= 0) {
      p01Alert('Invalid Interval', 'Interval must be a positive number of slots.');
      return;
    }
    const intervalSlotsNum = BigInt(intervalSlotsInt);

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
        retailer: trimmedRetailer.slice(0, 8) + '…',
        rateLamports: rateLamports.toString(),
        intervalSlots: intervalSlotsInt,
        matureNotesAvailable: matureNotes.length,
      });
    }
    if (rateLamports > poolConfig.denominationAtomic) {
      p01Alert(
        'Rate Exceeds Note',
        `Per-period rate (${rateFloat} ${note.token}) cannot be larger than the note denomination (${note.denomination} ${note.token}).`,
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
      const { pathElements: c3Path, pathIndices: c3Indices } = merkleProof;

      setStarkStatus('Generating Merkle path proof (C3)...');
      const U64 = (1n << 64n) - 1n;
      const c3Result = await generateMerklePathProof(
        (receipt.commitment & U64).toString(),
        c3Path.map(e => (e & U64).toString()),
        c3Indices,
      );
      const c3Bytes = Buffer.from(c3Result.proofHex, 'hex');
      const c3Inputs = c3Result.publicInputs.map((s: string) => BigInt(s));
      if (__DEV__) {
        console.log('[Sub:Create] merkle_path (C3) proof', {
          circuitId: c3Result.circuitId,
          proofSize: c3Result.proofSize,
          publicInputsCount: c3Inputs.length,
          // [leaf, root, depth] — root prefix safe to log (public on-chain).
          rootPrefix: c3Inputs[1]?.toString(16).slice(0, 16) ?? 'none',
          depth: c3Inputs[2]?.toString() ?? 'none',
          durationMs: c3Result.durationMs,
        });
      }

      setStarkStatus('Submitting STARK subscription...');
      const { signature: sig } = await subscribePrivateStarkAction(
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
        undefined, // clientStealthMeta — not used on this direct private flow
        // Service tag for the license-key commitment. This screen has no
        // Service Registry slug (free-form retailer), so the rule resolves to
        // the retailer address — the same value LicenseKeyCard now uses.
        licenseServiceTag(undefined, retailerKey.toBase58()),
      );

      if (__DEV__) {
        console.log('[Sub:Create] subscribePrivateStarkAction returned', {
          sigPrefix: sig.slice(0, 16),
          // Pool version we created against — Pay Now / processDuePayments
          // must select the matching V2/V3 unshield path for this same note.
          poolVersion: poolConfig.version ?? 'v2',
        });
      }
      setStarkStatus(null);
      p01Alert('Success', `Private subscription created!\nTx: ${sig.slice(0, 16)}...`);
      router.back();
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
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(0)} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Private Subscription</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      {(isLoading || starkStatus) && (
        <View style={styles.stickyProgress}>
          <ActivityIndicator size="small" color={P01Colors.cyan} />
          <Text style={styles.stickyProgressText} numberOfLines={2}>
            {starkStatus ?? progress ?? 'Processing...'}
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

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* STARK status badge */}
        <Animated.View entering={FadeInDown.delay(50)}>
          <GlassCard>
            <View style={styles.starkBadgeInner}>
              <View style={[
                styles.starkIndicator,
                { backgroundColor: starkReady ? 'rgba(16, 185, 129, 0.15)' : 'rgba(139, 92, 246, 0.1)' },
              ]}>
                <Ionicons
                  name="hardware-chip"
                  size={18}
                  color={starkReady ? '#10B981' : Colors.textTertiary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.starkBadgeTitle, starkReady && { color: '#10B981' }]}>
                  {starkReady ? 'STARK Ready' : 'STARK Loading...'}
                </Text>
                <Text style={styles.starkBadgeSubtext}>
                  {starkReady ? 'Quantum-resistant proof available' : 'Preparing prover...'}
                </Text>
              </View>
              <View style={[
                styles.starkDot,
                { backgroundColor: starkReady ? '#10B981' : Colors.textTertiary },
              ]} />
            </View>
          </GlassCard>
        </Animated.View>

        {/* Note Selection */}
        <Animated.View entering={FadeInDown.delay(100)}>
          <Text style={styles.sectionTitle}>1. Select Note</Text>

          {matureNotes.length === 0 && (
            <GlassCard>
              <View style={styles.emptyInner}>
                <Ionicons name="receipt-outline" size={28} color={Colors.textTertiary} />
                <Text style={styles.emptyText}>
                  No mature notes available. Shield SOL first and wait for maturity.
                </Text>
              </View>
            </GlassCard>
          )}

          {matureNotes.map((note, i) => (
            <Animated.View key={note.id} entering={FadeInUp.delay(130 + i * 50)}>
              <TouchableOpacity
                style={[
                  styles.noteCardOuter,
                  selectedNoteId === note.id && styles.noteCardOuterSelected,
                ]}
                onPress={() => setSelectedNoteId(note.id)}
                activeOpacity={0.7}
              >
                <BlurView intensity={14} tint="dark" style={styles.noteCardBlur}>
                  <LinearGradient
                    colors={
                      selectedNoteId === note.id
                        ? ['rgba(57, 197, 187, 0.1)', 'rgba(57, 197, 187, 0.03)', 'transparent']
                        : ['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']
                    }
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={StyleSheet.absoluteFill}
                    pointerEvents="none"
                  />
                  <View style={styles.noteCardRow}>
                    <View style={styles.noteIconWrap}>
                      <Ionicons
                        name={selectedNoteId === note.id ? 'radio-button-on' : 'radio-button-off'}
                        size={20}
                        color={selectedNoteId === note.id ? P01Colors.cyan : Colors.textTertiary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.noteAmount}>
                        {note.denomination} {note.token}
                      </Text>
                      <Text style={styles.noteSubtext}>Mature &bull; Ready to use</Text>
                    </View>
                    {selectedNoteId === note.id && (
                      <Ionicons name="checkmark-circle" size={20} color={P01Colors.cyan} />
                    )}
                  </View>
                </BlurView>
              </TouchableOpacity>
            </Animated.View>
          ))}
        </Animated.View>

        {/* Retailer Address */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <Text style={styles.sectionTitle}>2. Retailer Address</Text>
          <GlassCard>
            <TextInput
              style={styles.input}
              value={retailer}
              onChangeText={setRetailer}
              placeholder="Enter retailer pubkey"
              placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </GlassCard>
        </Animated.View>

        {/* Rate */}
        <Animated.View entering={FadeInUp.delay(250)}>
          <Text style={styles.sectionTitle}>3. Rate per Period (SOL)</Text>
          <GlassCard>
            <TextInput
              style={styles.input}
              value={rate}
              onChangeText={setRate}
              placeholder="1"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="decimal-pad"
            />
          </GlassCard>
        </Animated.View>

        {/* Progress indicator */}
        {(isLoading || starkStatus) && (
          <Animated.View entering={FadeInUp.delay(300)}>
            <GlassCard style={{ marginTop: Spacing.lg }}>
              <View style={styles.progressInner}>
                <View style={styles.progressSpinner}>
                  <ActivityIndicator size="small" color={P01Colors.cyan} />
                </View>
                <Text style={styles.progressText}>
                  {starkStatus ?? progress ?? 'Processing...'}
                </Text>
              </View>
            </GlassCard>
          </Animated.View>
        )}

        {/*
          THE ONE-WAY WARNING. It sits on the paying screen, directly above the
          button that moves the money -- not in settings, not in a tooltip. The
          note is deposited into a SubscriptionVault in full and the protocol has
          no instruction that can ever pay any of it back.
        */}
        <Animated.View entering={FadeInUp.delay(330)}>
          <View style={styles.oneWayCard}>
            <View style={styles.oneWayHeader}>
              <Ionicons name="warning-outline" size={16} color={P01Colors.yellow} />
              <Text style={styles.oneWayTitle}>THIS PAYMENT IS ONE-WAY</Text>
            </View>
            <Text style={styles.oneWayBody}>
              Your note is deposited in full and can only ever be paid out to the
              retailer.{' '}
              <Text style={styles.oneWayStrong}>
                There is no cancellation and no refund
              </Text>
              {' '}- not from the retailer, not from Protocol 01.
            </Text>
            <Text style={styles.oneWayBody}>
              <Text style={styles.oneWayStrong}>
                You can pause at any time and resume later.
              </Text>
              {' '}Pausing freezes the clock and cuts access; your prepaid days are
              not lost while paused.
            </Text>
          </View>
        </Animated.View>

        {/* Submit Button */}
        <Animated.View entering={FadeInUp.delay(350)}>
          <TouchableOpacity
            style={[styles.submitBtn, isLoading && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={isLoading}
            activeOpacity={0.8}
          >
            <Ionicons name="shield-checkmark" size={20} color="#000" />
            <Text style={styles.submitText}>Create Private Subscription</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Privacy footer note */}
        <Animated.View entering={FadeInUp.delay(400)}>
          <View style={styles.privacyNote}>
            <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
            <Text style={styles.privacyNoteText}>
              STARK proofs generated on-device. No private data leaves your phone.
            </Text>
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  oneWayCard: {
    marginTop: Spacing.lg,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: 'rgba(255,204,0,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,204,0,0.4)',
    gap: 6,
  },
  oneWayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  oneWayTitle: {
    fontSize: 12,
    fontFamily: FontFamily.bold,
    letterSpacing: 1,
    color: P01Colors.yellow,
  },
  oneWayBody: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  oneWayStrong: {
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
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

  // Glass card base
  glassOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
    marginBottom: Spacing.md,
  },
  glassBlur: {
    padding: Spacing.lg,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },

  // STARK badge
  starkBadgeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  starkIndicator: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starkBadgeTitle: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
  },
  starkBadgeSubtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  starkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  // Section titles
  sectionTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    marginTop: Spacing.lg,
  },

  // Empty state
  emptyInner: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  emptyText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
    textAlign: 'center',
  },

  // Note cards
  noteCardOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
    marginBottom: Spacing.sm,
  },
  noteCardOuterSelected: {
    borderColor: P01Colors.cyan,
  },
  noteCardBlur: {
    padding: Spacing.lg,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  noteCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  noteIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(57, 197, 187, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  noteSubtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },

  // Inputs
  input: {
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: 14,
    padding: 0,
  },

  // Sticky progress (below header, always visible during long flow)
  stickyProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: 12,
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    borderWidth: 1,
    borderColor: P01Colors.cyan,
    gap: Spacing.sm,
  },
  stickyProgressText: {
    flex: 1,
    color: Colors.text,
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  stickyCancel: {
    width: 28,
    height: 28,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Progress
  progressInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  progressSpinner: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(57, 197, 187, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: P01Colors.cyan,
    flex: 1,
  },

  // Submit button
  submitBtn: {
    backgroundColor: P01Colors.pink,
    borderRadius: 14,
    paddingVertical: Spacing.lg,
    marginTop: Spacing['2xl'],
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
  },
  submitBtnDisabled: {
    opacity: 0.4,
  },
  submitText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },

  // Privacy footer
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'center',
    marginTop: Spacing.lg,
  },
  privacyNoteText: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
});
