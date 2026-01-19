import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  Modal,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useContactsStore, SUPPORTED_CURRENCIES, Message, formatAddress } from '@/stores/contactsStore';

const COLORS = {
  primary: '#00ff88',
  cyan: '#00D1FF',
  purple: '#9945FF',
  orange: '#f59e0b',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  border: '#1f1f1f',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
  error: '#ef4444',
  success: '#22c55e',
  warning: '#f59e0b',
};

export default function ConversationScreen() {
  const { contactId } = useLocalSearchParams<{ contactId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);

  const {
    contacts,
    messages,
    loadMessages,
    sendMessage,
    markAsRead,
    createPaymentRequest,
    respondToPaymentRequest,
  } = useContactsStore();

  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [selectedCurrency, setSelectedCurrency] = useState(SUPPORTED_CURRENCIES[0]);
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);

  const contact = contacts.find(c => c.id === contactId);
  const contactMessages = messages[contactId || ''] || [];

  useEffect(() => {
    if (contactId) {
      loadMessages(contactId);
      markAsRead(contactId);
    }
  }, [contactId]);

  useEffect(() => {
    if (contactMessages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [contactMessages.length]);

  if (!contact) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.background, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: COLORS.textSecondary }}>Contact not found</Text>
      </View>
    );
  }

  const handleSend = async () => {
    if (!inputText.trim()) return;

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    setIsSending(true);
    try {
      await sendMessage(contactId!, inputText.trim());
      setInputText('');
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handleSendPayment = async () => {
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    try {
      await createPaymentRequest(
        contact.address,
        amount,
        selectedCurrency.symbol,
        paymentNote.trim() || undefined
      );

      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      setShowPaymentModal(false);
      setPaymentAmount('');
      setPaymentNote('');
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to send payment request');
    }
  };

  const handlePaymentResponse = async (message: Message, accept: boolean) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    try {
      if (message.paymentData) {
        // Find the payment request ID from the message content
        try {
          const parsed = JSON.parse(message.content.replace('Payment request: ', ''));
          if (parsed.requestId) {
            await respondToPaymentRequest(parsed.requestId, accept ? 'pay' : 'cancel');
          }
        } catch {
          // If not parseable, use message content
        }
      }

      if (accept) {
        // Navigate to send screen with pre-filled data
        router.push({
          pathname: '/(main)/(wallet)/send',
          params: {
            recipient: contact.address,
            amount: message.paymentData?.amount.toString(),
            currency: message.paymentData?.currency,
          },
        });
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to respond to payment request');
    }
  };

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    const isOutgoing = item.isOutgoing;
    const isPaymentRequest = item.type === 'payment_request' && item.paymentData;

    return (
      <Animated.View
        entering={FadeInUp.delay(index * 50).springify()}
        style={{
          alignSelf: isOutgoing ? 'flex-end' : 'flex-start',
          maxWidth: '80%',
          marginBottom: 12,
        }}
      >
        {isPaymentRequest ? (
          <View
            style={{
              backgroundColor: COLORS.surfaceSecondary,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: item.paymentData!.status === 'pending'
                ? COLORS.purple + '50'
                : item.paymentData!.status === 'completed'
                ? COLORS.success + '50'
                : COLORS.error + '50',
              overflow: 'hidden',
            }}
          >
            <LinearGradient
              colors={[COLORS.purple + '20', 'transparent']}
              style={{ padding: 16 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: COLORS.purple + '30',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: 10,
                  }}
                >
                  <Ionicons
                    name={isOutgoing ? 'arrow-up' : 'arrow-down'}
                    size={18}
                    color={COLORS.purple}
                  />
                </View>
                <View>
                  <Text style={{ color: COLORS.textSecondary, fontSize: 12 }}>
                    {isOutgoing ? 'Payment Request Sent' : 'Payment Request'}
                  </Text>
                  <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '700' }}>
                    {item.paymentData!.amount} {item.paymentData!.currency}
                  </Text>
                </View>
              </View>

              {item.paymentData!.memo && (
                <Text style={{ color: COLORS.textSecondary, fontSize: 13, marginBottom: 12 }}>
                  "{item.paymentData!.memo}"
                </Text>
              )}

              {item.paymentData!.status === 'pending' && !isOutgoing && (
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                  <TouchableOpacity
                    onPress={() => handlePaymentResponse(item, false)}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 10,
                      backgroundColor: COLORS.error + '20',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: COLORS.error, fontWeight: '600' }}>Decline</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handlePaymentResponse(item, true)}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 10,
                      backgroundColor: COLORS.primary + '20',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: COLORS.primary, fontWeight: '600' }}>Pay</Text>
                  </TouchableOpacity>
                </View>
              )}

              {item.paymentData!.status !== 'pending' && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingTop: 8,
                    borderTopWidth: 1,
                    borderTopColor: COLORS.border,
                    marginTop: 8,
                  }}
                >
                  <Ionicons
                    name={item.paymentData!.status === 'completed' ? 'checkmark-circle' : 'close-circle'}
                    size={16}
                    color={item.paymentData!.status === 'completed' ? COLORS.success : COLORS.error}
                    style={{ marginRight: 6 }}
                  />
                  <Text
                    style={{
                      color: item.paymentData!.status === 'completed' ? COLORS.success : COLORS.error,
                      fontSize: 13,
                      fontWeight: '500',
                    }}
                  >
                    {item.paymentData!.status === 'completed' ? 'Paid' :
                     item.paymentData!.status === 'cancelled' ? 'Declined' : 'Expired'}
                  </Text>
                </View>
              )}
            </LinearGradient>
          </View>
        ) : (
          <View
            style={{
              backgroundColor: isOutgoing ? COLORS.purple + '30' : COLORS.surfaceSecondary,
              borderRadius: 16,
              borderBottomRightRadius: isOutgoing ? 4 : 16,
              borderBottomLeftRadius: isOutgoing ? 16 : 4,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderWidth: 1,
              borderColor: isOutgoing ? COLORS.purple + '40' : COLORS.border,
            }}
          >
            <Text style={{ color: COLORS.text, fontSize: 15, lineHeight: 20 }}>
              {item.content}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, alignSelf: 'flex-end' }}>
              <Ionicons
                name="lock-closed"
                size={10}
                color={COLORS.textTertiary}
                style={{ marginRight: 4 }}
              />
              <Text style={{ color: COLORS.textTertiary, fontSize: 10 }}>
                {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
              {isOutgoing && (
                <Ionicons
                  name={item.status === 'delivered' || item.status === 'read' ? 'checkmark-done' : 'checkmark'}
                  size={12}
                  color={item.status === 'read' ? COLORS.cyan : COLORS.textTertiary}
                  style={{ marginLeft: 4 }}
                />
              )}
            </View>
          </View>
        )}
      </Animated.View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      {/* Header */}
      <View
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
              backgroundColor: COLORS.surfaceSecondary,
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 12,
            }}
          >
            <Ionicons name="arrow-back" size={24} color={COLORS.text} />
          </TouchableOpacity>

          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '600' }}>
                {contact.alias}
              </Text>
              {/* User type badge */}
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                  backgroundColor: contact.isP01User ? COLORS.primary + '20' : COLORS.orange + '20',
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: '600',
                    color: contact.isP01User ? COLORS.primary : COLORS.orange,
                  }}
                >
                  {contact.isP01User ? 'P-01' : 'Wallet'}
                </Text>
              </View>
            </View>
            <Text style={{ color: COLORS.textTertiary, fontSize: 11, fontFamily: 'monospace' }}>
              {formatAddress(contact.address, 8)}
            </Text>
          </View>

          <TouchableOpacity
            onPress={() => setShowPaymentModal(true)}
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: COLORS.primary + '20',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Ionicons name="cash-outline" size={22} color={COLORS.primary} />
          </TouchableOpacity>
        </View>

        {/* Security Badge / Wallet-only Notice */}
        {contact.isP01User ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 10,
              paddingVertical: 6,
              backgroundColor: COLORS.purple + '10',
              borderRadius: 8,
            }}
          >
            <Ionicons name="shield-checkmark" size={14} color={COLORS.purple} style={{ marginRight: 6 }} />
            <Text style={{ color: COLORS.purple, fontSize: 11, fontWeight: '500' }}>
              SL3 End-to-End Encrypted • X25519 + AES-256-GCM
            </Text>
          </View>
        ) : (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginTop: 10,
              paddingVertical: 8,
              paddingHorizontal: 12,
              backgroundColor: COLORS.orange + '15',
              borderRadius: 8,
            }}
          >
            <Ionicons name="wallet" size={16} color={COLORS.orange} style={{ marginRight: 8 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: COLORS.orange, fontSize: 12, fontWeight: '600' }}>
                Wallet Address Only
              </Text>
              <Text style={{ color: COLORS.textSecondary, fontSize: 11 }}>
                This contact uses a different wallet app. You can send crypto but not messages.
              </Text>
            </View>
          </View>
        )}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >
        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={contactMessages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            padding: 16,
            paddingBottom: 20,
          }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 60 }}>
              <View
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 40,
                  backgroundColor: COLORS.surfaceSecondary,
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
                <Ionicons name="chatbubbles-outline" size={36} color={COLORS.textTertiary} />
              </View>
              <Text style={{ color: COLORS.textSecondary, fontSize: 15, marginBottom: 4 }}>
                Start a secure conversation
              </Text>
              <Text style={{ color: COLORS.textTertiary, fontSize: 13, textAlign: 'center', paddingHorizontal: 40 }}>
                All messages are encrypted with SL3 security protocol
              </Text>
            </View>
          }
        />

        {/* Input Bar */}
        {contact.canMessage ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              paddingHorizontal: 16,
              paddingVertical: 12,
              paddingBottom: insets.bottom + 12,
              backgroundColor: COLORS.surface,
              borderTopWidth: 1,
              borderTopColor: COLORS.border,
              gap: 10,
            }}
          >
            <View
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'flex-end',
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 24,
                borderWidth: 1,
                borderColor: COLORS.border,
                paddingHorizontal: 16,
                minHeight: 48,
                maxHeight: 120,
              }}
            >
              <TextInput
                style={{
                  flex: 1,
                  color: COLORS.text,
                  fontSize: 15,
                  paddingVertical: 12,
                  maxHeight: 100,
                }}
                placeholder="Message..."
                placeholderTextColor={COLORS.textTertiary}
                value={inputText}
                onChangeText={setInputText}
                multiline
              />
            </View>

            <TouchableOpacity
              onPress={handleSend}
              disabled={!inputText.trim() || isSending}
              style={{ marginBottom: 4 }}
            >
              <LinearGradient
                colors={inputText.trim() ? [COLORS.purple, COLORS.cyan] : [COLORS.surfaceSecondary, COLORS.surfaceSecondary]}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Ionicons
                  name="send"
                  size={20}
                  color={inputText.trim() ? '#fff' : COLORS.textTertiary}
                />
              </LinearGradient>
            </TouchableOpacity>
          </View>
        ) : (
          /* Non-P01 user - show send crypto option */
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 16,
              paddingBottom: insets.bottom + 16,
              backgroundColor: COLORS.surface,
              borderTopWidth: 1,
              borderTopColor: COLORS.border,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 12,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <Ionicons name="chatbubble-ellipses" size={20} color={COLORS.textTertiary} style={{ marginRight: 10 }} />
              <Text style={{ color: COLORS.textTertiary, fontSize: 13, flex: 1 }}>
                Messaging is not available for this contact. They need to use P-01 to receive messages.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                if (Platform.OS !== 'web') {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                }
                router.push({
                  pathname: '/(main)/(wallet)/send',
                  params: { toAddress: contact.address },
                });
              }}
              style={{ borderRadius: 12, overflow: 'hidden' }}
            >
              <LinearGradient
                colors={[COLORS.primary, COLORS.cyan]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{
                  paddingVertical: 14,
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexDirection: 'row',
                }}
              >
                <Ionicons name="wallet" size={20} color="#000" />
                <Text style={{ color: '#000', fontSize: 15, fontWeight: '600', marginLeft: 8 }}>
                  Send Crypto to {contact.alias}
                </Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Payment Request Modal */}
      <Modal
        visible={showPaymentModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowPaymentModal(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.8)',
            justifyContent: 'flex-end',
          }}
        >
          <View
            style={{
              backgroundColor: COLORS.surface,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              paddingTop: 20,
              paddingBottom: insets.bottom + 20,
              paddingHorizontal: 20,
            }}
          >
            {/* Modal Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 24 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 20, fontWeight: '600' }}>
                  Request Payment
                </Text>
                <Text style={{ color: COLORS.textTertiary, fontSize: 13, marginTop: 2 }}>
                  from {contact.alias}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowPaymentModal(false)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: COLORS.surfaceSecondary,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Ionicons name="close" size={20} color={COLORS.text} />
              </TouchableOpacity>
            </View>

            {/* Currency Selector */}
            <Text
              style={{
                color: COLORS.textTertiary,
                fontSize: 12,
                fontWeight: '600',
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              CURRENCY
            </Text>
            <TouchableOpacity
              onPress={() => setShowCurrencyPicker(!showCurrencyPicker)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 12,
                padding: 14,
                borderWidth: 1,
                borderColor: COLORS.border,
                marginBottom: showCurrencyPicker ? 0 : 20,
              }}
            >
              <Text style={{ fontSize: 20, marginRight: 10 }}>{selectedCurrency.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>
                  {selectedCurrency.symbol}
                </Text>
                <Text style={{ color: COLORS.textTertiary, fontSize: 12 }}>
                  {selectedCurrency.name}
                </Text>
              </View>
              <Ionicons
                name={showCurrencyPicker ? 'chevron-up' : 'chevron-down'}
                size={20}
                color={COLORS.textSecondary}
              />
            </TouchableOpacity>

            {/* Currency Picker Dropdown */}
            {showCurrencyPicker && (
              <Animated.View
                entering={FadeInDown.duration(200)}
                style={{
                  backgroundColor: COLORS.surfaceSecondary,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                  marginTop: 8,
                  marginBottom: 20,
                  maxHeight: 200,
                }}
              >
                <FlatList
                  data={SUPPORTED_CURRENCIES}
                  keyExtractor={(item) => item.symbol}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      onPress={() => {
                        setSelectedCurrency(item);
                        setShowCurrencyPicker(false);
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: 12,
                        borderBottomWidth: 1,
                        borderBottomColor: COLORS.border,
                        backgroundColor: item.symbol === selectedCurrency.symbol ? COLORS.purple + '20' : 'transparent',
                      }}
                    >
                      <Text style={{ fontSize: 18, marginRight: 10 }}>{item.icon}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '500' }}>
                          {item.symbol}
                        </Text>
                        <Text style={{ color: COLORS.textTertiary, fontSize: 11 }}>
                          {item.name}
                        </Text>
                      </View>
                      {item.symbol === selectedCurrency.symbol && (
                        <Ionicons name="checkmark" size={18} color={COLORS.purple} />
                      )}
                    </TouchableOpacity>
                  )}
                  showsVerticalScrollIndicator={false}
                />
              </Animated.View>
            )}

            {/* Amount Input */}
            <Text
              style={{
                color: COLORS.textTertiary,
                fontSize: 12,
                fontWeight: '600',
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              AMOUNT
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: COLORS.border,
                marginBottom: 20,
              }}
            >
              <TextInput
                style={{
                  flex: 1,
                  color: COLORS.text,
                  fontSize: 24,
                  fontWeight: '600',
                  padding: 16,
                }}
                placeholder="0.00"
                placeholderTextColor={COLORS.textTertiary}
                value={paymentAmount}
                onChangeText={setPaymentAmount}
                keyboardType="decimal-pad"
              />
              <Text
                style={{
                  color: COLORS.textSecondary,
                  fontSize: 16,
                  fontWeight: '500',
                  paddingRight: 16,
                }}
              >
                {selectedCurrency.symbol}
              </Text>
            </View>

            {/* Note Input */}
            <Text
              style={{
                color: COLORS.textTertiary,
                fontSize: 12,
                fontWeight: '600',
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              NOTE (OPTIONAL)
            </Text>
            <TextInput
              style={{
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: COLORS.border,
                color: COLORS.text,
                fontSize: 15,
                padding: 14,
                marginBottom: 24,
              }}
              placeholder="What's this for?"
              placeholderTextColor={COLORS.textTertiary}
              value={paymentNote}
              onChangeText={setPaymentNote}
              maxLength={100}
            />

            {/* Send Button */}
            <TouchableOpacity
              onPress={handleSendPayment}
              disabled={!paymentAmount || parseFloat(paymentAmount) <= 0}
              style={{ borderRadius: 16, overflow: 'hidden' }}
            >
              <LinearGradient
                colors={paymentAmount && parseFloat(paymentAmount) > 0
                  ? [COLORS.purple, COLORS.cyan]
                  : [COLORS.surfaceSecondary, COLORS.surfaceSecondary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{
                  paddingVertical: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexDirection: 'row',
                }}
              >
                <Ionicons
                  name="paper-plane"
                  size={20}
                  color={paymentAmount && parseFloat(paymentAmount) > 0 ? '#fff' : COLORS.textTertiary}
                />
                <Text
                  style={{
                    color: paymentAmount && parseFloat(paymentAmount) > 0 ? '#fff' : COLORS.textTertiary,
                    fontSize: 16,
                    fontWeight: '600',
                    marginLeft: 8,
                  }}
                >
                  Send Request
                </Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}
