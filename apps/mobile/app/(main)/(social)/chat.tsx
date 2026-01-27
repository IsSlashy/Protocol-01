import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown, FadeIn, SlideInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useMeshStore } from '@/stores/meshStore';
import { useMessageStore } from '@/stores/messageStore';
import { useWalletStore } from '@/stores/walletStore';
import { usePayments } from '@/hooks/social/usePayments';
import { useMessages } from '@/hooks/social/useMessages';
import { PaymentBubble } from '@/components/social/PaymentBubble';
import { TokenSelector } from '@/components/social/TokenSelector';
import {
  ChatPaymentMessage,
  SupportedToken,
  validatePaymentAmount,
  formatPaymentAmount,
} from '@/services/payments/paymentRequest';

// Theme colors
const COLORS = {
  primary: '#00ff88',
  cyan: '#00D1FF',
  pink: '#FF6B9D',
  purple: '#9945FF',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  surfaceTertiary: '#1a1a1a',
  border: '#1f1f1f',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
};

type PaymentModalType = 'request' | 'send' | null;

export default function MeshChatScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { peerId, peerAlias, peerAddress, encryptionKey } = useLocalSearchParams<{
    peerId: string;
    peerAlias: string;
    peerAddress?: string;
    encryptionKey?: string;
  }>();
  const scrollViewRef = useRef<ScrollView>(null);

  const [inputText, setInputText] = useState('');
  const [paymentModalType, setPaymentModalType] = useState<PaymentModalType>(null);
  const [selectedToken, setSelectedToken] = useState<SupportedToken>('SOL');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [useEncryptedMessaging, setUseEncryptedMessaging] = useState(false);

  const {
    identity,
    messages: meshMessages,
    nearbyPeers,
    trustedPeers,
    loadMessages: loadMeshMessages,
    sendMessage: sendMeshMessage,
    markAsRead: markMeshAsRead,
  } = useMeshStore();

  const { publicKey, balance } = useWalletStore();

  // E2E Encrypted messaging hook
  const {
    messages: encryptedMessages,
    conversation,
    isSending,
    error: messageError,
    isEncryptionReady,
    myEncryptionPublicKey,
    sendTextMessage,
    sendPaymentRequest: sendEncryptedPaymentRequest,
    sendPaymentSent: sendEncryptedPaymentSent,
    markAsRead: markEncryptedAsRead,
    initializeEncryption,
    setContactEncryptionKey,
  } = useMessages({
    contactAddress: peerAddress || '',
    autoDecrypt: true
  });

  const {
    isProcessing,
    error: paymentError,
    tokenBalances,
    createRequest,
    payPaymentRequest,
    declinePaymentRequest,
    sendPayment,
    getChatMessagesForPeer,
    clearError,
  } = usePayments();

  const peer = nearbyPeers.find((p) => p.id === peerId) ||
    trustedPeers.find((p) => p.id === peerId);

  const chatMessages = useEncryptedMessaging
    ? encryptedMessages
    : meshMessages[peerId || ''] || [];
  const recipientAddress = peerAddress || peer?.publicKey || '';

  // Initialize encryption when component mounts
  useEffect(() => {
    if (peerAddress && encryptionKey) {
      setUseEncryptedMessaging(true);
      initializeEncryption();
      setContactEncryptionKey(encryptionKey);
    }
  }, [peerAddress, encryptionKey]);

  // Show message error if any
  useEffect(() => {
    if (messageError) {
      Alert.alert('Message Error', messageError);
    }
  }, [messageError]);

  // Get payment messages for this chat
  const paymentMessages = getChatMessagesForPeer(recipientAddress);

  useEffect(() => {
    if (peerId) {
      if (useEncryptedMessaging) {
        markEncryptedAsRead();
      } else {
        loadMeshMessages(peerId);
        markMeshAsRead(peerId);
      }
    }
  }, [peerId, useEncryptedMessaging]);

  useEffect(() => {
    if (paymentError) {
      Alert.alert('Payment Error', paymentError, [
        { text: 'OK', onPress: clearError },
      ]);
    }
  }, [paymentError]);

  const handleSend = async () => {
    if (!inputText.trim() || !peerId) return;

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    // Use encrypted messaging if available, otherwise fall back to mesh
    if (useEncryptedMessaging && isEncryptionReady) {
      await sendTextMessage(inputText.trim());
    } else {
      await sendMeshMessage(peerId, inputText.trim());
    }
    setInputText('');

    // Scroll to bottom
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isOnline = peer ? Date.now() - peer.lastSeen < 60000 : false;

  // Payment modal handlers
  const openPaymentModal = (type: PaymentModalType) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setPaymentModalType(type);
    setPaymentAmount('');
    setPaymentNote('');
    setSelectedToken('SOL');
  };

  const closePaymentModal = () => {
    setPaymentModalType(null);
    setPaymentAmount('');
    setPaymentNote('');
  };

  const handleCreatePaymentRequest = async () => {
    if (!recipientAddress) {
      Alert.alert('Error', 'Peer wallet address not available');
      return;
    }

    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    const result = await createRequest({
      recipientAddress,
      amount,
      token: selectedToken,
      note: paymentNote || undefined,
    });

    if (result) {
      closePaymentModal();
      // Send message about the payment request
      if (useEncryptedMessaging && isEncryptionReady) {
        await sendEncryptedPaymentRequest(amount, 'SOL', selectedToken, paymentNote || undefined);
      } else {
        await sendMeshMessage(
          peerId!,
          `Payment Request: ${formatPaymentAmount(amount, selectedToken)}${paymentNote ? ` - ${paymentNote}` : ''}`
        );
      }
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  };

  const handleSendPayment = async () => {
    if (!recipientAddress) {
      Alert.alert('Error', 'Peer wallet address not available');
      return;
    }

    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }

    // Validate balance
    const tokenBalance = tokenBalances[selectedToken]?.balance || 0;
    const validation = validatePaymentAmount(amount, tokenBalance, selectedToken);
    if (!validation.valid) {
      Alert.alert('Error', validation.error || 'Invalid amount');
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }

    const result = await sendPayment({
      recipientAddress,
      amount,
      token: selectedToken,
      note: paymentNote || undefined,
    });

    if (result) {
      closePaymentModal();
      // Send message about the payment
      if (useEncryptedMessaging && isEncryptionReady) {
        await sendEncryptedPaymentSent(amount, 'SOL', selectedToken, result.txSignature || '', paymentNote || undefined);
      } else {
        await sendMeshMessage(
          peerId!,
          `Sent ${formatPaymentAmount(amount, selectedToken)}${paymentNote ? ` - ${paymentNote}` : ''}`
        );
      }
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  };

  const handlePayRequest = async (message: ChatPaymentMessage) => {
    // Find the actual payment request
    const request = {
      id: message.id,
      requesterId: message.senderId,
      recipientId: message.recipientId,
      amount: message.amount,
      token: message.token,
      tokenMint: message.tokenMint,
      note: message.note,
      status: message.status,
      createdAt: message.timestamp,
      expiresAt: message.expiresAt,
    };

    // Validate balance
    const tokenBalance = tokenBalances[message.token as SupportedToken]?.balance || 0;
    const validation = validatePaymentAmount(message.amount, tokenBalance, message.token);
    if (!validation.valid) {
      Alert.alert('Insufficient Balance', validation.error || 'Cannot complete payment');
      return;
    }

    Alert.alert(
      'Confirm Payment',
      `Pay ${formatPaymentAmount(message.amount, message.token)} to ${peerAlias}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay',
          onPress: async () => {
            if (Platform.OS !== 'web') {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            }
            const result = await payPaymentRequest(request as any);
            if (useEncryptedMessaging && isEncryptionReady) {
              await sendEncryptedPaymentSent(message.amount, message.tokenMint || 'SOL', message.token, result?.txSignature || '');
            } else {
              await sendMeshMessage(
                peerId!,
                `Paid ${formatPaymentAmount(message.amount, message.token)}`
              );
            }
          },
        },
      ]
    );
  };

  const handleDeclineRequest = async (message: ChatPaymentMessage) => {
    const request = {
      id: message.id,
      requesterId: message.senderId,
      recipientId: message.recipientId,
      amount: message.amount,
      token: message.token,
      tokenMint: message.tokenMint,
      note: message.note,
      status: message.status,
      createdAt: message.timestamp,
      expiresAt: message.expiresAt,
    };

    Alert.alert(
      'Decline Request',
      `Decline payment request for ${formatPaymentAmount(message.amount, message.token)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            if (Platform.OS !== 'web') {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
            await declinePaymentRequest(request as any);
            if (useEncryptedMessaging && isEncryptionReady) {
              await sendTextMessage(`Declined payment request`);
            } else {
              await sendMeshMessage(peerId!, `Declined payment request`);
            }
          },
        },
      ]
    );
  };

  // Combine regular messages with payment messages
  // Handle both encrypted message format and mesh message format
  const normalizedChatMessages = chatMessages.map((msg: any) => ({
    id: msg.id,
    timestamp: msg.timestamp,
    content: msg.decryptedContent || msg.content || '[Encrypted]',
    // For encrypted messages, check sender. For mesh messages, check fromId
    fromId: msg.sender || msg.fromId,
    isPayment: msg.type === 'payment_request' || msg.type === 'payment_sent' || false,
    type: msg.type,
    paymentData: msg.paymentData,
  }));

  const allMessages = [
    ...normalizedChatMessages.filter((msg: any) => !msg.isPayment),
    ...paymentMessages.map((msg) => ({ ...msg, isPayment: true })),
    ...normalizedChatMessages.filter((msg: any) => msg.isPayment),
  ].sort((a, b) => a.timestamp - b.timestamp);

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      {/* Header */}
      <Animated.View
        entering={FadeIn}
        style={{
          paddingTop: insets.top,
          paddingHorizontal: 16,
          paddingBottom: 12,
          backgroundColor: COLORS.surface,
          borderBottomWidth: 1,
          borderBottomColor: COLORS.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 8,
            }}
          >
            <Ionicons name="chevron-back" size={24} color={COLORS.text} />
          </TouchableOpacity>

          {/* Avatar */}
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: COLORS.cyan + '20',
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 12,
            }}
          >
            <Text style={{ color: COLORS.cyan, fontSize: 16, fontWeight: 'bold' }}>
              {peerAlias?.charAt(0) || '?'}
            </Text>
            {isOnline && (
              <View
                style={{
                  position: 'absolute',
                  bottom: 0,
                  right: 0,
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: COLORS.primary,
                  borderWidth: 2,
                  borderColor: COLORS.surface,
                }}
              />
            )}
          </View>

          {/* Info */}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '600' }}>
                {peerAlias || 'Unknown'}
              </Text>
              {peer?.isTrusted && (
                <Ionicons
                  name="shield-checkmark"
                  size={14}
                  color={COLORS.primary}
                  style={{ marginLeft: 6 }}
                />
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
              <Ionicons
                name="radio"
                size={10}
                color={isOnline ? COLORS.primary : COLORS.textTertiary}
              />
              <Text
                style={{
                  color: isOnline ? COLORS.primary : COLORS.textTertiary,
                  fontSize: 11,
                  marginLeft: 4,
                }}
              >
                {isOnline ? 'Connected via mesh' : 'Offline'}
              </Text>
            </View>
          </View>

          {/* Actions */}
          <TouchableOpacity
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: COLORS.surfaceSecondary,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Ionicons name="ellipsis-vertical" size={18} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* Encryption notice */}
      <Animated.View
        entering={FadeInDown.delay(100)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: 8,
          backgroundColor: isEncryptionReady && useEncryptedMessaging
            ? COLORS.primary + '10'
            : COLORS.cyan + '10',
        }}
      >
        <Ionicons
          name={isEncryptionReady && useEncryptedMessaging ? 'lock-closed' : 'radio'}
          size={12}
          color={isEncryptionReady && useEncryptedMessaging ? COLORS.primary : COLORS.cyan}
        />
        <Text
          style={{
            color: isEncryptionReady && useEncryptedMessaging ? COLORS.primary : COLORS.cyan,
            fontSize: 11,
            marginLeft: 6,
          }}
        >
          {isEncryptionReady && useEncryptedMessaging
            ? 'Messages are end-to-end encrypted'
            : 'Messages transmitted via Bluetooth mesh'}
        </Text>
      </Animated.View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >
        {/* Messages */}
        <ScrollView
          ref={scrollViewRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: false })}
        >
          {allMessages.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  backgroundColor: COLORS.surfaceSecondary,
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
                <Ionicons
                  name="chatbubble-ellipses-outline"
                  size={28}
                  color={COLORS.textTertiary}
                />
              </View>
              <Text
                style={{ color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' }}
              >
                Start your encrypted conversation
              </Text>
              <Text
                style={{
                  color: COLORS.textTertiary,
                  fontSize: 12,
                  textAlign: 'center',
                  marginTop: 4,
                }}
              >
                Messages are transmitted via Bluetooth mesh
              </Text>
            </View>
          ) : (
            allMessages.map((msg, index) => {
              // Payment message
              if ('isPayment' in msg && msg.isPayment) {
                const paymentMsg = msg as ChatPaymentMessage & { isPayment: boolean };
                const isMe = paymentMsg.senderId === publicKey;
                return (
                  <PaymentBubble
                    key={paymentMsg.id}
                    message={paymentMsg}
                    isOwn={isMe}
                    onPay={handlePayRequest}
                    onDecline={handleDeclineRequest}
                    isProcessing={isProcessing}
                  />
                );
              }

              // Regular message - cast to expected type
              const regularMsg = msg as { id: string; timestamp: number; content: string; fromId: string };
              // For encrypted messages, check against wallet publicKey. For mesh, check against identity.id
              const isMe = useEncryptedMessaging
                ? regularMsg.fromId === publicKey
                : regularMsg.fromId === identity?.id;
              const showTimestamp =
                index === 0 ||
                allMessages[index - 1].timestamp < msg.timestamp - 300000;

              return (
                <Animated.View key={msg.id} entering={FadeInDown.delay(index * 30)}>
                  {showTimestamp && (
                    <Text
                      style={{
                        color: COLORS.textTertiary,
                        fontSize: 11,
                        textAlign: 'center',
                        marginVertical: 12,
                      }}
                    >
                      {formatTime(msg.timestamp)}
                    </Text>
                  )}

                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: isMe ? 'flex-end' : 'flex-start',
                      marginBottom: 8,
                    }}
                  >
                    <View
                      style={{
                        maxWidth: '80%',
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: 18,
                        borderBottomRightRadius: isMe ? 4 : 18,
                        borderBottomLeftRadius: isMe ? 18 : 4,
                        backgroundColor: isMe ? COLORS.cyan : COLORS.surfaceTertiary,
                      }}
                    >
                      <Text
                        style={{
                          color: isMe ? '#000' : COLORS.text,
                          fontSize: 15,
                          lineHeight: 20,
                        }}
                      >
                        {regularMsg.content}
                      </Text>
                    </View>
                  </View>
                </Animated.View>
              );
            })
          )}
        </ScrollView>

        {/* Input Bar */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            backgroundColor: COLORS.surface,
            borderTopWidth: 1,
            borderTopColor: COLORS.border,
          }}
        >
          {/* Payment Actions */}
          <View style={{ flexDirection: 'row', marginRight: 8, gap: 4 }}>
            {/* Request Payment Button */}
            <TouchableOpacity
              onPress={() => openPaymentModal('request')}
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: COLORS.pink + '20',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons name="cash-outline" size={20} color={COLORS.pink} />
            </TouchableOpacity>

            {/* Send Payment Button */}
            <TouchableOpacity
              onPress={() => openPaymentModal('send')}
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: COLORS.primary + '20',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons name="send-outline" size={18} color={COLORS.primary} />
            </TouchableOpacity>
          </View>

          {/* Text Input */}
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'flex-end',
              backgroundColor: COLORS.surfaceSecondary,
              borderRadius: 22,
              borderWidth: 1,
              borderColor: COLORS.border,
              paddingHorizontal: 16,
              paddingVertical: 8,
              minHeight: 44,
              maxHeight: 120,
            }}
          >
            <TextInput
              style={{
                flex: 1,
                color: COLORS.text,
                fontSize: 15,
                maxHeight: 100,
                paddingTop: 0,
                paddingBottom: 0,
              }}
              placeholder="Message..."
              placeholderTextColor={COLORS.textTertiary}
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={1000}
            />
          </View>

          {/* Send Button */}
          <TouchableOpacity
            onPress={handleSend}
            disabled={!inputText.trim()}
            style={{ marginLeft: 8 }}
          >
            <LinearGradient
              colors={
                inputText.trim()
                  ? [COLORS.cyan, COLORS.purple]
                  : [COLORS.surfaceSecondary, COLORS.surfaceSecondary]
              }
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons
                name="send"
                size={18}
                color={inputText.trim() ? '#000' : COLORS.textTertiary}
              />
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Payment Modal */}
      <PaymentModal
        visible={paymentModalType !== null}
        type={paymentModalType}
        onClose={closePaymentModal}
        selectedToken={selectedToken}
        onSelectToken={setSelectedToken}
        amount={paymentAmount}
        onChangeAmount={setPaymentAmount}
        note={paymentNote}
        onChangeNote={setPaymentNote}
        tokenBalances={tokenBalances}
        onSubmit={
          paymentModalType === 'request'
            ? handleCreatePaymentRequest
            : handleSendPayment
        }
        isProcessing={isProcessing}
        peerAlias={peerAlias || 'Unknown'}
      />
    </View>
  );
}

// Payment Modal Component
interface PaymentModalProps {
  visible: boolean;
  type: PaymentModalType;
  onClose: () => void;
  selectedToken: SupportedToken;
  onSelectToken: (token: SupportedToken) => void;
  amount: string;
  onChangeAmount: (amount: string) => void;
  note: string;
  onChangeNote: (note: string) => void;
  tokenBalances: Record<string, { symbol: string; balance: number; usdValue?: number }>;
  onSubmit: () => void;
  isProcessing: boolean;
  peerAlias: string;
}

const PaymentModal: React.FC<PaymentModalProps> = ({
  visible,
  type,
  onClose,
  selectedToken,
  onSelectToken,
  amount,
  onChangeAmount,
  note,
  onChangeNote,
  tokenBalances,
  onSubmit,
  isProcessing,
  peerAlias,
}) => {
  if (!visible) return null;

  const isRequest = type === 'request';
  const title = isRequest ? 'Request Payment' : 'Send Payment';
  const submitText = isRequest ? 'Create Request' : 'Send';
  const submitColor = isRequest ? COLORS.pink : COLORS.primary;

  const tokenBalance = tokenBalances[selectedToken]?.balance || 0;
  const numericAmount = parseFloat(amount) || 0;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        {/* Backdrop */}
        <TouchableOpacity
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
          }}
          activeOpacity={1}
          onPress={onClose}
        />

        {/* Sheet */}
        <Animated.View
          entering={SlideInDown.duration(300)}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: COLORS.surface,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingBottom: Platform.OS === 'ios' ? 40 : 20,
          }}
        >
          {/* Handle */}
          <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 8 }}>
            <View
              style={{
                width: 40,
                height: 4,
                backgroundColor: COLORS.border,
                borderRadius: 2,
              }}
            />
          </View>

          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 20,
              paddingVertical: 16,
              borderBottomWidth: 1,
              borderBottomColor: COLORS.border,
            }}
          >
            <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600' }}>
              {title}
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Content */}
          <View style={{ padding: 20 }}>
            {/* Recipient */}
            <View style={{ marginBottom: 20 }}>
              <Text style={{ color: COLORS.textSecondary, fontSize: 13, marginBottom: 8 }}>
                {isRequest ? 'Request from' : 'Send to'}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: 14,
                  backgroundColor: COLORS.surfaceSecondary,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                }}
              >
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: COLORS.cyan + '20',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: 12,
                  }}
                >
                  <Text style={{ color: COLORS.cyan, fontWeight: 'bold' }}>
                    {peerAlias.charAt(0)}
                  </Text>
                </View>
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>
                  {peerAlias}
                </Text>
              </View>
            </View>

            {/* Token Selector */}
            <View style={{ marginBottom: 20 }}>
              <Text style={{ color: COLORS.textSecondary, fontSize: 13, marginBottom: 8 }}>
                Token
              </Text>
              <TokenSelector
                selectedToken={selectedToken}
                onSelectToken={onSelectToken}
                balances={tokenBalances}
              />
            </View>

            {/* Amount */}
            <View style={{ marginBottom: 20 }}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <Text style={{ color: COLORS.textSecondary, fontSize: 13 }}>Amount</Text>
                {!isRequest && (
                  <Text style={{ color: COLORS.textSecondary, fontSize: 13 }}>
                    Balance: {tokenBalance.toFixed(4)} {selectedToken}
                  </Text>
                )}
              </View>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: COLORS.surfaceSecondary,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                  paddingHorizontal: 16,
                }}
              >
                <TextInput
                  style={{
                    flex: 1,
                    color: COLORS.text,
                    fontSize: 24,
                    fontWeight: 'bold',
                    paddingVertical: 16,
                  }}
                  placeholder="0.00"
                  placeholderTextColor={COLORS.textTertiary}
                  value={amount}
                  onChangeText={(text) => {
                    const cleaned = text.replace(/[^0-9.]/g, '');
                    onChangeAmount(cleaned);
                  }}
                  keyboardType="decimal-pad"
                />
                <Text style={{ color: COLORS.textSecondary, fontSize: 16, fontWeight: '600' }}>
                  {selectedToken}
                </Text>
              </View>

              {/* Quick amount buttons for send */}
              {!isRequest && tokenBalance > 0 && (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  {[25, 50, 75, 100].map((percent) => (
                    <TouchableOpacity
                      key={percent}
                      onPress={() => {
                        const value = (tokenBalance * percent) / 100;
                        onChangeAmount(value.toFixed(4));
                      }}
                      style={{
                        flex: 1,
                        paddingVertical: 8,
                        backgroundColor: COLORS.surfaceTertiary,
                        borderRadius: 10,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ color: COLORS.cyan, fontSize: 13, fontWeight: '500' }}>
                        {percent}%
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Note */}
            <View style={{ marginBottom: 24 }}>
              <Text style={{ color: COLORS.textSecondary, fontSize: 13, marginBottom: 8 }}>
                Note (optional)
              </Text>
              <TextInput
                style={{
                  backgroundColor: COLORS.surfaceSecondary,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  color: COLORS.text,
                  fontSize: 15,
                }}
                placeholder="Add a note..."
                placeholderTextColor={COLORS.textTertiary}
                value={note}
                onChangeText={onChangeNote}
                maxLength={100}
              />
            </View>

            {/* Submit Button */}
            <TouchableOpacity
              onPress={onSubmit}
              disabled={!numericAmount || isProcessing}
              style={{
                backgroundColor: numericAmount ? submitColor : COLORS.surfaceTertiary,
                borderRadius: 16,
                paddingVertical: 16,
                alignItems: 'center',
                opacity: numericAmount && !isProcessing ? 1 : 0.5,
              }}
            >
              {isProcessing ? (
                <Text style={{ color: COLORS.background, fontSize: 16, fontWeight: '600' }}>
                  Processing...
                </Text>
              ) : (
                <Text style={{ color: COLORS.background, fontSize: 16, fontWeight: '600' }}>
                  {submitText}{' '}
                  {numericAmount > 0 && formatPaymentAmount(numericAmount, selectedToken)}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
};
