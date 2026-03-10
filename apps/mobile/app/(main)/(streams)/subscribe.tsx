import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { p01Alert } from '../../../stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import {
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore } from '../../../stores/walletStore';
import { useShieldedStore } from '../../../stores/shieldedStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { StreamFrequency, updateStream as updateStreamRecord } from '../../../services/solana/streams';
import { getConnection } from '../../../services/solana/connection';
import { getKeypair } from '../../../services/solana/wallet';
import {
  DenominatedPoolProverProvider,
  useDenominatedPoolProver,
} from '../../../components/privacy/DenominatedPoolProver';

// Protocol 01 Color System
const COLORS = {
  cyan: '#39c5bb',
  cyanDim: '#2a9d95',
  pink: '#ff77a8',
  yellow: '#ffcc00',
  green: '#00ff88',
  red: '#ff3366',
  text: '#ffffff',
  textMuted: '#888892',
  textDim: '#555560',
  void: '#0a0a0c',
  surface: '#151518',
  surface2: '#1a1a1e',
  border: '#2a2a30',
};

// Service icons mapping
const SERVICE_ICONS: Record<string, string> = {
  netflix: 'play-circle',
  spotify: 'musical-notes',
  chatgpt: 'chatbubbles',
  github: 'logo-github',
  figma: 'color-palette',
  notion: 'document-text',
};

export default function SubscribeScreen() {
  return (
    <DenominatedPoolProverProvider>
      <SubscribeScreenContent />
    </DenominatedPoolProverProvider>
  );
}

function SubscribeScreenContent() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // p01Alert imported at top level (no hook needed)
  const params = useLocalSearchParams<{
    serviceId: string;
    serviceName: string;
    price: string;
    frequency: string;
  }>();

  const { createNewStream, refresh } = useStreamStore();
  const { publicKey } = useWalletStore();
  const { shieldedBalance, isInitialized: isZkReady } = useShieldedStore();
  const { notes: denomNotes } = useDenominatedPoolStore();
  const { generateProof } = useDenominatedPoolProver();

  // Private balance = total value of available denomination pool notes
  const availableNotes = denomNotes.filter(n => n.status === 'mature' || n.status === 'pending');
  const privateBalance = availableNotes.reduce((sum, n) => sum + n.denomination, 0);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [enablePrivacy, setEnablePrivacy] = useState(false);
  const [useZkPool, setUseZkPool] = useState(false);
  const [selectedDuration, setSelectedDuration] = useState<'1' | '6' | '12'>('1');

  const serviceName = params.serviceName || 'Service';
  const serviceId = params.serviceId || '';
  const price = parseFloat(params.price || '0');
  const frequency = (params.frequency || 'monthly') as StreamFrequency;
  const icon = SERVICE_ICONS[serviceId] || 'cube';

  // Calculate totals based on duration
  const durationMonths = parseInt(selectedDuration);
  const totalPrice = price * durationMonths;
  const savings = durationMonths > 1 ? (price * durationMonths * 0.1).toFixed(4) : null; // 10% discount for longer subs

  const handleSubscribe = async () => {
    if (!publicKey) {
      p01Alert('Wallet Required', 'Please connect your wallet to subscribe.', undefined, 'warning');
      return;
    }

    try {
      setIsSubscribing(true);
      setProgressMessage(null);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const firstPayment = price;
      const now = Date.now();
      const endDate = now + durationMonths * 30 * 24 * 60 * 60 * 1000;
      const devnetTestAddress = 'GJyrdH4xBKjQiWspGUqfwHR1Mqn2pgXMxpXsE3M2aGS6';

      let paymentSignature: string;
      let paymentAmount: number = firstPayment;

      if (useZkPool) {
        // Private Wallet: unshield denomination note on-chain with ZK proof
        setProgressMessage('Finding shielded note...');
        const poolStore = useDenominatedPoolStore.getState();
        const activeNotes = poolStore.getActiveNotes()
          .filter(n => n.token === 'SOL' && n.status === 'mature')
          .sort((a, b) => a.denomination - b.denomination);

        const sourceNote = activeNotes.find(n => n.denomination >= firstPayment);
        if (!sourceNote) {
          throw new Error('No mature shielded note large enough. Shield more SOL first.');
        }

        setProgressMessage('Generating ZK proof...');
        // unshieldNote: generates proof on-device → sends real tx → marks note spent
        paymentSignature = await poolStore.unshieldNote(
          sourceNote.id,
          devnetTestAddress,
          generateProof,
        );
        paymentAmount = sourceNote.denomination;
        setProgressMessage('Confirmed on Solana!');
      } else {
        // Normal Wallet: real SOL transfer on-chain
        setProgressMessage('Preparing transaction...');
        const keypair = await getKeypair();
        if (!keypair) throw new Error('Wallet keypair not found');

        const connection = getConnection();
        const lamports = Math.round(firstPayment * 1_000_000_000);

        const transferIx = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(devnetTestAddress),
          lamports,
        });

        setProgressMessage('Sending to Solana...');
        const tx = new Transaction().add(transferIx);
        paymentSignature = await sendAndConfirmTransaction(connection, tx, [keypair], {
          commitment: 'confirmed',
        });
        setProgressMessage('Confirmed!');
      }

      // Create stream record AFTER on-chain payment succeeds
      const stream = await createNewStream({
        name: serviceName,
        recipientAddress: devnetTestAddress,
        totalAmount: totalPrice,
        frequency,
        endDate,
        serviceId,
        serviceName,
        amountNoise: enablePrivacy ? 10 : 0,
        timingNoise: enablePrivacy ? 4 : 0,
        useStealthAddress: enablePrivacy,
        useZkPool,
      });

      // Record first payment with REAL on-chain signature
      await updateStreamRecord(stream.id, {
        amountStreamed: paymentAmount,
        paymentsCompleted: 1,
        paymentHistory: [{
          id: `pay-${stream.id}-0`,
          amount: paymentAmount,
          actualAmount: paymentAmount,
          signature: paymentSignature,
          timestamp: now,
          status: 'success',
        }],
      });
      await refresh(publicKey || undefined);

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      p01Alert(
        useZkPool ? 'Privately Subscribed!' : 'Subscribed!',
        useZkPool
          ? `${paymentAmount} SOL paid on-chain via ZK proof. Tx: ${paymentSignature.slice(0, 8)}... — ${serviceName} is active, your identity is hidden.`
          : `First payment of ${firstPayment} SOL confirmed on-chain. Tx: ${paymentSignature.slice(0, 8)}... — ${serviceName} is now active.`,
        [
          {
            text: 'View Subscription',
            style: 'default',
            onPress: () => router.replace(`/(main)/(streams)/${stream.id}`),
          },
          {
            text: 'Done',
            style: 'cancel',
            onPress: () => router.replace('/(main)/(streams)'),
          },
        ],
        'success',
      );
    } catch (error: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Error', error.message || 'Failed to subscribe. Please try again.', undefined, 'error');
    } finally {
      setIsSubscribing(false);
      setProgressMessage(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.void }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingTop: insets.top + 8,
          paddingBottom: 12,
        }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: 'rgba(57, 197, 187, 0.2)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.cyan} />
        </TouchableOpacity>

        <Text style={{ color: COLORS.text, fontSize: 17, fontWeight: '600' }}>
          Subscribe
        </Text>

        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Service Card */}
        <Animated.View entering={FadeIn.duration(300)}>
          <LinearGradient
            colors={['rgba(57, 197, 187, 0.2)', COLORS.surface]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
              borderRadius: 20,
              padding: 24,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: 'rgba(57, 197, 187, 0.3)',
            }}
          >
            {/* Service Icon */}
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: 20,
                backgroundColor: 'rgba(57, 197, 187, 0.2)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Ionicons name={icon as any} size={40} color={COLORS.cyan} />
            </View>

            <Text style={{ color: COLORS.text, fontSize: 24, fontWeight: '700', marginBottom: 4 }}>
              {serviceName}
            </Text>
            <Text style={{ color: COLORS.textMuted, fontSize: 14, marginBottom: 16 }}>
              Subscription via Stream Secure
            </Text>

            {/* Price */}
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
              <Text style={{ color: COLORS.cyan, fontSize: 36, fontWeight: '700' }}>
                {price}
              </Text>
              <Text style={{ color: COLORS.textMuted, fontSize: 16 }}>
                SOL/{frequency}
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Duration Selection */}
        <Animated.View entering={FadeInDown.delay(100).duration(300)} style={{ marginTop: 24 }}>
          <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600', marginBottom: 12 }}>
            Subscription Duration
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {(['1', '6', '12'] as const).map((duration) => {
              const isSelected = selectedDuration === duration;
              const months = parseInt(duration);
              const total = (price * months).toFixed(4);

              return (
                <TouchableOpacity
                  key={duration}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelectedDuration(duration);
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${months} ${months === 1 ? 'month' : 'months'}${months > 1 ? ', save 10%' : ''}`}
                  accessibilityState={{ selected: isSelected }}
                  style={{
                    flex: 1,
                    padding: 16,
                    borderRadius: 12,
                    backgroundColor: isSelected ? COLORS.cyan : COLORS.surface,
                    borderWidth: 1,
                    borderColor: isSelected ? COLORS.cyan : COLORS.border,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{
                    color: isSelected ? COLORS.void : COLORS.text,
                    fontSize: 18,
                    fontWeight: '700',
                  }}>
                    {months}
                  </Text>
                  <Text style={{
                    color: isSelected ? COLORS.void : COLORS.textMuted,
                    fontSize: 11,
                    marginTop: 2,
                  }}>
                    {months === 1 ? 'month' : 'months'}
                  </Text>
                  {months > 1 && (
                    <View style={{
                      marginTop: 8,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      backgroundColor: isSelected ? 'rgba(10, 10, 12, 0.3)' : 'rgba(0, 255, 136, 0.2)',
                      borderRadius: 4,
                    }}>
                      <Text style={{
                        color: isSelected ? COLORS.void : COLORS.green,
                        fontSize: 9,
                        fontWeight: '500',
                      }}>
                        SAVE 10%
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>

        {/* Payment Method */}
        <Animated.View entering={FadeInDown.delay(200).duration(300)} style={{ marginTop: 24 }}>
          <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600', marginBottom: 12 }}>
            Pay With
          </Text>
          <View style={{ gap: 10 }}>
            {/* Normal Wallet Option */}
            <TouchableOpacity
              onPress={() => {
                Haptics.selectionAsync();
                setUseZkPool(false);
              }}
              activeOpacity={0.7}
              accessibilityRole="radio"
              accessibilityLabel="Pay with wallet"
              accessibilityState={{ selected: !useZkPool }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                padding: 16,
                backgroundColor: !useZkPool ? 'rgba(57, 197, 187, 0.12)' : COLORS.surface,
                borderRadius: 12,
                borderWidth: 1.5,
                borderColor: !useZkPool ? COLORS.cyan : COLORS.border,
              }}
            >
              {/* Radio */}
              <View style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                borderWidth: 2,
                borderColor: !useZkPool ? COLORS.cyan : COLORS.textDim,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {!useZkPool && (
                  <View style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    backgroundColor: COLORS.cyan,
                  }} />
                )}
              </View>

              <View style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                backgroundColor: !useZkPool ? 'rgba(57, 197, 187, 0.2)' : 'rgba(42, 42, 48, 0.5)',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons name="wallet" size={22} color={!useZkPool ? COLORS.cyan : COLORS.textMuted} />
              </View>

              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '600' }}>
                  Wallet
                </Text>
                <Text style={{ color: COLORS.textMuted, fontSize: 12, marginTop: 2 }}>
                  Pay directly from your connected wallet
                </Text>
              </View>
            </TouchableOpacity>

            {/* Private Wallet (ZK) Option */}
            <TouchableOpacity
              onPress={() => {
                Haptics.selectionAsync();
                setUseZkPool(true);
                if (!enablePrivacy) setEnablePrivacy(true);
              }}
              activeOpacity={0.7}
              accessibilityRole="radio"
              accessibilityLabel="Pay with private wallet via ZK proof"
              accessibilityState={{ selected: useZkPool }}
              style={{
                padding: 16,
                backgroundColor: useZkPool ? 'rgba(255, 119, 168, 0.12)' : COLORS.surface,
                borderRadius: 12,
                borderWidth: 1.5,
                borderColor: useZkPool ? COLORS.pink : COLORS.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                {/* Radio */}
                <View style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 2,
                  borderColor: useZkPool ? COLORS.pink : COLORS.textDim,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  {useZkPool && (
                    <View style={{
                      width: 12,
                      height: 12,
                      borderRadius: 6,
                      backgroundColor: COLORS.pink,
                    }} />
                  )}
                </View>

                <View style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  backgroundColor: useZkPool ? 'rgba(255, 119, 168, 0.2)' : 'rgba(42, 42, 48, 0.5)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Ionicons name="eye-off" size={22} color={useZkPool ? COLORS.pink : COLORS.textMuted} />
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '600' }}>
                    Private Wallet
                  </Text>
                  <Text style={{ color: COLORS.textMuted, fontSize: 12, marginTop: 2 }}>
                    Pay anonymously via ZK proof
                  </Text>
                </View>

                {/* ZK Badge */}
                <View style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  backgroundColor: useZkPool ? 'rgba(255, 119, 168, 0.25)' : 'rgba(42, 42, 48, 0.5)',
                  borderRadius: 6,
                }}>
                  <Text style={{
                    color: useZkPool ? COLORS.pink : COLORS.textDim,
                    fontSize: 10,
                    fontWeight: '700',
                  }}>ZK</Text>
                </View>
              </View>

              {/* Private Balance Details (shown when selected) */}
              {useZkPool && (
                <View style={{
                  marginTop: 14,
                  paddingTop: 14,
                  borderTopWidth: 1,
                  borderTopColor: 'rgba(255, 119, 168, 0.2)',
                }}>
                  {/* Balance row */}
                  <View style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: 12,
                    backgroundColor: 'rgba(255, 119, 168, 0.06)',
                    borderRadius: 10,
                  }}>
                    <View>
                      <Text style={{ color: COLORS.textMuted, fontSize: 11 }}>Private Balance</Text>
                      <Text style={{
                        color: COLORS.text,
                        fontSize: 18,
                        fontWeight: '700',
                        marginTop: 2,
                      }}>
                        {privateBalance < 1 ? privateBalance.toFixed(4) : privateBalance.toFixed(2)} SOL
                      </Text>
                      <Text style={{ color: COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                        {availableNotes.length} shielded note{availableNotes.length !== 1 ? 's' : ''}
                      </Text>
                    </View>
                    <View style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      backgroundColor: privateBalance >= totalPrice
                        ? 'rgba(0, 255, 136, 0.15)'
                        : 'rgba(255, 51, 102, 0.15)',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <Ionicons
                        name={privateBalance >= totalPrice ? 'checkmark-circle' : 'alert-circle'}
                        size={22}
                        color={privateBalance >= totalPrice ? COLORS.green : COLORS.red}
                      />
                    </View>
                  </View>

                  {privateBalance < totalPrice && (
                    <TouchableOpacity
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        router.push('/(main)/(privacy)/denominated-notes' as any);
                      }}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="Shield more SOL"
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        marginTop: 10,
                        paddingVertical: 10,
                        backgroundColor: COLORS.pink,
                        borderRadius: 8,
                      }}
                    >
                      <Ionicons name="add-circle" size={16} color={COLORS.void} />
                      <Text style={{ color: COLORS.void, fontSize: 12, fontWeight: '600' }}>
                        Shield More SOL
                      </Text>
                    </TouchableOpacity>
                  )}

                  <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 10,
                    padding: 8,
                    backgroundColor: 'rgba(255, 119, 168, 0.06)',
                    borderRadius: 8,
                  }}>
                    <Ionicons name="lock-closed" size={12} color={COLORS.pink} />
                    <Text style={{ color: COLORS.textMuted, fontSize: 11, flex: 1 }}>
                      Paid from your shielded notes via ZK proof. No one can trace this payment back to you.
                    </Text>
                  </View>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Privacy Shield Toggle (additional for normal wallet) */}
        {!useZkPool && (
          <Animated.View entering={FadeInDown.delay(250).duration(300)} style={{ marginTop: 16 }}>
            <TouchableOpacity
              onPress={() => {
                Haptics.selectionAsync();
                setEnablePrivacy(!enablePrivacy);
              }}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityLabel="Privacy Shield"
              accessibilityState={{ checked: enablePrivacy }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                padding: 16,
                backgroundColor: enablePrivacy ? 'rgba(57, 197, 187, 0.15)' : COLORS.surface,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: enablePrivacy ? 'rgba(57, 197, 187, 0.4)' : COLORS.border,
              }}
            >
              <View style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                backgroundColor: enablePrivacy ? 'rgba(57, 197, 187, 0.2)' : 'rgba(42, 42, 48, 0.5)',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons
                  name="shield-checkmark"
                  size={22}
                  color={enablePrivacy ? COLORS.cyan : COLORS.textMuted}
                />
              </View>

              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '600' }}>
                  Privacy Shield
                </Text>
                <Text style={{ color: COLORS.textMuted, fontSize: 12, marginTop: 2 }}>
                  Amount noise, timing noise & stealth addresses
                </Text>
              </View>

              <View style={{
                width: 48,
                height: 28,
                borderRadius: 14,
                backgroundColor: enablePrivacy ? COLORS.cyan : COLORS.border,
                justifyContent: 'center',
                padding: 2,
              }}>
                <View style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: COLORS.text,
                  alignSelf: enablePrivacy ? 'flex-end' : 'flex-start',
                }} />
              </View>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Summary */}
        <Animated.View entering={FadeInDown.delay(300).duration(300)} style={{ marginTop: 24 }}>
          <View style={{
            backgroundColor: COLORS.surface,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: COLORS.border,
          }}>
            <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600', marginBottom: 12 }}>
              Summary
            </Text>

            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: COLORS.textMuted, fontSize: 13 }}>
                  {serviceName} ({durationMonths} {durationMonths === 1 ? 'month' : 'months'})
                </Text>
                <Text style={{ color: COLORS.text, fontSize: 13 }}>
                  {(price * durationMonths).toFixed(4)} SOL
                </Text>
              </View>

              {savings && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: COLORS.green, fontSize: 13 }}>
                    Duration discount (10%)
                  </Text>
                  <Text style={{ color: COLORS.green, fontSize: 13 }}>
                    -{savings} SOL
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: COLORS.textMuted, fontSize: 13 }}>
                  Payment Method
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons
                    name={useZkPool ? 'eye-off' : 'wallet'}
                    size={12}
                    color={useZkPool ? COLORS.pink : COLORS.cyan}
                  />
                  <Text style={{ color: useZkPool ? COLORS.pink : COLORS.cyan, fontSize: 13, fontWeight: '500' }}>
                    {useZkPool ? 'Private Wallet' : 'Wallet'}
                  </Text>
                </View>
              </View>

              {enablePrivacy && !useZkPool && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: COLORS.cyan, fontSize: 13 }}>
                    Privacy Shield
                  </Text>
                  <Text style={{ color: COLORS.cyan, fontSize: 13 }}>
                    Enabled
                  </Text>
                </View>
              )}

              <View style={{
                marginTop: 8,
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: COLORS.border,
                flexDirection: 'row',
                justifyContent: 'space-between',
              }}>
                <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600' }}>
                  Total
                </Text>
                <Text style={{ color: COLORS.cyan, fontSize: 15, fontWeight: '700' }}>
                  {savings
                    ? (price * durationMonths * 0.9).toFixed(4)
                    : (price * durationMonths).toFixed(4)
                  } SOL
                </Text>
              </View>
            </View>
          </View>
        </Animated.View>

        {/* Features */}
        <Animated.View entering={FadeInDown.delay(400).duration(300)} style={{ marginTop: 16 }}>
          <View style={{ gap: 8 }}>
            {[
              { icon: 'checkmark-circle', text: 'Cancel anytime, no penalties', color: COLORS.green },
              { icon: 'shield-checkmark', text: 'Protected by Stream Secure', color: COLORS.cyan },
              { icon: 'sync', text: 'Automatic recurring payments', color: COLORS.cyan },
              ...(useZkPool ? [
                { icon: 'eye-off', text: 'Zero-knowledge proof hides your identity', color: COLORS.pink },
                { icon: 'lock-closed', text: 'Merchant cannot trace the payment source', color: COLORS.pink },
              ] : []),
            ].map((feature, index) => (
              <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name={feature.icon as any} size={16} color={feature.color} />
                <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>{feature.text}</Text>
              </View>
            ))}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Subscribe Button */}
      <View style={{
        padding: 16,
        paddingBottom: insets.bottom + 100,
        borderTopWidth: 1,
        borderTopColor: COLORS.border,
        backgroundColor: COLORS.void,
      }}>
        <TouchableOpacity
          onPress={handleSubscribe}
          disabled={isSubscribing || (useZkPool && privateBalance < totalPrice)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={useZkPool ? `Subscribe privately to ${serviceName}` : `Subscribe to ${serviceName}`}
          accessibilityState={{ disabled: isSubscribing || (useZkPool && privateBalance < totalPrice) }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            paddingVertical: 16,
            backgroundColor: isSubscribing
              ? COLORS.cyanDim
              : (useZkPool && privateBalance < totalPrice)
                ? COLORS.border
                : useZkPool
                  ? COLORS.pink
                  : COLORS.cyan,
            borderRadius: 12,
          }}
        >
          {isSubscribing ? (
            <View style={{ alignItems: 'center', gap: 4 }}>
              <ActivityIndicator size="small" color={COLORS.void} />
              {progressMessage && (
                <Text style={{ color: COLORS.void, fontSize: 11, fontWeight: '500', opacity: 0.8 }}>
                  {progressMessage}
                </Text>
              )}
            </View>
          ) : (
            <>
              <Ionicons
                name={useZkPool ? 'eye-off' : 'checkmark-circle'}
                size={22}
                color={COLORS.void}
              />
              <Text style={{ color: COLORS.void, fontSize: 16, fontWeight: '700' }}>
                {useZkPool ? `Subscribe Privately` : `Subscribe to ${serviceName}`}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}
