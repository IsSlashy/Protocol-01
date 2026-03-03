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
import { PublicKey } from '@solana/web3.js';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
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
    Alert.alert('Not Implemented', 'Private subscription creation requires proof generation setup.');
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
