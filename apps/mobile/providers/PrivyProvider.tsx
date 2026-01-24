/**
 * Privy Provider for Protocol 01 Mobile App
 *
 * Wraps the application with Privy authentication context.
 * Falls back to legacy auth if Privy is not configured.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { PRIVY_APP_ID, PRIVY_ENABLED, privyConfig } from '../config/privy';

// Note: Privy React Native SDK import
// When @privy-io/expo is installed, uncomment:
// import { PrivyProvider as BasePrivyProvider, usePrivy, useSolanaWallets } from '@privy-io/expo';

// For now, create a mock context that can be replaced with real Privy
interface PrivyUser {
  id: string;
  email?: { address: string };
  phone?: { number: string };
  wallet?: { address: string };
}

interface PrivyContextType {
  ready: boolean;
  authenticated: boolean;
  user: PrivyUser | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  // Solana specific
  solanaWallet: {
    address: string | null;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    signTransaction: (tx: any) => Promise<any>;
  } | null;
}

const PrivyContext = createContext<PrivyContextType | null>(null);

interface PrivyProviderProps {
  children: React.ReactNode;
}

/**
 * Privy Provider that wraps the app
 * Falls back to mock implementation if Privy not configured
 */
export function P01PrivyProvider({ children }: PrivyProviderProps) {
  // If Privy is not enabled, use legacy auth
  if (!PRIVY_ENABLED) {
    console.log('[Privy] Not configured, using legacy auth');
    return <LegacyAuthProvider>{children}</LegacyAuthProvider>;
  }

  // When Privy is enabled, wrap with real provider
  // Uncomment when @privy-io/expo is installed:
  /*
  return (
    <BasePrivyProvider
      appId={PRIVY_APP_ID}
      config={privyConfig}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </BasePrivyProvider>
  );
  */

  // For now, use mock
  return <MockPrivyProvider>{children}</MockPrivyProvider>;
}

/**
 * Legacy auth provider - uses existing wallet store
 */
function LegacyAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PrivyContextType>({
    ready: true,
    authenticated: false,
    user: null,
    login: async () => {
      console.log('[LegacyAuth] Use onboarding flow');
    },
    logout: async () => {
      console.log('[LegacyAuth] Logout');
    },
    solanaWallet: null,
  });

  return (
    <PrivyContext.Provider value={state}>
      {children}
    </PrivyContext.Provider>
  );
}

/**
 * Mock Privy provider for development
 * Replace with real implementation when SDK is installed
 */
function MockPrivyProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PrivyContextType>({
    ready: false,
    authenticated: false,
    user: null,
    login: async () => {
      // Mock login - in real implementation, this opens Privy modal
      console.log('[MockPrivy] Login called - implement with real Privy SDK');
      setState(prev => ({
        ...prev,
        authenticated: true,
        user: {
          id: 'mock-user-id',
          email: { address: 'user@example.com' },
        },
      }));
    },
    logout: async () => {
      setState(prev => ({
        ...prev,
        authenticated: false,
        user: null,
        solanaWallet: null,
      }));
    },
    solanaWallet: null,
  });

  useEffect(() => {
    // Simulate initialization
    const timer = setTimeout(() => {
      setState(prev => ({ ...prev, ready: true }));
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <PrivyContext.Provider value={state}>
      {children}
    </PrivyContext.Provider>
  );
}

/**
 * Hook to access Privy context
 */
export function usePrivyAuth(): PrivyContextType {
  const context = useContext(PrivyContext);
  if (!context) {
    throw new Error('usePrivyAuth must be used within P01PrivyProvider');
  }
  return context;
}

/**
 * Hook that combines Privy auth with existing wallet store
 */
export function useAuth() {
  const privy = usePrivyAuth();
  // Import wallet store when needed
  // const walletStore = useWalletStore();

  return {
    // Auth state
    isReady: privy.ready,
    isAuthenticated: privy.authenticated,

    // User info
    user: privy.user,
    email: privy.user?.email?.address || null,
    phone: privy.user?.phone?.number || null,

    // Wallet
    walletAddress: privy.solanaWallet?.address || null,
    hasWallet: Boolean(privy.solanaWallet?.address),

    // Actions
    login: privy.login,
    logout: privy.logout,

    // Signing (use Privy wallet when available)
    signMessage: privy.solanaWallet?.signMessage,
    signTransaction: privy.solanaWallet?.signTransaction,
  };
}

// Re-export for convenience
export { PRIVY_ENABLED } from '../config/privy';
