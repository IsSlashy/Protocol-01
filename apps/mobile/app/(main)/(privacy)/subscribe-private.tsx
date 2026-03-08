import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import { receiptFromJSON, findPool } from '@/services/denominatedPool';
import type { ProofGenerator } from '@/services/denominatedPool';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { submitStarkProof, type CompactStarkProof } from '@/services/stark';
import { useZkProver } from '@/providers/ZkProverProvider';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

export default function SubscribePrivateScreen() {
  const router = useRouter();
  const { notes } = useDenominatedPoolStore();
  const { subscribePrivateAction, isLoading, progress } = useSubscriptionVaultStore();
  const { isReady: starkReady, generateProof: starkGenerate } = useStarkProver();
  const { generateRawProof } = useZkProver();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [retailer, setRetailer] = useState('');
  const [rate, setRate] = useState('');
  const [intervalSlots, setIntervalSlots] = useState('7200');
  const [starkStatus, setStarkStatus] = useState<string | null>(null);

  const matureNotes = notes.filter(n => n.status === 'mature');

  const handleSubmit = async () => {
    if (!selectedNoteId) {
      Alert.alert('Select Note', 'Please select a mature note to use for the private subscription.');
      return;
    }
    if (!retailer.trim()) {
      Alert.alert('Missing Retailer', 'Please enter a retailer address.');
      return;
    }
    try {
      const retailerKey = new PublicKey(retailer);
      const rateLamports = BigInt(Math.floor(parseFloat(rate || '0') * 1e9));
      const intervalSlotsNum = BigInt(parseInt(intervalSlots, 10));

      const note = notes.find(n => n.id === selectedNoteId);
      if (!note) throw new Error('Selected note not found');
      const receipt = receiptFromJSON(note.receiptJSON);
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
        // Hash the STARK commitment to get a 32-byte vk_hash
        vkHashSubscriber = sha256(Buffer.from(starkResult.commitment, 'hex'));

        // Submit STARK proof on-chain for quantum-resistant verification
        setStarkStatus('Submitting STARK proof on-chain...');
        const starkProof: CompactStarkProof = {
          proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
          commitment: BigInt(starkResult.commitment),
          proofSize: starkResult.proofSize,
        };
        await submitStarkProof(starkProof, undefined, (step) => {
          setStarkStatus(step);
        });
        setStarkStatus('STARK verified on-chain!');
      } else {
        // Fallback: zero vk_hash if STARK not ready (less secure)
        vkHashSubscriber = new Uint8Array(32);
      }

      // Groth16 proof generator for the pool unshield circuit
      const proofGenerator: ProofGenerator = async (inputs, circuit) => {
        if (circuit === 'subscriber') {
          // For subscriber ownership proof, use Groth16 (the on-chain subscription
          // program verifies Groth16 proofs inline). STARK proof was submitted
          // separately above for quantum resistance.
          return generateRawProof(inputs as Record<string, string>);
        }
        // Default: pool/transfer circuit
        return generateRawProof(inputs as Record<string, string>);
      };

      const sig = await subscribePrivateAction(
        receipt,
        poolConfig,
        vaultConfig,
        subscriberSecret,
        vkHashSubscriber,
        proofGenerator,
      );

      setStarkStatus(null);
      Alert.alert('Success', `Private subscription created!\nTx: ${sig.slice(0, 16)}...`);
      router.back();
    } catch (err) {
      setStarkStatus(null);
      Alert.alert('Error', (err as Error).message);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Private Subscription</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* STARK status badge */}
        <View style={styles.starkBadge}>
          <Ionicons
            name="hardware-chip"
            size={16}
            color={starkReady ? '#10B981' : Colors.textTertiary}
          />
          <Text style={[styles.starkBadgeText, starkReady && { color: '#10B981' }]}>
            {starkReady ? 'STARK Ready — Quantum-resistant proof' : 'STARK loading...'}
          </Text>
        </View>

        <Text style={styles.label}>Select Note</Text>
        {matureNotes.length === 0 && (
          <Text style={styles.emptyText}>
            No mature notes available. Shield SOL first and wait for maturity.
          </Text>
        )}
        {matureNotes.map(note => (
          <TouchableOpacity
            key={note.id}
            style={[
              styles.noteCard,
              selectedNoteId === note.id && styles.noteCardSelected,
            ]}
            onPress={() => setSelectedNoteId(note.id)}
          >
            <Text style={styles.noteText}>
              {note.denomination} {note.token}
            </Text>
          </TouchableOpacity>
        ))}

        <Text style={styles.label}>Retailer Address</Text>
        <TextInput
          style={styles.input}
          value={retailer}
          onChangeText={setRetailer}
          placeholder="Enter retailer pubkey"
          placeholderTextColor={Colors.textTertiary}
        />

        <Text style={styles.label}>Rate per Period (SOL)</Text>
        <TextInput
          style={styles.input}
          value={rate}
          onChangeText={setRate}
          placeholder="1"
          placeholderTextColor={Colors.textTertiary}
          keyboardType="decimal-pad"
        />

        {/* Progress indicator */}
        {(isLoading || starkStatus) && (
          <View style={styles.progressCard}>
            <ActivityIndicator size="small" color="#8B5CF6" />
            <Text style={styles.progressText}>
              {starkStatus ?? progress ?? 'Processing...'}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.submitBtn, isLoading && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={isLoading}
        >
          <Ionicons name="shield-checkmark" size={18} color="#000" />
          <Text style={styles.submitText}>Create Private Subscription</Text>
        </TouchableOpacity>
      </ScrollView>
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
  starkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(139, 92, 246, 0.08)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.2)',
  },
  starkBadgeText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  label: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
    marginBottom: Spacing.sm,
    marginTop: Spacing.lg,
  },
  emptyText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noteCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noteCardSelected: {
    borderColor: P01Colors.cyan,
    backgroundColor: P01Colors.cyanDim,
  },
  noteText: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  progressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(139, 92, 246, 0.08)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.2)',
  },
  progressText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: '#8B5CF6',
    flex: 1,
  },
  submitBtn: {
    backgroundColor: P01Colors.pink,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginTop: Spacing.xl,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
});
