import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import {
  useDenominatedPoolStore,
  type StoredNote,
  type NoteStatus,
} from '@/stores/denominatedPoolStore';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { useArcium } from '@/providers/ArciumProvider';
import { receiptFromJSON } from '@/services/denominatedPool';
import { getKeypair } from '@/services/solana/wallet';
import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { requireBiometricAuth } from '@/utils/biometricGate';

export default function DenominatedUnshieldScreen() {
  return <UnshieldScreenContent />;
}

function UnshieldScreenContent() {
  const router = useRouter();
  const params = useLocalSearchParams<{ noteId?: string; emergency?: string }>();
  const isEmergencyMode = params.emergency === '1';

  const {
    notes,
    isLoading,
    isProving,
    error,
    progress,
    unshieldNoteStark,
    emergencyUnshieldNote,
    refreshNoteStatuses,
  } = useDenominatedPoolStore();

  const { publicKey: walletPublicKey } = useWalletStore();
  const { isReady: starkReady, generatePoolCommitmentProof } = useStarkProver();
  const { isMpcActive } = useArcium();

  const [selectedNote, setSelectedNote] = useState<StoredNote | null>(null);
  const [recipient, setRecipient] = useState('');
  const [useOwnWallet, setUseOwnWallet] = useState(true);
  const [emergencyToggle, setEmergencyToggle] = useState(isEmergencyMode);

  const matureNotes = notes.filter(n => n.status === 'mature');
  const pendingNotes = notes.filter(n => n.status === 'pending');
  const selectableNotes = emergencyToggle ? [...matureNotes, ...pendingNotes] : matureNotes;

  // Pre-select note from params
  useEffect(() => {
    if (params.noteId) {
      const note = notes.find(n => n.id === params.noteId);
      if (note) setSelectedNote(note);
    }
    refreshNoteStatuses();
  }, [params.noteId]);

  // Load own wallet address — use walletStore publicKey as fallback for Privy wallets
  useEffect(() => {
    (async () => {
      if (useOwnWallet) {
        const keypair = await getKeypair();
        if (keypair) {
          setRecipient(keypair.publicKey.toBase58());
        } else if (walletPublicKey) {
          setRecipient(walletPublicKey);
        }
      }
    })();
  }, [useOwnWallet, walletPublicKey]);

  const confirmEmergencyUnshield = useCallback(() => {
    Alert.alert(
      'Privacy Warning',
      'Emergency unshield bypasses the maturity delay. This may reduce your privacy by creating a timing link between your deposit and withdrawal.\n\nOnly use this if you urgently need your funds.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Proceed',
          style: 'destructive',
          onPress: () => executeUnshield(true),
        },
      ],
    );
  }, [selectedNote, recipient]);

  const executeUnshield = useCallback(async (emergency: boolean) => {
    if (!selectedNote) {
      Alert.alert('Select a Note', 'Please select a note to withdraw.');
      return;
    }
    if (!recipient || recipient.length < 32) {
      Alert.alert('Invalid Recipient', 'Please enter a valid Solana address.');
      return;
    }

    // Biometric gate — require auth before unshielding funds
    const authed = await requireBiometricAuth('Authenticate to unshield funds');
    if (!authed) {
      Alert.alert('Authentication Required', 'You must authenticate to unshield funds.');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      let sig: string;

      // Both normal and emergency use STARK (quantum-resistant)
      // Emergency passes emergency=true which sets minEpoch=0 on-chain (bypasses maturity)
      if (!starkReady) {
        Alert.alert('STARK Not Ready', 'STARK prover is still loading. Please wait a moment.');
        return;
      }

      // Parse receipt to get note secrets for STARK proof
      const receipt = receiptFromJSON(selectedNote.receiptJSON);

      // Generate pool_commitment STARK proof on-device
      const starkResult = await generatePoolCommitmentProof(
        receipt.nullifierPreimage.toString(),
        receipt.secret.toString(),
        receipt.depositEpoch.toString(),
        receipt.tokenMint.toString(),
      );

      // Parse STARK proof result
      const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
      const publicInputs = starkResult.publicInputs.map(s => BigInt(s));

      sig = await unshieldNoteStark(selectedNote.id, recipient, {
        proofBytes,
        publicInputs,
        proofSize: starkResult.proofSize,
      }, emergency);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const proofLabel = isMpcActive ? 'STARK + MPC' : 'STARK';
      Alert.alert(
        emergency ? 'Emergency Unshield Complete' : `Unshielded (${proofLabel})!`,
        `${selectedNote.denomination} ${selectedNote.token} withdrawn to ${recipient.slice(0, 8)}...${isMpcActive ? '\n\nNullifier hidden via MPC — withdrawal unlinkable.' : ''}\n\nTx: ${sig.slice(0, 16)}...`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Unshield Failed', err.message);
    }
  }, [selectedNote, recipient, unshieldNoteStark, emergencyUnshieldNote, starkReady, generatePoolCommitmentProof, router]);

  const handleUnshield = useCallback(() => {
    if (emergencyToggle) {
      confirmEmergencyUnshield();
    } else {
      executeUnshield(false);
    }
  }, [emergencyToggle, selectedNote, confirmEmergencyUnshield, executeUnshield]);

  const statusIcon = (status: NoteStatus) => {
    switch (status) {
      case 'mature': return { name: 'checkmark-circle' as const, color: P01Colors.cyan };
      case 'pending': return { name: 'time' as const, color: P01Colors.yellow };
      case 'spent': return { name: 'close-circle' as const, color: Colors.textTertiary };
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {emergencyToggle ? 'Emergency Unshield' : 'Unshield'}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Emergency toggle */}
        <Animated.View entering={FadeInDown.delay(0)}>
          <View style={styles.modeToggle}>
            <TouchableOpacity
              style={[styles.modeBtn, !emergencyToggle && styles.modeBtnActive]}
              onPress={() => { setEmergencyToggle(false); setSelectedNote(null); }}
            >
              <Text style={[styles.modeText, !emergencyToggle && styles.modeTextActive]}>
                Normal
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, emergencyToggle && styles.modeBtnEmergency]}
              onPress={() => { setEmergencyToggle(true); setSelectedNote(null); }}
            >
              <Ionicons
                name="warning"
                size={14}
                color={emergencyToggle ? '#FF6B35' : Colors.textTertiary}
              />
              <Text style={[styles.modeText, emergencyToggle && styles.modeTextEmergency]}>
                Emergency
              </Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Emergency warning */}
        {emergencyToggle && (
          <Animated.View entering={FadeInDown.delay(50)}>
            <View style={styles.warningCard}>
              <Ionicons name="warning" size={18} color="#FF6B35" />
              <Text style={styles.warningText}>
                Emergency mode bypasses the maturity delay. This reduces your privacy
                by linking deposit and withdrawal timing. Only use if you urgently need funds.
              </Text>
            </View>
          </Animated.View>
        )}

        {/* Step 1: Select Note */}
        <Animated.View entering={FadeInDown.delay(50)}>
          <Text style={styles.sectionTitle}>
            1. Select {emergencyToggle ? 'a' : 'a Mature'} Note
          </Text>

          {selectableNotes.length === 0 && notes.filter(n => n.status !== 'spent').length === 0 && (
            <View style={styles.emptyCard}>
              <Ionicons name="receipt-outline" size={32} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>No notes found. Shield some funds first.</Text>
              <TouchableOpacity
                style={styles.emptyAction}
                onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
              >
                <Text style={styles.emptyActionText}>Go to Shield</Text>
              </TouchableOpacity>
            </View>
          )}

          {!emergencyToggle && matureNotes.length === 0 && pendingNotes.length > 0 && (
            <View style={styles.infoCard}>
              <Ionicons name="time-outline" size={18} color={P01Colors.yellow} />
              <Text style={styles.infoText}>
                {pendingNotes.length} note(s) still maturing. Notes need ~1 epoch (~1 hour) before withdrawal.
                Use Emergency mode to bypass this.
              </Text>
            </View>
          )}

          {selectableNotes.map((note, i) => {
            const isSelected = selectedNote?.id === note.id;
            const icon = statusIcon(note.status);

            return (
              <Animated.View key={note.id} entering={FadeInUp.delay(100 + i * 60)}>
                <TouchableOpacity
                  style={[styles.noteCard, isSelected && styles.noteCardSelected]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setSelectedNote(note);
                  }}
                  disabled={isLoading}
                >
                  <View style={styles.noteLeft}>
                    <Ionicons name={icon.name} size={24} color={icon.color} />
                    <View>
                      <Text style={styles.noteAmount}>{note.denomination} {note.token}</Text>
                      <Text style={styles.noteTime}>
                        {new Date(note.shieldedAt).toLocaleString()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.noteRight}>
                    {note.status === 'pending' && emergencyToggle && (
                      <View style={styles.pendingBadge}>
                        <Text style={styles.pendingBadgeText}>Immature</Text>
                      </View>
                    )}
                    {isSelected ? (
                      <Ionicons name="radio-button-on" size={22} color={P01Colors.cyan} />
                    ) : (
                      <Ionicons name="radio-button-off" size={22} color={Colors.textTertiary} />
                    )}
                  </View>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </Animated.View>

        {/* Step 2: Recipient */}
        <Animated.View entering={FadeInUp.delay(250)}>
          <Text style={styles.sectionTitle}>2. Recipient Address</Text>

          <View style={styles.recipientToggle}>
            <TouchableOpacity
              style={[styles.toggleBtn, useOwnWallet && styles.toggleBtnActive]}
              onPress={() => setUseOwnWallet(true)}
            >
              <Text style={[styles.toggleText, useOwnWallet && styles.toggleTextActive]}>
                My Wallet
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleBtn, !useOwnWallet && styles.toggleBtnActive]}
              onPress={() => { setUseOwnWallet(false); setRecipient(''); }}
            >
              <Text style={[styles.toggleText, !useOwnWallet && styles.toggleTextActive]}>
                Custom
              </Text>
            </TouchableOpacity>
          </View>

          {!useOwnWallet && (
            <TextInput
              style={styles.addressInput}
              value={recipient}
              onChangeText={setRecipient}
              placeholder="Solana address..."
              placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
            />
          )}

          {useOwnWallet && recipient && (
            <View style={styles.addressPreview}>
              <Text style={styles.addressPreviewText} numberOfLines={1}>
                {recipient}
              </Text>
            </View>
          )}
        </Animated.View>

        {/* Step 3: Confirm */}
        <Animated.View entering={FadeInUp.delay(350)}>
          <TouchableOpacity
            style={[
              styles.confirmBtn,
              emergencyToggle && selectedNote?.status === 'pending' && styles.confirmBtnEmergency,
              (!selectedNote || isLoading) && styles.confirmBtnDisabled,
            ]}
            onPress={handleUnshield}
            disabled={!selectedNote || isLoading}
          >
            {isLoading ? (
              <View style={styles.confirmLoading}>
                <ActivityIndicator size="small" color="#000" />
                <Text style={styles.confirmBtnText}>
                  {isProving ? 'Generating proof...' : progress || 'Processing...'}
                </Text>
              </View>
            ) : (
              <>
                <Ionicons
                  name={emergencyToggle ? 'warning' : 'arrow-up-circle'}
                  size={22}
                  color="#000"
                />
                <Text style={styles.confirmBtnText}>
                  {selectedNote
                    ? `${emergencyToggle && selectedNote.status === 'pending' ? 'Emergency ' : ''}Withdraw ${selectedNote.denomination} ${selectedNote.token}`
                    : 'Select a note first'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </Animated.View>

        {/* Privacy Note */}
        <Animated.View entering={FadeInUp.delay(400)}>
          <View style={styles.privacyNote}>
            <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
            <Text style={styles.privacyNoteText}>
              STARK proof generated on-device (quantum-resistant). No private data leaves your phone.
            </Text>
          </View>
        </Animated.View>

        {/* Error */}
        {error && !isLoading && (
          <View style={styles.errorCard}>
            <Ionicons name="warning" size={18} color={Colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
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
  modeToggle: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modeBtnActive: {
    backgroundColor: P01Colors.cyanDim,
    borderColor: P01Colors.cyan,
  },
  modeBtnEmergency: {
    backgroundColor: 'rgba(255, 107, 53, 0.1)',
    borderColor: '#FF6B35',
  },
  modeText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  modeTextActive: {
    color: P01Colors.cyan,
  },
  modeTextEmergency: {
    color: '#FF6B35',
  },
  warningCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: Spacing.md,
    backgroundColor: 'rgba(255, 107, 53, 0.1)',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 53, 0.3)',
    marginBottom: Spacing.md,
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: '#FF6B35',
    lineHeight: 18,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    marginTop: Spacing.lg,
  },
  emptyCard: {
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing['2xl'],
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  emptyAction: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyanDim,
  },
  emptyActionText: {
    fontSize: 13,
    fontFamily: FontFamily.semibold,
    color: P01Colors.cyan,
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: Spacing.md,
    backgroundColor: P01Colors.yellowDim,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 204, 0, 0.3)',
    marginBottom: Spacing.md,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: P01Colors.yellow,
    lineHeight: 18,
  },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.lg,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  noteCardSelected: {
    borderColor: P01Colors.cyan,
    backgroundColor: P01Colors.cyanDim,
  },
  noteLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    flex: 1,
  },
  noteRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  noteAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  noteTime: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  pendingBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 107, 53, 0.15)',
  },
  pendingBadgeText: {
    fontSize: 10,
    fontFamily: FontFamily.medium,
    color: '#FF6B35',
  },
  recipientToggle: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  toggleBtnActive: {
    backgroundColor: P01Colors.cyanDim,
    borderColor: P01Colors.cyan,
  },
  toggleText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  toggleTextActive: {
    color: P01Colors.cyan,
  },
  addressInput: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: 13,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addressPreview: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addressPreviewText: {
    fontFamily: FontFamily.mono,
    fontSize: 12,
    color: Colors.textSecondary,
  },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: P01Colors.cyan,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.lg,
    marginTop: Spacing['2xl'],
  },
  confirmBtnEmergency: {
    backgroundColor: '#FF6B35',
  },
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmBtnText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  confirmLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
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
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.errorDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.error,
    marginTop: Spacing.lg,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.error,
  },
});
