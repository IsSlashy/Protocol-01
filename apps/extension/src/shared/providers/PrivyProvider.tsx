/**
 * Privy Provider Wrapper for Specter Extension
 *
 * Wraps the application with Privy authentication context.
 * This enables:
 * - Email/SMS/Social login
 * - Embedded Solana wallets
 * - External wallet connections
 */

import React from 'react';
import { PrivyProvider as BasePrivyProvider } from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { PRIVY_APP_ID, privyConfig } from '../config/privy';

// Solana wallet connectors (Phantom, Solflare, etc.)
const solanaConnectors = toSolanaWalletConnectors({
  // Enable standard Solana wallets
  shouldAutoConnect: false, // Let user choose
});

interface PrivyProviderProps {
  children: React.ReactNode;
}

export function SpecterPrivyProvider({ children }: PrivyProviderProps) {
  // Check if we have a valid app ID
  const hasValidAppId = PRIVY_APP_ID && PRIVY_APP_ID !== 'YOUR_PRIVY_APP_ID';

  // If no valid app ID, render children without Privy
  // This allows the app to work in development without Privy setup
  if (!hasValidAppId) {
    console.warn('[Privy] No valid App ID configured. Running in legacy mode.');
    console.warn('[Privy] Set VITE_PRIVY_APP_ID in your .env file to enable Privy auth.');
    return <>{children}</>;
  }

  return (
    <BasePrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        ...privyConfig,
        externalWallets: {
          solana: {
            connectors: solanaConnectors,
          },
        },
      }}
      onSuccess={(user) => {
        console.log('[Privy] Login successful:', user.id);
      }}
    >
      {children}
    </BasePrivyProvider>
  );
}

// Re-export hooks for convenience
export {
  usePrivy,
  useWallets,
  useSolanaWallets,
  useLogin,
  useLogout,
} from '@privy-io/react-auth';
