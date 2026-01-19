/**
 * PaymentBubble Component
 * Renders payment request and payment sent messages in chat
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

import {
  ChatPaymentMessage,
  PaymentRequestStatus,
  formatPaymentAmount,
  formatExpirationTime,
  getStatusText,
  getStatusColor,
  openTransactionInExplorer,
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
  success: '#00ff88',
  error: '#ef4444',
};

interface PaymentBubbleProps {
  message: ChatPaymentMessage;
  isOwn: boolean;
  onPay?: (message: ChatPaymentMessage) => void;
  onDecline?: (message: ChatPaymentMessage) => void;
  isProcessing?: boolean;
}

/**
 * Truncate address for display
 */
function truncateAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const PaymentBubble: React.FC<PaymentBubbleProps> = ({
  message,
  isOwn,
  onPay,
  onDecline,
  isProcessing = false,
}) => {
  const isPending = message.status === 'pending';
  const isPaid = message.status === 'paid';
  const isPaymentRequest = message.type === 'payment_request';
  const isPaymentSent = message.type === 'payment_sent';

  const handlePay = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onPay?.(message);
  };

  const handleDecline = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onDecline?.(message);
  };

  const handleViewTransaction = async () => {
    if (message.txSignature) {
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      await openTransactionInExplorer(message.txSignature);
    }
  };

  // Payment Request Bubble
  if (isPaymentRequest) {
    return (
      <Animated.View
        entering={FadeInDown.duration(300)}
        style={{
          flexDirection: 'row',
          justifyContent: isOwn ? 'flex-end' : 'flex-start',
          marginBottom: 12,
        }}
      >
        <View
          style={{
            maxWidth: '85%',
            borderRadius: 20,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor:
              isPaid
                ? COLORS.success + '50'
                : message.status === 'declined' || message.status === 'expired'
                ? COLORS.border
                : COLORS.pink + '50',
            backgroundColor:
              isPaid
                ? COLORS.success + '15'
                : message.status === 'declined' || message.status === 'expired'
                ? COLORS.surface + '80'
                : COLORS.pink + '15',
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingTop: 14,
              paddingBottom: 8,
              gap: 10,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: isPaid ? COLORS.success + '30' : COLORS.pink + '30',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons
                name={isPaid ? 'checkmark-circle' : 'cash-outline'}
                size={20}
                color={isPaid ? COLORS.success : COLORS.pink}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: COLORS.text,
                  fontSize: 15,
                  fontWeight: '600',
                }}
              >
                Payment Request
              </Text>
              <Text
                style={{
                  color: COLORS.textSecondary,
                  fontSize: 11,
                  marginTop: 1,
                }}
              >
                {isOwn ? 'You requested' : 'Requested from you'}
              </Text>
            </View>
            {/* Status badge */}
            {!isPending && (
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 10,
                  backgroundColor: getStatusColor(message.status) + '25',
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: '600',
                    color: getStatusColor(message.status),
                  }}
                >
                  {getStatusText(message.status)}
                </Text>
              </View>
            )}
          </View>

          {/* Amount */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text
              style={{
                fontSize: 28,
                fontWeight: 'bold',
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                color: COLORS.text,
              }}
            >
              {formatPaymentAmount(message.amount, message.token)}
            </Text>
            {message.note && (
              <Text
                style={{
                  color: COLORS.textSecondary,
                  fontSize: 14,
                  marginTop: 6,
                  fontStyle: 'italic',
                }}
              >
                "{message.note}"
              </Text>
            )}
          </View>

          {/* Expiration time (only for pending requests) */}
          {isPending && message.expiresAt && (
            <View
              style={{
                paddingHorizontal: 16,
                paddingBottom: 8,
              }}
            >
              <Text
                style={{
                  color: COLORS.textTertiary,
                  fontSize: 11,
                }}
              >
                {formatExpirationTime(message.expiresAt)}
              </Text>
            </View>
          )}

          {/* Action buttons (only show for incoming pending requests) */}
          {isPending && !isOwn && onPay && onDecline && (
            <View
              style={{
                flexDirection: 'row',
                paddingHorizontal: 12,
                paddingBottom: 14,
                gap: 10,
              }}
            >
              <TouchableOpacity
                onPress={handleDecline}
                disabled={isProcessing}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  backgroundColor: COLORS.surfaceTertiary,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                  alignItems: 'center',
                  opacity: isProcessing ? 0.5 : 1,
                }}
              >
                <Text
                  style={{
                    color: COLORS.textSecondary,
                    fontSize: 15,
                    fontWeight: '600',
                  }}
                >
                  Decline
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handlePay}
                disabled={isProcessing}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  backgroundColor: COLORS.cyan,
                  borderRadius: 14,
                  alignItems: 'center',
                  opacity: isProcessing ? 0.5 : 1,
                }}
              >
                {isProcessing ? (
                  <ActivityIndicator color={COLORS.background} size="small" />
                ) : (
                  <Text
                    style={{
                      color: COLORS.background,
                      fontSize: 15,
                      fontWeight: '600',
                    }}
                  >
                    Pay
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* Transaction link (when paid) */}
          {isPaid && message.txSignature && (
            <TouchableOpacity
              onPress={handleViewTransaction}
              style={{
                paddingHorizontal: 16,
                paddingBottom: 14,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons
                  name="open-outline"
                  size={12}
                  color={COLORS.textTertiary}
                />
                <Text
                  style={{
                    color: COLORS.textTertiary,
                    fontSize: 11,
                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  }}
                >
                  Tx: {truncateAddress(message.txSignature, 8)}
                </Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Timestamp */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingBottom: 10,
            }}
          >
            <Text
              style={{
                color: COLORS.textTertiary,
                fontSize: 10,
                textAlign: isOwn ? 'right' : 'left',
              }}
            >
              {formatTime(message.timestamp)}
            </Text>
          </View>
        </View>
      </Animated.View>
    );
  }

  // Payment Sent Bubble
  if (isPaymentSent) {
    return (
      <Animated.View
        entering={FadeInDown.duration(300)}
        style={{
          flexDirection: 'row',
          justifyContent: isOwn ? 'flex-end' : 'flex-start',
          marginBottom: 12,
        }}
      >
        <View
          style={{
            maxWidth: '85%',
            borderRadius: 20,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: isOwn ? COLORS.success + '50' : COLORS.cyan + '50',
            backgroundColor: isOwn ? COLORS.success + '15' : COLORS.cyan + '15',
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingTop: 14,
              paddingBottom: 8,
              gap: 10,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: isOwn ? COLORS.success + '30' : COLORS.cyan + '30',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons
                name={isOwn ? 'arrow-up' : 'arrow-down'}
                size={20}
                color={isOwn ? COLORS.success : COLORS.cyan}
              />
            </View>
            <Text
              style={{
                color: COLORS.text,
                fontSize: 15,
                fontWeight: '600',
              }}
            >
              {isOwn ? 'Payment Sent' : 'Payment Received'}
            </Text>
          </View>

          {/* Amount */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text
              style={{
                fontSize: 28,
                fontWeight: 'bold',
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                color: COLORS.text,
              }}
            >
              {isOwn ? '-' : '+'}
              {formatPaymentAmount(message.amount, message.token)}
            </Text>
            {message.note && (
              <Text
                style={{
                  color: COLORS.textSecondary,
                  fontSize: 14,
                  marginTop: 6,
                  fontStyle: 'italic',
                }}
              >
                "{message.note}"
              </Text>
            )}
          </View>

          {/* Transaction link */}
          {message.txSignature && (
            <TouchableOpacity
              onPress={handleViewTransaction}
              style={{
                paddingHorizontal: 16,
                paddingBottom: 10,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons
                  name="open-outline"
                  size={12}
                  color={COLORS.textTertiary}
                />
                <Text
                  style={{
                    color: COLORS.textTertiary,
                    fontSize: 11,
                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  }}
                >
                  Tx: {truncateAddress(message.txSignature, 8)}
                </Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Timestamp */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingBottom: 10,
            }}
          >
            <Text
              style={{
                color: COLORS.textTertiary,
                fontSize: 10,
                textAlign: isOwn ? 'right' : 'left',
              }}
            >
              {formatTime(message.timestamp)}
            </Text>
          </View>
        </View>
      </Animated.View>
    );
  }

  return null;
};

export default PaymentBubble;
