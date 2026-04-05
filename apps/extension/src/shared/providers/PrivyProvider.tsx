/**
 * Privy Provider Wrapper for Protocol 01 Extension
 *
 * Wraps the application with Privy authentication context.
 * This enables:
 * - Email/SMS/Social login
 * - Embedded Solana wallets
 * - External wallet connections
 */

import React, { useEffect } from 'react';
import { PrivyProvider as BasePrivyProvider, usePrivy, useSolanaWallets } from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { PRIVY_APP_ID, privyConfig } from '../config/privy';
import { useWalletStore, setPrivySigner } from '../store/wallet';

// Solana wallet connectors (Phantom, Solflare, etc.)
const solanaConnectors = toSolanaWalletConnectors({
  // Enable standard Solana wallets
  shouldAutoConnect: false, // Let user choose
});

/**
 * PrivyBridge — syncs Privy authentication state into the Zustand wallet store.
 *
 * When Privy authenticates and a Solana wallet is available:
 *   1. Calls walletStore.initializeWithPrivy(address)
 *   2. Sets the privySigner so sendTransaction works
 *
 * When the user logs out of Privy:
 *   1. Clears the privySigner
 *   2. Calls walletStore.logout() to reset persisted state
 *
 * IMPORTANT: We track whether the user was ever authenticated in this session
 * to avoid a race condition where Privy hasn't finished hydrating yet and
 * `authenticated` is momentarily false — which would incorrectly trigger logout
 * and wipe the persisted wallet state on popup reopen.
 */
function PrivyBridge({ children }: { children: React.ReactNode }) {
  const { authenticated, ready } = usePrivy();
  const { wallets } = useSolanaWallets();
  const wasAuthenticatedRef = React.useRef(false);

  useEffect(() => {
    if (!ready) return;

    const store = useWalletStore.getState();

    if (authenticated) {
      wasAuthenticatedRef.current = true;
      if (wallets.length > 0) {
        // Prefer the Privy embedded wallet, fall back to first available
        const wallet = wallets.find(w => w.walletClientType === 'privy') || wallets[0];
        if (wallet) {
          store.initializeWithPrivy(wallet.address);
          setPrivySigner(async (transaction) => wallet.signTransaction(transaction));
        }
      }
      // If wallets haven't loaded yet, this effect re-runs when they do
    } else {
      // Not authenticated — only logout if user was previously authenticated
      // in THIS session. This prevents wiping state on popup reopen when
      // Privy hasn't finished hydrating yet.
      setPrivySigner(null);
      if (store.isPrivyWallet && wasAuthenticatedRef.current) {
        store.logout();
      }
    }

    return () => {
      setPrivySigner(null);
    };
  }, [authenticated, ready, wallets]);

  return <>{children}</>;
}

interface PrivyProviderProps {
  children: React.ReactNode;
}

export function P01PrivyProvider({ children }: PrivyProviderProps) {
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
    >
      <PrivyBridge>
        {children}
      </PrivyBridge>
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
  useLoginWithEmail,
  useLoginWithSms,
  useLoginWithOAuth,
  useConnectWallet,
} from '@privy-io/react-auth';
