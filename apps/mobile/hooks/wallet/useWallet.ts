/**
 * useWallet - Main wallet state and operations hook
 * @module hooks/wallet/useWallet
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSecureStorage, SECURE_KEYS } from '../storage/useSecureStorage';
import { useBiometrics } from '../storage/useBiometrics';

// Wallet types
export interface P01Wallet {
  address: string;
  publicKey: string;
  stealthMetaAddress: string;
  createdAt: number;
  name: string;
  isBackedUp: boolean;
}

export interface WalletBalance {
  native: bigint;
  nativeFormatted: string;
  tokens: TokenBalance[];
  totalUsdValue: number;
}

export interface TokenBalance {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
  balanceFormatted: string;
  usdValue: number;
  logoUri?: string;
}

type WalletStatus = 'uninitialized' | 'locked' | 'unlocked' | 'loading';

interface UseWalletReturn {
  wallet: P01Wallet | null;
  status: WalletStatus;
  isLoading: boolean;
  error: Error | null;
  createWallet: (name?: string) => Promise<{ wallet: P01Wallet; seedPhrase: string } | null>;
  importWallet: (seedPhrase: string, name?: string) => Promise<P01Wallet | null>;
  unlockWallet: () => Promise<boolean>;
  lockWallet: () => void;
  deleteWallet: () => Promise<boolean>;
  exportSeedPhrase: () => Promise<string | null>;
  updateWalletName: (name: string) => Promise<boolean>;
  markAsBackedUp: () => Promise<boolean>;
}

// Crypto utilities (would be replaced with actual implementation)
const cryptoUtils = {
  generateMnemonic: (): string => {
    // Generate 12-word BIP39 mnemonic
    // This is a placeholder - use actual bip39 library
    const words = [
      'abandon', 'ability', 'able', 'about', 'above', 'absent',
      'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident',
    ];
    return words.join(' ');
  },

  validateMnemonic: (mnemonic: string): boolean => {
    const words = mnemonic.trim().split(/\s+/);
    return words.length === 12 || words.length === 24;
  },

  deriveWallet: async (mnemonic: string): Promise<{
    address: string;
    publicKey: string;
    privateKey: string;
  }> => {
    // Derive wallet from mnemonic
    // This is a placeholder - use ethers/viem for actual derivation
    return {
      address: '0x' + '1'.repeat(40),
      publicKey: '0x' + '2'.repeat(64),
      privateKey: '0x' + '3'.repeat(64),
    };
  },

  generateStealthMetaAddress: async (privateKey: string): Promise<string> => {
    // Generate stealth meta-address for receiving private payments
    // This is a placeholder - use actual stealth address library
    return 'st:eth:0x' + '4'.repeat(132);
  },
};

export function useWallet(): UseWalletReturn {
  const [wallet, setWallet] = useState<P01Wallet | null>(null);
  const [status, setStatus] = useState<WalletStatus>('loading');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { getSecure, setSecure, removeSecure, hasSecure } = useSecureStorage({
    requireAuthentication: false,
  });

  const { authenticate, isEnabled: biometricsEnabled } = useBiometrics();

  // Check if wallet exists on mount
  useEffect(() => {
    const checkWallet = async () => {
      setIsLoading(true);
      try {
        const hasWallet = await hasSecure(SECURE_KEYS.WALLET_SEED);
        if (hasWallet) {
          setStatus('locked');
        } else {
          setStatus('uninitialized');
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to check wallet'));
        setStatus('uninitialized');
      } finally {
        setIsLoading(false);
      }
    };

    checkWallet();
  }, [hasSecure]);

  const unlockWallet = useCallback(async (): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      // Require biometric auth if enabled
      if (biometricsEnabled) {
        const authenticated = await authenticate({
          promptMessage: 'Unlock your P-01 wallet',
        });
        if (!authenticated) {
          setIsLoading(false);
          return false;
        }
      }

      // Load wallet data
      const seed = await getSecure<string>(SECURE_KEYS.WALLET_SEED);
      if (!seed) {
        throw new Error('Wallet not found');
      }

      const derived = await cryptoUtils.deriveWallet(seed);
      const stealthMeta = await cryptoUtils.generateStealthMetaAddress(derived.privateKey);

      // Load wallet metadata
      const walletData = await getSecure<Omit<P01Wallet, 'address' | 'publicKey' | 'stealthMetaAddress'>>(
        'p01_wallet_metadata' as any
      );

      setWallet({
        address: derived.address,
        publicKey: derived.publicKey,
        stealthMetaAddress: stealthMeta,
        createdAt: walletData?.createdAt ?? Date.now(),
        name: walletData?.name ?? 'My Wallet',
        isBackedUp: walletData?.isBackedUp ?? false,
      });

      setStatus('unlocked');
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to unlock wallet'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [authenticate, biometricsEnabled, getSecure]);

  const lockWallet = useCallback(() => {
    setWallet(null);
    setStatus('locked');
  }, []);

  const createWallet = useCallback(async (
    name: string = 'My Wallet'
  ): Promise<{ wallet: P01Wallet; seedPhrase: string } | null> => {
    setIsLoading(true);
    setError(null);

    try {
      // Generate new mnemonic
      const seedPhrase = cryptoUtils.generateMnemonic();

      // Derive wallet
      const derived = await cryptoUtils.deriveWallet(seedPhrase);
      const stealthMeta = await cryptoUtils.generateStealthMetaAddress(derived.privateKey);

      // Store securely
      await setSecure(SECURE_KEYS.WALLET_SEED, seedPhrase);
      await setSecure(SECURE_KEYS.WALLET_PRIVATE_KEY, derived.privateKey);

      const walletMetadata = {
        createdAt: Date.now(),
        name,
        isBackedUp: false,
      };

      await setSecure('p01_wallet_metadata' as any, walletMetadata);

      const newWallet: P01Wallet = {
        address: derived.address,
        publicKey: derived.publicKey,
        stealthMetaAddress: stealthMeta,
        ...walletMetadata,
      };

      setWallet(newWallet);
      setStatus('unlocked');

      return { wallet: newWallet, seedPhrase };
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to create wallet'));
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [setSecure]);

  const importWallet = useCallback(async (
    seedPhrase: string,
    name: string = 'Imported Wallet'
  ): Promise<P01Wallet | null> => {
    setIsLoading(true);
    setError(null);

    try {
      // Validate mnemonic
      if (!cryptoUtils.validateMnemonic(seedPhrase)) {
        throw new Error('Invalid seed phrase');
      }

      // Derive wallet
      const derived = await cryptoUtils.deriveWallet(seedPhrase);
      const stealthMeta = await cryptoUtils.generateStealthMetaAddress(derived.privateKey);

      // Store securely
      await setSecure(SECURE_KEYS.WALLET_SEED, seedPhrase);
      await setSecure(SECURE_KEYS.WALLET_PRIVATE_KEY, derived.privateKey);

      const walletMetadata = {
        createdAt: Date.now(),
        name,
        isBackedUp: true, // Imported wallets are considered backed up
      };

      await setSecure('p01_wallet_metadata' as any, walletMetadata);

      const importedWallet: P01Wallet = {
        address: derived.address,
        publicKey: derived.publicKey,
        stealthMetaAddress: stealthMeta,
        ...walletMetadata,
      };

      setWallet(importedWallet);
      setStatus('unlocked');

      return importedWallet;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to import wallet'));
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [setSecure]);

  const deleteWallet = useCallback(async (): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      // Require biometric auth
      if (biometricsEnabled) {
        const authenticated = await authenticate({
          promptMessage: 'Authenticate to delete wallet',
        });
        if (!authenticated) {
          setIsLoading(false);
          return false;
        }
      }

      // Remove all wallet data
      await removeSecure(SECURE_KEYS.WALLET_SEED);
      await removeSecure(SECURE_KEYS.WALLET_PRIVATE_KEY);
      await removeSecure(SECURE_KEYS.STEALTH_SPENDING_KEY);
      await removeSecure(SECURE_KEYS.STEALTH_VIEWING_KEY);
      await removeSecure('p01_wallet_metadata' as any);

      setWallet(null);
      setStatus('uninitialized');

      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to delete wallet'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [authenticate, biometricsEnabled, removeSecure]);

  const exportSeedPhrase = useCallback(async (): Promise<string | null> => {
    setError(null);

    try {
      // Require biometric auth
      const authenticated = await authenticate({
        promptMessage: 'Authenticate to view seed phrase',
      });

      if (!authenticated) {
        return null;
      }

      const seed = await getSecure<string>(SECURE_KEYS.WALLET_SEED);
      return seed;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to export seed phrase'));
      return null;
    }
  }, [authenticate, getSecure]);

  const updateWalletName = useCallback(async (name: string): Promise<boolean> => {
    if (!wallet) return false;

    try {
      const metadata = {
        createdAt: wallet.createdAt,
        name,
        isBackedUp: wallet.isBackedUp,
      };

      await setSecure('p01_wallet_metadata' as any, metadata);
      setWallet(prev => prev ? { ...prev, name } : null);

      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to update wallet name'));
      return false;
    }
  }, [wallet, setSecure]);

  const markAsBackedUp = useCallback(async (): Promise<boolean> => {
    if (!wallet) return false;

    try {
      const metadata = {
        createdAt: wallet.createdAt,
        name: wallet.name,
        isBackedUp: true,
      };

      await setSecure('p01_wallet_metadata' as any, metadata);
      setWallet(prev => prev ? { ...prev, isBackedUp: true } : null);

      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to mark as backed up'));
      return false;
    }
  }, [wallet, setSecure]);

  return {
    wallet,
    status,
    isLoading,
    error,
    createWallet,
    importWallet,
    unlockWallet,
    lockWallet,
    deleteWallet,
    exportSeedPhrase,
    updateWalletName,
    markAsBackedUp,
  };
}
