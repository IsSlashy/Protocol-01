/**
 * useStealth - Manage stealth addresses and keys
 * @module hooks/stealth/useStealth
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSecureStorage, SECURE_KEYS } from '../storage/useSecureStorage';
import { useWallet } from '../wallet/useWallet';

// ERC-5564 Stealth Address scheme types
export interface StealthKeys {
  spendingPrivateKey: string;
  spendingPublicKey: string;
  viewingPrivateKey: string;
  viewingPublicKey: string;
}

export interface StealthMetaAddress {
  prefix: string; // 'st:eth:'
  spendingPublicKey: string;
  viewingPublicKey: string;
  full: string;
}

export interface GeneratedStealthAddress {
  stealthAddress: string;
  ephemeralPublicKey: string;
  viewTag: number;
  timestamp: number;
}

export interface StealthPayment {
  id: string;
  stealthAddress: string;
  ephemeralPublicKey: string;
  amount: bigint;
  amountFormatted: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  sender?: string;
  timestamp: number;
  claimed: boolean;
  claimTxHash?: string;
}

interface UseStealthReturn {
  isInitialized: boolean;
  isLoading: boolean;
  error: Error | null;
  stealthMetaAddress: StealthMetaAddress | null;
  generatedAddresses: GeneratedStealthAddress[];
  initializeStealthKeys: () => Promise<boolean>;
  deriveStealthKeys: (seedPhrase: string) => Promise<StealthKeys | null>;
  generateStealthAddress: (recipientMetaAddress: string) => Promise<GeneratedStealthAddress | null>;
  computeStealthAddress: (
    recipientSpendingPubKey: string,
    ephemeralPrivateKey: string
  ) => Promise<string | null>;
  getViewingPrivateKey: () => Promise<string | null>;
}

// Crypto utilities (placeholder implementations)
const stealthCrypto = {
  // Generate stealth keys from wallet seed
  deriveStealthKeys: async (seedPhrase: string): Promise<StealthKeys> => {
    // In real implementation:
    // 1. Derive spending key from seed using BIP-32 path m/5564'/0'/0'/0'
    // 2. Derive viewing key from seed using BIP-32 path m/5564'/0'/0'/1'
    // These paths follow ERC-5564 recommendations

    // Placeholder
    const mockKey = (suffix: string) => '0x' + suffix.repeat(32);

    return {
      spendingPrivateKey: mockKey('1'),
      spendingPublicKey: mockKey('2'),
      viewingPrivateKey: mockKey('3'),
      viewingPublicKey: mockKey('4'),
    };
  },

  // Generate ephemeral keypair for sending
  generateEphemeralKey: async (): Promise<{ privateKey: string; publicKey: string }> => {
    // In real implementation: Generate random secp256k1 keypair
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const privateKey = '0x' + Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    return {
      privateKey,
      publicKey: '0x' + '5'.repeat(64), // Placeholder - would derive from private key
    };
  },

  // Compute shared secret using ECDH
  computeSharedSecret: async (
    privateKey: string,
    publicKey: string
  ): Promise<string> => {
    // In real implementation: ECDH multiplication
    return '0x' + '6'.repeat(64);
  },

  // Derive stealth address from shared secret
  deriveStealthAddress: async (
    sharedSecret: string,
    recipientSpendingPubKey: string
  ): Promise<string> => {
    // In real implementation:
    // 1. Hash the shared secret: hashedSecret = keccak256(sharedSecret)
    // 2. Multiply recipient's spending public key by the hashed secret
    // 3. Derive address from resulting public key

    return '0x' + '7'.repeat(40);
  },

  // Compute view tag for efficient scanning
  computeViewTag: (sharedSecret: string): number => {
    // First byte of hashed shared secret
    // Used for efficient filtering during scanning
    return parseInt(sharedSecret.slice(2, 4), 16);
  },

  // Parse stealth meta-address
  parseStealthMetaAddress: (metaAddress: string): StealthMetaAddress | null => {
    if (!metaAddress.startsWith('st:eth:0x')) {
      return null;
    }

    const data = metaAddress.slice(9); // Remove 'st:eth:0x'

    // Format: spendingPubKey (66 chars) + viewingPubKey (66 chars)
    if (data.length < 132) {
      return null;
    }

    return {
      prefix: 'st:eth:',
      spendingPublicKey: '0x' + data.slice(0, 66),
      viewingPublicKey: '0x' + data.slice(66, 132),
      full: metaAddress,
    };
  },

  // Encode stealth meta-address
  encodeStealthMetaAddress: (keys: StealthKeys): string => {
    const spending = keys.spendingPublicKey.replace('0x', '');
    const viewing = keys.viewingPublicKey.replace('0x', '');
    return `st:eth:0x${spending}${viewing}`;
  },
};

export function useStealth(): UseStealthReturn {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [stealthMetaAddress, setStealthMetaAddress] = useState<StealthMetaAddress | null>(null);
  const [generatedAddresses, setGeneratedAddresses] = useState<GeneratedStealthAddress[]>([]);

  const { getSecure, setSecure, hasSecure } = useSecureStorage({
    requireAuthentication: true,
  });
  const { wallet, status: walletStatus } = useWallet();

  // Check if stealth keys are initialized
  useEffect(() => {
    const checkInitialization = async () => {
      setIsLoading(true);

      try {
        const hasKeys = await hasSecure(SECURE_KEYS.STEALTH_SPENDING_KEY);
        setIsInitialized(hasKeys);

        if (hasKeys) {
          // Load stealth meta-address
          const spendingPub = await getSecure<string>('p01_stealth_spending_pub' as any);
          const viewingPub = await getSecure<string>('p01_stealth_viewing_pub' as any);

          if (spendingPub && viewingPub) {
            setStealthMetaAddress({
              prefix: 'st:eth:',
              spendingPublicKey: spendingPub,
              viewingPublicKey: viewingPub,
              full: `st:eth:0x${spendingPub.replace('0x', '')}${viewingPub.replace('0x', '')}`,
            });
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to check stealth initialization'));
      } finally {
        setIsLoading(false);
      }
    };

    if (walletStatus === 'unlocked') {
      checkInitialization();
    }
  }, [walletStatus, hasSecure, getSecure]);

  const deriveStealthKeys = useCallback(async (
    seedPhrase: string
  ): Promise<StealthKeys | null> => {
    try {
      return await stealthCrypto.deriveStealthKeys(seedPhrase);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to derive stealth keys'));
      return null;
    }
  }, []);

  const initializeStealthKeys = useCallback(async (): Promise<boolean> => {
    if (!wallet) {
      setError(new Error('Wallet not unlocked'));
      return false;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Get seed phrase to derive keys
      const seedPhrase = await getSecure<string>(SECURE_KEYS.WALLET_SEED);
      if (!seedPhrase) {
        throw new Error('Seed phrase not available');
      }

      // Derive stealth keys
      const keys = await stealthCrypto.deriveStealthKeys(seedPhrase);

      // Store keys securely
      await setSecure(SECURE_KEYS.STEALTH_SPENDING_KEY, keys.spendingPrivateKey);
      await setSecure(SECURE_KEYS.STEALTH_VIEWING_KEY, keys.viewingPrivateKey);
      await setSecure('p01_stealth_spending_pub' as any, keys.spendingPublicKey);
      await setSecure('p01_stealth_viewing_pub' as any, keys.viewingPublicKey);

      // Generate meta-address
      const metaAddress = stealthCrypto.encodeStealthMetaAddress(keys);
      const parsed = stealthCrypto.parseStealthMetaAddress(metaAddress);

      setStealthMetaAddress(parsed);
      setIsInitialized(true);

      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to initialize stealth keys'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [wallet, getSecure, setSecure]);

  const generateStealthAddress = useCallback(async (
    recipientMetaAddress: string
  ): Promise<GeneratedStealthAddress | null> => {
    setError(null);

    try {
      // Parse recipient's stealth meta-address
      const parsed = stealthCrypto.parseStealthMetaAddress(recipientMetaAddress);
      if (!parsed) {
        throw new Error('Invalid stealth meta-address');
      }

      // Generate ephemeral keypair
      const ephemeral = await stealthCrypto.generateEphemeralKey();

      // Compute shared secret
      const sharedSecret = await stealthCrypto.computeSharedSecret(
        ephemeral.privateKey,
        parsed.viewingPublicKey
      );

      // Derive stealth address
      const stealthAddress = await stealthCrypto.deriveStealthAddress(
        sharedSecret,
        parsed.spendingPublicKey
      );

      // Compute view tag for efficient scanning
      const viewTag = stealthCrypto.computeViewTag(sharedSecret);

      const generated: GeneratedStealthAddress = {
        stealthAddress,
        ephemeralPublicKey: ephemeral.publicKey,
        viewTag,
        timestamp: Date.now(),
      };

      // Store for reference
      setGeneratedAddresses(prev => [generated, ...prev.slice(0, 99)]);

      return generated;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to generate stealth address'));
      return null;
    }
  }, []);

  const computeStealthAddress = useCallback(async (
    recipientSpendingPubKey: string,
    ephemeralPrivateKey: string
  ): Promise<string | null> => {
    try {
      // Get our viewing key
      const viewingKey = await getSecure<string>(SECURE_KEYS.STEALTH_VIEWING_KEY);
      if (!viewingKey) {
        throw new Error('Viewing key not available');
      }

      // Compute shared secret
      const sharedSecret = await stealthCrypto.computeSharedSecret(
        viewingKey,
        recipientSpendingPubKey
      );

      // Derive address
      return await stealthCrypto.deriveStealthAddress(
        sharedSecret,
        recipientSpendingPubKey
      );
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to compute stealth address'));
      return null;
    }
  }, [getSecure]);

  const getViewingPrivateKey = useCallback(async (): Promise<string | null> => {
    return await getSecure<string>(SECURE_KEYS.STEALTH_VIEWING_KEY);
  }, [getSecure]);

  return {
    isInitialized,
    isLoading,
    error,
    stealthMetaAddress,
    generatedAddresses,
    initializeStealthKeys,
    deriveStealthKeys,
    generateStealthAddress,
    computeStealthAddress,
    getViewingPrivateKey,
  };
}
