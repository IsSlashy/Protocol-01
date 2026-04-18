import React, { useState } from 'react';
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
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import { receiptFromJSON, findPool } from '@/services/denominatedPool';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import type { ProofGenerator } from '@/services/denominatedPool';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { useZkProver } from '@/providers/ZkProverProvider';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

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
  const { notes } = useDenominatedPoolStore();
  const {
    subscribePrivateAction,
    subscribePrivateStarkAction,
    isLoading,
    progress,
  } = useSubscriptionVaultStore();
  const { isReady: starkReady, generateProof: starkGenerate, generatePoolCommitmentProof } = useStarkProver();
  const { generateRawProof } = useZkProver();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [retailer, setRetailer] = useState('');
  const [rate, setRate] = useState('');
  const [intervalSlots, setIntervalSlots] = useState('7200');
  const [starkStatus, setStarkStatus] = useState<string | null>(null);

  const matureNotes = notes.filter(n => n.status === 'mature');

  const handleSubmit = async () => {
    if (!selectedNoteId) {
      p01Alert('Select Note', 'Please select a mature note to use for the private subscription.');
      return;
    }
    if (!retailer.trim()) {
      p01Alert('Missing Retailer', 'Please enter a retailer address.');
      return;
    }
    try {
      const retailerKey = new PublicKey(retailer);
      const rateLamports = BigInt(Math.floor(parseFloat(rate || '0') * 1e9));
      const intervalSlotsNum = BigInt(parseInt(intervalSlots, 10));

      const note = notes.find(n => n.id === selectedNoteId);
      if (!note) throw new Error('Selected note not found');
      const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));
      const poolConfig = findPool(note.token, note.denomination);
      if (!poolConfig) throw new Error(`Pool not found for ${note.token} ${note.denomination}`);

      const vaultConfig = {
        retailer: retailerKey,
        rate: rateLamports,
        intervalSlots: intervalSlotsNum,
      };

      const subscriberSecret = receipt.secret;

      // Generate STARK commitment for vkHashSubscriber
      // The STARK commitment is a Poseidon hash in the Goldilocks field.
      // We truncate the SHA-256 of the STARK commitment hex to 32 bytes for the vk_hash.
      let vkHashSubscriber: Uint8Array;
      if (starkReady) {
        setStarkStatus('Computing STARK commitment...');
        const starkResult = await starkGenerate(subscriberSecret.toString());
        vkHashSubscriber = sha256(Buffer.from(starkResult.commitment, 'hex'));
      } else {
        // Fallback: zero vk_hash if STARK not ready (less secure)
        vkHashSubscriber = new Uint8Array(32);
      }

      let sig: string;

      if (starkReady) {
        // --- STARK path (quantum-resistant) ---
        // Uses subscribe_private_stark on-chain instruction which reads
        // a pre-verified STARK proof buffer instead of inline Groth16.
        setStarkStatus('Generating STARK pool commitment proof...');
        const starkResult = await generatePoolCommitmentProof(
          receipt.nullifierPreimage.toString(),
          receipt.secret.toString(),
          receipt.depositEpoch.toString(),
          receipt.tokenMint.toString(),
        );

        const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
        const publicInputs = starkResult.publicInputs.map(s => BigInt(s));

        setStarkStatus('Submitting STARK subscription...');
        sig = await subscribePrivateStarkAction(
          receipt,
          poolConfig,
          vaultConfig,
          subscriberSecret,
          vkHashSubscriber,
          {
            proofBytes,
            publicInputs,
            proofSize: starkResult.proofSize,
          },
        );
      } else {
        // --- Groth16 fallback ---
        // Uses subscribe_private on-chain instruction with inline Groth16 verification.
        const proofGenerator: ProofGenerator = async (inputs, _circuit) => {
          return generateRawProof(inputs as Record<string, string>);
        };

        sig = await subscribePrivateAction(
          receipt,
          poolConfig,
          vaultConfig,
          subscriberSecret,
          vkHashSubscriber,
          proofGenerator,
        );
      }

      setStarkStatus(null);
      p01Alert('Success', `Private subscription created!\nTx: ${sig.slice(0, 16)}...`);
      router.back();
    } catch (err) {
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
              Groth16 + STARK proofs generated on-device. No private data leaves your phone.
            </Text>
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
