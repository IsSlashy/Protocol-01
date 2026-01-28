import React, { useState } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

// CoinGecko CDN logos for common tokens
const TOKEN_LOGOS: Record<string, string> = {
  SOL: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
  USDC: 'https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png',
  USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  BONK: 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg',
  JUP: 'https://assets.coingecko.com/coins/images/34188/small/jup.png',
  RAY: 'https://assets.coingecko.com/coins/images/13928/small/PSigc4ie_400x400.jpg',
  ORCA: 'https://assets.coingecko.com/coins/images/17547/small/Orca_Logo.png',
  PYTH: 'https://assets.coingecko.com/coins/images/31924/small/pyth.png',
  JTO: 'https://assets.coingecko.com/coins/images/33103/small/jto.png',
  WIF: 'https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg',
  WSOL: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
};

// Gradient colors for fallback
const GRADIENT_COLORS: [string, string][] = [
  ['#39c5bb', '#00ffe5'],
  ['#9333ea', '#ec4899'],
  ['#f97316', '#ef4444'],
  ['#22c55e', '#14b8a6'],
  ['#eab308', '#f97316'],
];

interface TokenIconProps {
  symbol: string;
  logoURI?: string;
  size?: number;
}

export default function TokenIcon({ symbol, logoURI, size = 44 }: TokenIconProps) {
  const [imageError, setImageError] = useState(false);

  // Try to get a working logo URL
  const getLogoUrl = (): string | null => {
    const symbolUpper = symbol.toUpperCase();
    if (TOKEN_LOGOS[symbolUpper]) {
      return TOKEN_LOGOS[symbolUpper];
    }
    if (logoURI) {
      return logoURI;
    }
    return null;
  };

  const logoUrl = getLogoUrl();
  const showImage = logoUrl && !imageError;

  // Get a consistent gradient based on symbol
  const gradientIndex = symbol.charCodeAt(0) % GRADIENT_COLORS.length;
  const gradient = GRADIENT_COLORS[gradientIndex];

  if (showImage) {
    return (
      <Image
        source={{ uri: logoUrl }}
        style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
        onError={() => setImageError(true)}
      />
    );
  }

  // Fallback: gradient circle with symbol initials
  return (
    <LinearGradient
      colors={gradient}
      style={[styles.gradient, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <Text style={[styles.text, { fontSize: size * 0.35 }]}>
        {symbol.slice(0, 2).toUpperCase()}
      </Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: '#1a1a1a',
  },
  gradient: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    color: '#ffffff',
    fontWeight: 'bold',
  },
});
