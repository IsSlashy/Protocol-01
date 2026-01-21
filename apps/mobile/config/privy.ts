/**
 * Privy Configuration for Specter Mobile App
 *
 * React Native specific configuration for Privy authentication.
 */

// Get App ID from environment
export const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID || 'YOUR_PRIVY_APP_ID';

// Check if Privy is configured
export const PRIVY_ENABLED = PRIVY_APP_ID !== 'YOUR_PRIVY_APP_ID';

// Privy configuration for React Native
export const privyConfig = {
  // Appearance
  appearance: {
    theme: 'dark' as const,
    accentColor: '#22d3ee', // Cyan to match Specter branding
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
