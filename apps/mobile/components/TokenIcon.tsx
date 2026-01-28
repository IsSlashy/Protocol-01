import React, { useState } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';

interface TokenIconProps {
  symbol: string;
  logoURI?: string;
  size?: number;
}

// Known token logos (fallback if logoURI is not provided)
const TOKEN_LOGOS: Record<string, string> = {
  SOL: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  USDC: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
  USDT: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
  BONK: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I',
};

// Color mapping for fallback icons
const TOKEN_COLORS: Record<string, string> = {
  SOL: '#9945FF',
  USDC: '#2775CA',
  USDT: '#26A17B',
  BONK: '#F9A825',
  DEFAULT: '#39c5bb',
};

export default function TokenIcon({ symbol, logoURI, size = 40 }: TokenIconProps) {
  const [imageError, setImageError] = useState(false);

  const imageUrl = logoURI || TOKEN_LOGOS[symbol?.toUpperCase()];
  const backgroundColor = TOKEN_COLORS[symbol?.toUpperCase()] || TOKEN_COLORS.DEFAULT;

  // Show image if available and no error
  if (imageUrl && !imageError) {
    return (
      <View style={[styles.container, { width: size, height: size, borderRadius: size / 2 }]}>
        <Image
          source={{ uri: imageUrl }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          onError={() => setImageError(true)}
        />
      </View>
    );
  }

  // Fallback: show colored circle with first letter
  return (
    <View
      style={[
        styles.fallback,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor,
        },
      ]}
    >
      <Text style={[styles.fallbackText, { fontSize: size * 0.4 }]}>
        {symbol?.charAt(0)?.toUpperCase() || '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: '#1a1a1e',
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    color: '#ffffff',
    fontWeight: 'bold',
  },
});
