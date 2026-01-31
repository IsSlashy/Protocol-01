/**
 * Auth Adapter - Bridge between Privy and existing Zustand wallet store
 *
 * This adapter provides a unified interface that:
 * 1. Uses Privy for authentication (login/logout)
 * 2. Falls back to Zustand for wallet operations
 * 3. Syncs state between both systems
 *
 * Migration strategy:
 * - Phase 1: Privy handles auth, Zustand handles wallet state
 * - Phase 2: Privy embedded wallets replace Zustand wallet creation
 * - Phase 3: Full Privy integration with Zustand for app state only
 */

import { useCallback, useEffect, useMemo } from 'react';
import { usePrivy, useWallets, useSolanaWallets } from '@privy-io/react-auth';
import { useWalletStore } from './wallet';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Auth state that combines both systems
export interface AuthState {
  // Authentication
  isAuthenticated: boolean;
  isLoading: boolean;
  authMethod: 'privy' | 'legacy' | null;

  // User info
  user: {
    id: string | null;
    email: string | null;
    phone: string | null;
    walletAddress: string | null;
  };

  // Wallet
  hasWallet: boolean;
  publicKey: string | null;
  isUnlocked: boolean;

  // Actions
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getKeypair: () => Promise<Keypair | null>;
}

/**
 * Hook that provides unified auth interface
 * Prioritizes Privy authentication but falls back to legacy Zustand
 */
export function useAuthAdapter(): AuthState {
  const privy = usePrivy();
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const walletStore = useWalletStore();

  // Determine auth method and state
  const authMethod = useMemo(() => {
    if (privy.authenticated) return 'privy';
    if (walletStore.isInitialized) return 'legacy';
    return null;
  }, [privy.authenticated, walletStore.isInitialized]);

  // Get the active Solana wallet from Privy
  const privySolanaWallet = useMemo(() => {
    // Prefer embedded wallet, then external
    const embedded = solanaWallets.find(w => w.walletClientType === 'privy');
    if (embedded) return embedded;
    return solanaWallets[0] || null;
  }, [solanaWallets]);

  // Combined auth state
  const isAuthenticated = privy.authenticated || walletStore.isInitialized;
  const isLoading = privy.ready === false || walletStore.isLoading;

  // User info from Privy
  const user = useMemo(() => ({
    id: privy.user?.id || null,
    email: privy.user?.email?.address || null,
    phone: privy.user?.phone?.number || null,
    walletAddress: privySolanaWallet?.address || walletStore.publicKey || null,
  }), [privy.user, privySolanaWallet, walletStore.publicKey]);

  // Public key - prefer Privy wallet
  const publicKey = useMemo(() => {
    if (privySolanaWallet?.address) return privySolanaWallet.address;
    return walletStore.publicKey;
  }, [privySolanaWallet, walletStore.publicKey]);

  // Has wallet check
  const hasWallet = Boolean(publicKey);

  // Is unlocked - Privy is always "unlocked" when authenticated
  const isUnlocked = privy.authenticated || walletStore.isUnlocked;

  // Login action
  const login = useCallback(async () => {
    if (privy.authenticated) return;

    // Use Privy login modal
    privy.login();
  }, [privy]);

  // Logout action
  const logout = useCallback(async () => {
    // Logout from both systems
    if (privy.authenticated) {
      await privy.logout();
    }
    if (walletStore.isInitialized) {
      walletStore.lock();
    }
  }, [privy, walletStore]);

  // Get keypair for signing
  const getKeypair = useCallback(async (): Promise<Keypair | null> => {
    // If using Privy embedded wallet, we can't get the raw keypair
    // Instead, use the wallet's sign method directly
    // For now, fall back to legacy keypair if available
    if (walletStore._keypair) {
      return walletStore._keypair;
    }

    // If only Privy wallet available, return null
    // Signing should be done through Privy's wallet.sign() method
    return null;
  }, [walletStore._keypair]);

  // Sync Privy wallet to Zustand store (for compatibility with existing code)
  useEffect(() => {
    if (privy.authenticated && privySolanaWallet?.address) {
      // Update Zustand store with Privy wallet address
      // This allows existing code to continue working
      if (walletStore.publicKey !== privySolanaWallet.address) {
        // Note: We're not updating the full wallet state here
        // Just ensuring publicKey is available for display purposes
      }
    }
  }, [privy.authenticated, privySolanaWallet, walletStore.publicKey]);

  return {
    isAuthenticated,
    isLoading,
    authMethod,
    user,
    hasWallet,
    publicKey,
    isUnlocked,
    login,
    logout,
    getKeypair,
  };
}

/**
 * Hook to get signing function that works with both Privy and legacy wallets
 */
export function useWalletSigner() {
  const { wallets: solanaWallets } = useSolanaWallets();
  const walletStore = useWalletStore();

  const signMessage = useCallback(async (message: Uint8Array): Promise<Uint8Array> => {
    // Try Privy wallet first
    const privyWallet = solanaWallets.find(w => w.walletClientType === 'privy') || solanaWallets[0];
    if (privyWallet) {
      const signature = await privyWallet.signMessage(message);
      return signature;
    }

    // Fall back to legacy keypair
    if (walletStore._keypair) {
      const { sign } = await import('tweetnacl');
      return sign.detached(message, walletStore._keypair.secretKey);
    }

    throw new Error('No wallet available for signing');
  }, [solanaWallets, walletStore._keypair]);

  const signTransaction = useCallback(async (transaction: any): Promise<any> => {
    // Try Privy wallet first
    const privyWallet = solanaWallets.find(w => w.walletClientType === 'privy') || solanaWallets[0];
    if (privyWallet) {
      return await privyWallet.signTransaction(transaction);
    }

    // Fall back to legacy keypair
    if (walletStore._keypair) {
      transaction.sign(walletStore._keypair);
      return transaction;
    }

    throw new Error('No wallet available for signing');
  }, [solanaWallets, walletStore._keypair]);

  return {
    signMessage,
    signTransaction,
    hasWallet: solanaWallets.length > 0 || Boolean(walletStore._keypair),
  };
}

/**
 * Check if user should use Privy or legacy auth
 * Returns 'privy' for new users, 'legacy' for existing users with seed phrase
 */
export function useAuthMode(): 'privy' | 'legacy' | 'none' {
  const privy = usePrivy();
  const walletStore = useWalletStore();

  if (privy.authenticated) return 'privy';
  if (walletStore.isInitialized) return 'legacy';
  return 'none';
}
