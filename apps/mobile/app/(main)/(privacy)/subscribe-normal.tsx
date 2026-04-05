import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';

import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

export default function SubscribeNormalScreen() {
  const router = useRouter();
  const { subscribeNormalAction, isLoading, progress } = useSubscriptionVaultStore();

  const [retailer, setRetailer] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [intervalSlots, setIntervalSlots] = useState('7200'); // ~1 hour

  const handleSubmit = async () => {
    if (!retailer.trim()) {
      p01Alert('Missing Retailer', 'Please enter a retailer address.');
      return;
    }
    if (!amount.trim() || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      p01Alert('Invalid Amount', 'Please enter a valid amount.');
      return;
    }
    if (!rate.trim() || isNaN(parseFloat(rate)) || parseFloat(rate) <= 0) {
      p01Alert('Invalid Rate', 'Please enter a valid rate per period.');
      return;
    }
    try {
      const retailerKey = new PublicKey(retailer);
      const amountLamports = BigInt(Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL));
      const rateLamports = BigInt(Math.floor(parseFloat(rate) * LAMPORTS_PER_SOL));
      const intervalSlotsNum = BigInt(parseInt(intervalSlots, 10));

      // Placeholder VK hash — replace with actual VK hash from circuit
      const vkHashSubscriber = new Uint8Array(32);

      const sig = await subscribeNormalAction(
        {
          retailer: retailerKey,
          tokenMint: SystemProgram.programId,
          amount: amountLamports,
          rate: rateLamports,
          intervalSlots: intervalSlotsNum,
        },
        vkHashSubscriber,
      );

      p01Alert('Success', `Subscription created! Tx: ${sig.slice(0, 16)}...`);
      router.back();
    } catch (err) {
      p01Alert('Error', (err as Error).message);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Normal Subscription</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.label}>Retailer Address</Text>
        <TextInput
          style={styles.input}
          value={retailer}
          onChangeText={setRetailer}
          placeholder="Enter retailer pubkey"
          placeholderTextColor={Colors.textTertiary}
        />

        <Text style={styles.label}>Total Amount (SOL)</Text>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="10"
          placeholderTextColor={Colors.textTertiary}
          keyboardType="decimal-pad"
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

        <Text style={styles.label}>Interval (slots)</Text>
        <TextInput
          style={styles.input}
          value={intervalSlots}
          onChangeText={setIntervalSlots}
          placeholder="7200"
          placeholderTextColor={Colors.textTertiary}
          keyboardType="number-pad"
        />

        {progress && (
          <Text style={styles.progress}>{progress}</Text>
        )}

        <TouchableOpacity
          style={[styles.submitBtn, isLoading && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={isLoading}
        >
          <Text style={styles.submitText}>Create Subscription</Text>
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
  progress: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: P01Colors.cyan,
    marginTop: Spacing.md,
    textAlign: 'center',
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
