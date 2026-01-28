/**
 * Privy Configuration for Specter Extension
 *
 * Privy provides simplified Web3 authentication with:
 * - Email/SMS login
 * - Social logins (Google, Twitter, Discord)
 * - Embedded wallets (auto-created for new users)
 * - Traditional wallet connections (Phantom, etc.)
 */

import type { PrivyClientConfig } from '@privy-io/react-auth';

// Get App ID from environment or use placeholder
// In production, set VITE_PRIVY_APP_ID in your .env file
export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || 'YOUR_PRIVY_APP_ID';

// Privy configuration
export const privyConfig: PrivyClientConfig = {
  // Appearance
  appearance: {
    theme: 'dark',
    accentColor: '#22d3ee', // Cyan to match Specter branding
    logo: '/icons/icon-128.png',
    showWalletLoginFirst: false, // Show email/social first for easier onboarding
  },

  // Login methods - order matters for UI
  loginMethods: [
    'email',
    'sms',
    'google',
    'twitter',
    'discord',
    'wallet', // Traditional wallet connection (Phantom, etc.)
  ],

  // Embedded wallets configuration
  embeddedWallets: {
    // Automatically create embedded wallet for users without one
    createOnLogin: 'users-without-wallets',
    // Don't require additional confirmation for transactions under threshold
    requireUserPasswordOnCreate: false,
    // Show UI to recover wallet
    showWalletUIs: true,
  },

  // Solana configuration
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

  // Default to Solana
  defaultChain: undefined, // Will use Solana by default with embedded wallets

  // Legal
  legal: {
    termsAndConditionsUrl: 'https://specter.so/terms',
    privacyPolicyUrl: 'https://specter.so/privacy',
  },
};

// Export supported login methods for UI
export const LOGIN_METHODS = {
  email: { label: 'Email', icon: 'mail' },
  sms: { label: 'Phone', icon: 'smartphone' },
  google: { label: 'Google', icon: 'chrome' },
  twitter: { label: 'Twitter', icon: 'twitter' },
  discord: { label: 'Discord', icon: 'message-circle' },
  wallet: { label: 'Wallet', icon: 'wallet' },
} as const;
