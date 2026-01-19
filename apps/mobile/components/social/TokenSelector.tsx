/**
 * TokenSelector Component
 * Dropdown for selecting tokens when sending payments
 * Shows token balances
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, SlideInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import {
  KNOWN_TOKENS,
  SUPPORTED_TOKENS,
  SupportedToken,
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

interface TokenBalance {
  symbol: string;
  balance: number;
  usdValue?: number;
}

interface TokenSelectorProps {
  selectedToken: SupportedToken;
  onSelectToken: (token: SupportedToken) => void;
  balances?: Record<string, TokenBalance>;
  disabled?: boolean;
  compact?: boolean;
}

/**
 * Format balance for display
 */
function formatBalance(balance: number, decimals: number = 4): string {
  if (balance === 0) return '0';
  if (balance < 0.0001) return '<0.0001';
  if (balance < 1) return balance.toFixed(decimals);
  if (balance < 1000) return balance.toFixed(2);
  if (balance < 1000000) return `${(balance / 1000).toFixed(2)}K`;
  return `${(balance / 1000000).toFixed(2)}M`;
}

/**
 * Get icon for token
 */
function getTokenIcon(symbol: string): keyof typeof Ionicons.glyphMap {
  switch (symbol) {
    case 'SOL':
      return 'logo-usd';
    case 'USDC':
    case 'USDT':
      return 'cash-outline';
    case 'BONK':
      return 'paw-outline';
    default:
      return 'ellipse-outline';
  }
}

/**
 * Get color for token
 */
function getTokenColor(symbol: string): string {
  switch (symbol) {
    case 'SOL':
      return '#9945FF';
    case 'USDC':
      return '#2775CA';
    case 'USDT':
      return '#26A17B';
    case 'BONK':
      return '#F9A825';
    default:
      return COLORS.cyan;
  }
}

export const TokenSelector: React.FC<TokenSelectorProps> = ({
  selectedToken,
  onSelectToken,
  balances = {},
  disabled = false,
  compact = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleOpen = () => {
    if (disabled) return;
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setIsOpen(true);
  };

  const handleSelect = (token: SupportedToken) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onSelectToken(token);
    setIsOpen(false);
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  const selectedTokenInfo = KNOWN_TOKENS[selectedToken];
  const selectedBalance = balances[selectedToken]?.balance || 0;

  // Compact view (inline selector)
  if (compact) {
    return (
      <>
        <TouchableOpacity
          onPress={handleOpen}
          disabled={disabled}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: COLORS.surfaceSecondary,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: COLORS.border,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: getTokenColor(selectedToken) + '30',
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 8,
            }}
          >
            <Ionicons
              name={getTokenIcon(selectedToken)}
              size={14}
              color={getTokenColor(selectedToken)}
            />
          </View>
          <Text
            style={{
              color: COLORS.text,
              fontSize: 15,
              fontWeight: '600',
              marginRight: 4,
            }}
          >
            {selectedToken}
          </Text>
          <Ionicons name="chevron-down" size={16} color={COLORS.textSecondary} />
        </TouchableOpacity>

        <TokenSelectorModal
          visible={isOpen}
          onClose={handleClose}
          selectedToken={selectedToken}
          onSelect={handleSelect}
          balances={balances}
        />
      </>
    );
  }

  // Full view (card selector)
  return (
    <>
      <TouchableOpacity
        onPress={handleOpen}
        disabled={disabled}
        style={{
          backgroundColor: COLORS.surfaceSecondary,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: COLORS.border,
          padding: 16,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: getTokenColor(selectedToken) + '30',
                justifyContent: 'center',
                alignItems: 'center',
                marginRight: 12,
              }}
            >
              <Ionicons
                name={getTokenIcon(selectedToken)}
                size={22}
                color={getTokenColor(selectedToken)}
              />
            </View>
            <View>
              <Text
                style={{
                  color: COLORS.text,
                  fontSize: 17,
                  fontWeight: '600',
                }}
              >
                {selectedTokenInfo?.name || selectedToken}
              </Text>
              <Text
                style={{
                  color: COLORS.textSecondary,
                  fontSize: 13,
                  marginTop: 2,
                }}
              >
                Balance: {formatBalance(selectedBalance)} {selectedToken}
              </Text>
            </View>
          </View>
          <Ionicons name="chevron-down" size={20} color={COLORS.textSecondary} />
        </View>
      </TouchableOpacity>

      <TokenSelectorModal
        visible={isOpen}
        onClose={handleClose}
        selectedToken={selectedToken}
        onSelect={handleSelect}
        balances={balances}
      />
    </>
  );
};

// Modal component for token selection
interface TokenSelectorModalProps {
  visible: boolean;
  onClose: () => void;
  selectedToken: SupportedToken;
  onSelect: (token: SupportedToken) => void;
  balances: Record<string, TokenBalance>;
}

const TokenSelectorModal: React.FC<TokenSelectorModalProps> = ({
  visible,
  onClose,
  selectedToken,
  onSelect,
  balances,
}) => {
  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
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
          <View
            style={{
              alignItems: 'center',
              paddingTop: 12,
              paddingBottom: 8,
            }}
          >
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
            <Text
              style={{
                color: COLORS.text,
                fontSize: 18,
                fontWeight: '600',
              }}
            >
              Select Token
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Token List */}
          <ScrollView
            style={{ maxHeight: 400 }}
            contentContainerStyle={{ padding: 16 }}
            showsVerticalScrollIndicator={false}
          >
            {SUPPORTED_TOKENS.map((token) => {
              const tokenInfo = KNOWN_TOKENS[token];
              const balance = balances[token]?.balance || 0;
              const usdValue = balances[token]?.usdValue;
              const isSelected = token === selectedToken;

              return (
                <Animated.View
                  key={token}
                  entering={FadeIn.delay(SUPPORTED_TOKENS.indexOf(token) * 50)}
                >
                  <TouchableOpacity
                    onPress={() => onSelect(token)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: 16,
                      marginBottom: 8,
                      backgroundColor: isSelected
                        ? COLORS.cyan + '15'
                        : COLORS.surfaceSecondary,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: isSelected ? COLORS.cyan + '50' : COLORS.border,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <View
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: 22,
                          backgroundColor: getTokenColor(token) + '30',
                          justifyContent: 'center',
                          alignItems: 'center',
                          marginRight: 12,
                        }}
                      >
                        <Ionicons
                          name={getTokenIcon(token)}
                          size={22}
                          color={getTokenColor(token)}
                        />
                      </View>
                      <View>
                        <Text
                          style={{
                            color: COLORS.text,
                            fontSize: 16,
                            fontWeight: '600',
                          }}
                        >
                          {tokenInfo?.name || token}
                        </Text>
                        <Text
                          style={{
                            color: COLORS.textSecondary,
                            fontSize: 13,
                            marginTop: 2,
                          }}
                        >
                          {token}
                        </Text>
                      </View>
                    </View>

                    <View style={{ alignItems: 'flex-end' }}>
                      <Text
                        style={{
                          color: COLORS.text,
                          fontSize: 15,
                          fontWeight: '600',
                        }}
                      >
                        {formatBalance(balance)}
                      </Text>
                      {usdValue !== undefined && usdValue > 0 && (
                        <Text
                          style={{
                            color: COLORS.textSecondary,
                            fontSize: 12,
                            marginTop: 2,
                          }}
                        >
                          ${usdValue.toFixed(2)}
                        </Text>
                      )}
                      {isSelected && (
                        <Ionicons
                          name="checkmark-circle"
                          size={20}
                          color={COLORS.cyan}
                          style={{ marginTop: 4 }}
                        />
                      )}
                    </View>
                  </TouchableOpacity>
                </Animated.View>
              );
            })}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
};

export default TokenSelector;
