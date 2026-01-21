/**
 * useStealth - Manage stealth addresses and keys
 * @module hooks/stealth/useStealth
 */

import { useState, useEffect, useCallback } from 'react';
import { Keypair } from '@solana/web3.js';
import * as Crypto from 'expo-crypto';
import { useSecureStorage, SECURE_KEYS } from '../storage/useSecureStorage';
import { useWallet } from '../wallet/useWallet';
import {
  generateStealthKeys as generateRealStealthKeys,
  generateStealthAddress as generateRealStealthAddress,
  scanStealthPayment,
  createStealthMeta,
  isValidStealthAddress,
  type StealthKeys as RealStealthKeys,
  type StealthAddress as RealStealthAddress,
  type StealthScanResult,
} from '../../utils/crypto/stealth';

// Stealth Address scheme types (Solana-compatible)
export interface StealthKeys {
  spendingPrivateKey: string;
  spendingPublicKey: string;
  viewingPrivateKey: string;
  viewingPublicKey: string;
  // Store raw keypairs for crypto operations
  spendingKeypair?: Keypair;
  viewingKeypair?: Keypair;
}

export interface StealthMetaAddress {
  prefix: string; // 'st:sol:'
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
  scanForPayments: (
    ephemeralPublicKey: string,
    expectedViewTag?: string
  ) => Promise<StealthScanResult | null>;
}

// Helper to convert Uint8Array to hex string
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Real crypto utilities using the stealth.ts implementation
const stealthCrypto = {
  // Generate stealth keys from wallet seed using real crypto
  deriveStealthKeys: async (seedPhrase: string): Promise<StealthKeys> => {
    // Hash the seed phrase to create deterministic entropy
    const seedHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      seedPhrase + ':stealth:spending'
    );
    const viewingHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      seedPhrase + ':stealth:viewing'
    );

    // Create keypairs from hashed seeds
    const spendingSeed = hexToBytes(seedHash);
    const viewingSeed = hexToBytes(viewingHash);

    const spendingKeypair = Keypair.fromSeed(spendingSeed);
    const viewingKeypair = Keypair.fromSeed(viewingSeed);

    return {
      spendingPrivateKey: bytesToHex(spendingKeypair.secretKey),
      spendingPublicKey: spendingKeypair.publicKey.toBase58(),
      viewingPrivateKey: bytesToHex(viewingKeypair.secretKey),
      viewingPublicKey: viewingKeypair.publicKey.toBase58(),
      spendingKeypair,
      viewingKeypair,
    };
  },

  // Generate ephemeral keypair for sending using secure randomness from expo-crypto
  generateEphemeralKey: async (): Promise<{ privateKey: string; publicKey: string; keypair: Keypair }> => {
    // Use expo-crypto for secure random bytes instead of Keypair.generate()
    const randomBytes = await Crypto.getRandomBytesAsync(32);
    const keypair = Keypair.fromSeed(randomBytes);
    return {
      privateKey: bytesToHex(keypair.secretKey),
      publicKey: keypair.publicKey.toBase58(),
      keypair,
    };
  },

  // Compute view tag from shared secret hash
  computeViewTag: async (sharedSecretHex: string): Promise<number> => {
    const viewTagHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      sharedSecretHex + 'view_tag'
    );
    // Return first byte as view tag (0-255)
    return parseInt(viewTagHash.slice(0, 2), 16);
  },

  // Parse stealth meta-address (Solana format)
  parseStealthMetaAddress: (metaAddress: string): StealthMetaAddress | null => {
    // Support both st:sol: and st:eth: prefixes for compatibility
    const solPrefix = 'st:sol:';
    const ethPrefix = 'st:eth:';

    let prefix: string;
    let data: string;

    if (metaAddress.startsWith(solPrefix)) {
      prefix = solPrefix;
      data = metaAddress.slice(solPrefix.length);
    } else if (metaAddress.startsWith(ethPrefix)) {
      prefix = ethPrefix;
      data = metaAddress.slice(ethPrefix.length);
    } else {
      return null;
    }

    // Format: spendingPubKey:viewingPubKey (Base58 encoded)
    const parts = data.split(':');
    if (parts.length !== 2) {
      return null;
    }

    const [spendingPublicKey, viewingPublicKey] = parts;

    // Validate as Solana public keys
    if (!isValidStealthAddress(spendingPublicKey) || !isValidStealthAddress(viewingPublicKey)) {
      return null;
    }

    return {
      prefix,
      spendingPublicKey,
      viewingPublicKey,
      full: metaAddress,
    };
  },

  // Encode stealth meta-address (Solana format)
  encodeStealthMetaAddress: (keys: StealthKeys): string => {
    return `st:sol:${keys.spendingPublicKey}:${keys.viewingPublicKey}`;
  },
};

export function useStealth(): UseStealthReturn {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [stealthMetaAddress, setStealthMetaAddress] = useState<StealthMetaAddress | null>(null);
  const [generatedAddresses, setGeneratedAddresses] = useState<GeneratedStealthAddress[]>([]);
  // Store keypairs in memory for crypto operations
  const [stealthKeypairs, setStealthKeypairs] = useState<{
    spending?: Keypair;
    viewing?: Keypair;
  }>({});

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
          // Load stealth meta-address (using Solana Base58 format)
          const spendingPub = await getSecure<string>('p01_stealth_spending_pub' as any);
          const viewingPub = await getSecure<string>('p01_stealth_viewing_pub' as any);

          if (spendingPub && viewingPub) {
            setStealthMetaAddress({
              prefix: 'st:sol:',
              spendingPublicKey: spendingPub,
              viewingPublicKey: viewingPub,
              full: `st:sol:${spendingPub}:${viewingPub}`,
            });
          }

          // Restore keypairs from stored private keys
          const spendingPrivHex = await getSecure<string>(SECURE_KEYS.STEALTH_SPENDING_KEY);
          const viewingPrivHex = await getSecure<string>(SECURE_KEYS.STEALTH_VIEWING_KEY);

          if (spendingPrivHex && viewingPrivHex) {
            try {
              const spendingSecretKey = hexToBytes(spendingPrivHex);
              const viewingSecretKey = hexToBytes(viewingPrivHex);
              setStealthKeypairs({
                spending: Keypair.fromSecretKey(spendingSecretKey),
                viewing: Keypair.fromSecretKey(viewingSecretKey),
              });
            } catch (keypairError) {
              console.warn('Failed to restore stealth keypairs:', keypairError);
            }
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

      // Derive stealth keys using REAL crypto
      const keys = await stealthCrypto.deriveStealthKeys(seedPhrase);

      // Store keys securely (hex encoded private keys)
      await setSecure(SECURE_KEYS.STEALTH_SPENDING_KEY, keys.spendingPrivateKey);
      await setSecure(SECURE_KEYS.STEALTH_VIEWING_KEY, keys.viewingPrivateKey);
      await setSecure('p01_stealth_spending_pub' as any, keys.spendingPublicKey);
      await setSecure('p01_stealth_viewing_pub' as any, keys.viewingPublicKey);

      // Store keypairs in memory for crypto operations
      if (keys.spendingKeypair && keys.viewingKeypair) {
        setStealthKeypairs({
          spending: keys.spendingKeypair,
          viewing: keys.viewingKeypair,
        });
      }

      // Generate meta-address (Solana format: st:sol:spendingPubKey:viewingPubKey)
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
        throw new Error('Invalid stealth meta-address format');
      }

      // Use the REAL stealth address generation from utils/crypto/stealth.ts
      const realStealthAddress = await generateRealStealthAddress(
        parsed.spendingPublicKey,
        parsed.viewingPublicKey
      );

      // Convert viewTag string to number (first 2 hex chars = 0-255)
      const viewTagNum = parseInt(realStealthAddress.viewTag, 16);

      const generated: GeneratedStealthAddress = {
        stealthAddress: realStealthAddress.address,
        ephemeralPublicKey: realStealthAddress.ephemeralPublicKey,
        viewTag: viewTagNum,
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
    ephemeralPublicKey: string
  ): Promise<string | null> => {
    try {
      // Use the REAL stealth address generation
      const realStealthAddress = await generateRealStealthAddress(
        recipientSpendingPubKey,
        recipientSpendingPubKey // In this context, we're computing for a known recipient
      );

      return realStealthAddress.address;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to compute stealth address'));
      return null;
    }
  }, []);

  // Scan for incoming stealth payments - uses REAL scanning from stealth.ts
  const scanForPayments = useCallback(async (
    ephemeralPublicKey: string,
    expectedViewTag?: string
  ): Promise<StealthScanResult | null> => {
    try {
      if (!stealthKeypairs.viewing || !stealthKeypairs.spending) {
        // Try to restore from secure storage
        const viewingPrivHex = await getSecure<string>(SECURE_KEYS.STEALTH_VIEWING_KEY);
        const spendingPrivHex = await getSecure<string>(SECURE_KEYS.STEALTH_SPENDING_KEY);

        if (!viewingPrivHex || !spendingPrivHex) {
          throw new Error('Stealth keys not available for scanning');
        }

        const viewingSecretKey = hexToBytes(viewingPrivHex);
        const spendingSecretKey = hexToBytes(spendingPrivHex);

        // Use the REAL scan function from stealth.ts
        const result = await scanStealthPayment(
          ephemeralPublicKey,
          viewingSecretKey,
          spendingSecretKey,
          expectedViewTag
        );

        return result;
      }

      // Use stored keypairs directly
      const result = await scanStealthPayment(
        ephemeralPublicKey,
        stealthKeypairs.viewing.secretKey,
        stealthKeypairs.spending.secretKey,
        expectedViewTag
      );

      return result;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to scan for stealth payments'));
      return null;
    }
  }, [stealthKeypairs, getSecure]);

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
    scanForPayments,
  };
}
