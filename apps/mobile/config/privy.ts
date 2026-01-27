/**
 * Privy Configuration for Protocol 01 Mobile App
 *
 * React Native specific configuration for Privy authentication.
 * Styled with P-01 cyberpunk design.
 */

// P-01 Design Colors
export const P01_COLORS = {
  cyan: '#39c5bb',
  cyanBright: '#00ffe5',
  pink: '#ff2d7a',
  pinkHot: '#ff77a8',
  void: '#0a0a0c',
  surface: '#151518',
  border: '#2a2a30',
};

// Get App ID from environment
export const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID || 'YOUR_PRIVY_APP_ID';

// Check if Privy is configured
export const PRIVY_ENABLED = PRIVY_APP_ID !== 'YOUR_PRIVY_APP_ID';

// Privy configuration for React Native
export const privyConfig = {
  // Appearance - P-01 cyberpunk theme
  appearance: {
    theme: 'dark' as const,
    accentColor: P01_COLORS.cyan,
    logo: '', // Will use custom UI instead
  },

  // Login methods
  loginMethods: [
    'email',
    'sms',
    'google',
    'apple', // iOS specific
    'twitter',
    'wallet',
  ],

  // Embedded wallets
  embeddedWallets: {
    createOnLogin: 'users-without-wallets' as const,
    requireUserPasswordOnCreate: false,
  },

  // Solana clusters
  solanaClusters: [
    {
      name: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
    },
    {
      name: 'mainnet-beta',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    },
  ],
};

// Login method icons (for custom UI)
export const LOGIN_METHODS = {
  email: { label: 'Email', icon: 'mail' },
  sms: { label: 'Phone', icon: 'smartphone' },
  google: { label: 'Google', icon: 'logo-google' },
  apple: { label: 'Apple', icon: 'logo-apple' },
  twitter: { label: 'Twitter', icon: 'logo-twitter' },
  wallet: { label: 'Wallet', icon: 'wallet' },
} as const;
