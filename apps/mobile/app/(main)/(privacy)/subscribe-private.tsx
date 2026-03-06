import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { PublicKey, SystemProgram } from '@solana/web3.js';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import { receiptFromJSON, findPool } from '@/services/denominatedPool';
import type { ProofGenerator } from '@/services/denominatedPool';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

export default function SubscribePrivateScreen() {
  const router = useRouter();
  const { notes } = useDenominatedPoolStore();
  const { subscribePrivateAction, isLoading, progress } = useSubscriptionVaultStore();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [retailer, setRetailer] = useState('');
  const [rate, setRate] = useState('');
  const [intervalSlots, setIntervalSlots] = useState('7200');

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

      // Look up the selected note and reconstruct the ShieldReceipt + PoolConfig
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

      // TODO: subscriberSecret, vkHashSubscriber, and proofGenerator should be
      // provided by the privacy proving layer (e.g. WebView prover).
      const subscriberSecret = receipt.secret;
      const vkHashSubscriber = new Uint8Array(32);
      const proofGenerator: ProofGenerator = async (inputs, circuit) => {
        throw new Error('Proof generation not yet wired for private subscriptions');
      };

      const sig = await subscribePrivateAction(
        receipt,
        poolConfig,
        vaultConfig,
        subscriberSecret,
        vkHashSubscriber,
        proofGenerator,
      );

      Alert.alert('Success', `Private subscription created!\nTx: ${sig.slice(0, 16)}...`);
      router.back();
    } catch (err) {
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
        <Text style={styles.label}>Select Note</Text>
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

        <TouchableOpacity
          style={[styles.submitBtn, isLoading && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={isLoading}
        >
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
  label: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
    marginBottom: Spacing.sm,
    marginTop: Spacing.lg,
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
  submitBtn: {
    backgroundColor: P01Colors.pink,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginTop: Spacing.xl,
    alignItems: 'center',
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
