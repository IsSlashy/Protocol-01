/**
 * useStealth - Manage stealth addresses and keys
 * @module hooks/stealth/useStealth
 */

import { useState, useEffect, useCallback } from 'react';
import { Keypair } from '@solana/web3.js';
import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { useSecureStorage, SECURE_KEYS } from '../storage/useSecureStorage';
import { useWallet } from '../wallet/useWallet';
import {
  generateStealthKeys as generateRealStealthKeys,
  generateStealthAddress as generateRealStealthAddress,
  scanStealthPayment,
  createStealthMeta,
  createMetaAddress,
  parseMetaAddress,
  isMetaAddress,
  isValidStealthAddress,
  parseStealthMemo,
  type StealthKeys as RealStealthKeys,
  type StealthAddress as RealStealthAddress,
  type StealthScanResult,
} from '../../utils/crypto/stealth';

export interface StealthKeys {
  spendingPrivateKey: string;     // hex of Ed25519 secretKey (64 bytes)
  spendingPublicKey: string;      // base58 of Ed25519 pub
  viewingSecretKey: string;       // hex of X25519 secret (32 bytes)
  viewingPublicKey: string;       // hex of X25519 pub (32 bytes)
  spendingKeypair?: Keypair;
  viewingSecret?: Uint8Array;     // raw X25519 secret for crypto ops
}

export interface StealthMetaAddress {
  prefix: string;
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
    expectedViewTag?: number
  ) => Promise<StealthScanResult | null>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}

const stealthCrypto = {
  deriveStealthKeys: async (seedPhrase: string): Promise<StealthKeys> => {
    const seedHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      seedPhrase + ':stealth:spending'
    );
    const viewingHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      seedPhrase + ':stealth:viewing'
    );

    const spendingSeed = hexToBytes(seedHash);
    const viewingSeed = hexToBytes(viewingHash);

    const spendingKeypair = Keypair.fromSeed(spendingSeed);
    // X25519 viewing keypair (not Ed25519)
    const viewingKeypair = nacl.box.keyPair.fromSecretKey(viewingSeed);

    return {
      spendingPrivateKey: bytesToHex(spendingKeypair.secretKey),
      spendingPublicKey: spendingKeypair.publicKey.toBase58(),
      viewingSecretKey: bytesToHex(viewingKeypair.secretKey),
      viewingPublicKey: bytesToHex(viewingKeypair.publicKey),
      spendingKeypair,
      viewingSecret: viewingKeypair.secretKey,
    };
  },
};

export function useStealth(): UseStealthReturn {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [stealthMetaAddress, setStealthMetaAddress] = useState<StealthMetaAddress | null>(null);
  const [generatedAddresses, setGeneratedAddresses] = useState<GeneratedStealthAddress[]>([]);
  const [stealthKeypairs, setStealthKeypairs] = useState<{
    spending?: Keypair;
    viewingSecret?: Uint8Array; // X25519 secret (32 bytes)
  }>({});

  const { getSecure, setSecure, hasSecure } = useSecureStorage({
    requireAuthentication: true,
  });
  const { wallet, status: walletStatus } = useWallet();

  useEffect(() => {
    const checkInitialization = async () => {
      setIsLoading(true);

      try {
        const hasKeys = await hasSecure(SECURE_KEYS.STEALTH_SPENDING_KEY);
        setIsInitialized(hasKeys);

        if (hasKeys) {
          const spendingPub = await getSecure<string>('p01_stealth_spending_pub' as any);
          const viewingPubHex = await getSecure<string>('p01_stealth_viewing_pub' as any);

          if (spendingPub && viewingPubHex) {
            setStealthMetaAddress({
              prefix: 'st:',
              spendingPublicKey: spendingPub,
              viewingPublicKey: viewingPubHex,
              full: await getSecure<string>('p01_stealth_meta_v2' as any) || '',
            });
          }

          const spendingPrivHex = await getSecure<string>(SECURE_KEYS.STEALTH_SPENDING_KEY);
          const viewingSecretHex = await getSecure<string>(SECURE_KEYS.STEALTH_VIEWING_KEY);

          if (spendingPrivHex && viewingSecretHex) {
            try {
              const spendingSecretKey = hexToBytes(spendingPrivHex);
              const viewingSecretKey = hexToBytes(viewingSecretHex);

              // Ed25519 spending key (64-byte secret → Keypair)
              // X25519 viewing secret (32 bytes)
              if (spendingSecretKey.length === 64) {
                setStealthKeypairs({
                  spending: Keypair.fromSecretKey(spendingSecretKey),
                  viewingSecret: viewingSecretKey.length === 32
                    ? viewingSecretKey
                    : undefined,
                });
              }
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
      const seedPhrase = await getSecure<string>(SECURE_KEYS.WALLET_SEED);
      if (!seedPhrase) {
        throw new Error('Seed phrase not available');
      }

      // Derive deterministic stealth keys (Ed25519 spending + X25519 viewing)
      const keys = await stealthCrypto.deriveStealthKeys(seedPhrase);

      // Generate ML-KEM-768 keys for hybrid PQ
      const realKeys = await generateRealStealthKeys(true);

      // Store Ed25519 spending key (64-byte hex)
      await setSecure(SECURE_KEYS.STEALTH_SPENDING_KEY, keys.spendingPrivateKey);
      // Store X25519 viewing secret (32-byte hex)
      await setSecure(SECURE_KEYS.STEALTH_VIEWING_KEY, keys.viewingSecretKey);
      await setSecure('p01_stealth_spending_pub' as any, keys.spendingPublicKey);
      await setSecure('p01_stealth_viewing_pub' as any, keys.viewingPublicKey);

      if (realKeys.kemPubKey) {
        await setSecure('p01_stealth_kem_pub' as any, Buffer.from(realKeys.kemPubKey).toString('base64'));
      }
      if (realKeys.kemSecretKey) {
        await setSecure('p01_stealth_kem_secret' as any, Buffer.from(realKeys.kemSecretKey).toString('base64'));
      }

      // Store keypairs in memory
      if (keys.spendingKeypair && keys.viewingSecret) {
        setStealthKeypairs({
          spending: keys.spendingKeypair,
          viewingSecret: keys.viewingSecret,
        });
      }

      // Create meta-address using deterministic keys + KEM
      // Build a StealthKeys object with the deterministic spending + viewing + KEM
      const metaKeys: RealStealthKeys = {
        spendingKey: keys.spendingKeypair!,
        viewingSecretKey: keys.viewingSecret!,
        viewingPublicKey: nacl.box.keyPair.fromSecretKey(keys.viewingSecret!).publicKey,
        spendingPublicKey: keys.spendingPublicKey,
        kemPubKey: realKeys.kemPubKey,
        kemSecretKey: realKeys.kemSecretKey,
      };
      const v2MetaAddress = createMetaAddress(metaKeys);
      await setSecure('p01_stealth_meta_v2' as any, v2MetaAddress);

      setStealthMetaAddress({
        prefix: 'st:',
        spendingPublicKey: keys.spendingPublicKey,
        viewingPublicKey: keys.viewingPublicKey,
        full: v2MetaAddress,
      });
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
      // Parse st:01.../st:02... meta-address format
      const parsed = parseMetaAddress(recipientMetaAddress);

      const realStealthAddress = generateRealStealthAddress(
        parsed.spendingPubKey,
        parsed.viewingPubKey,
        parsed.kemPubKey,
      );

      const generated: GeneratedStealthAddress = {
        stealthAddress: realStealthAddress.address,
        ephemeralPublicKey: realStealthAddress.ephemeralPublicKey,
        viewTag: realStealthAddress.viewTag,
        timestamp: Date.now(),
      };

      setGeneratedAddresses(prev => [generated, ...prev.slice(0, 99)]);

      return generated;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to generate stealth address'));
      return null;
    }
  }, []);

  const computeStealthAddress = useCallback(async (
    recipientSpendingPubKey: string,
    _ephemeralPublicKey: string
  ): Promise<string | null> => {
    try {
      // This is a simplified path - for proper usage, use generateStealthAddress with meta-address
      console.warn('[Stealth] computeStealthAddress is deprecated, use generateStealthAddress with meta-address');
      return null;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to compute stealth address'));
      return null;
    }
  }, []);

  const scanForPayments = useCallback(async (
    ephemeralPublicKey: string,
    expectedViewTag?: number,
    kemCiphertextBase64?: string,
  ): Promise<StealthScanResult | null> => {
    try {
      // Load KEM secret key from storage (for v2 hybrid payments)
      let kemSecretKey: Uint8Array | undefined;
      const kemSecretBase64 = await getSecure<string>('p01_stealth_kem_secret' as any);
      if (kemSecretBase64) {
        kemSecretKey = new Uint8Array(Buffer.from(kemSecretBase64, 'base64'));
      }

      let kemCiphertext: Uint8Array | undefined;
      if (kemCiphertextBase64) {
        kemCiphertext = new Uint8Array(Buffer.from(kemCiphertextBase64, 'base64'));
      }

      // Get X25519 viewing secret and Ed25519 spending public key
      let viewingSecret: Uint8Array;
      let spendingPubKey: Uint8Array;

      if (stealthKeypairs.viewingSecret && stealthKeypairs.spending) {
        viewingSecret = stealthKeypairs.viewingSecret;
        spendingPubKey = stealthKeypairs.spending.publicKey.toBytes();
      } else {
        const viewingSecretHex = await getSecure<string>(SECURE_KEYS.STEALTH_VIEWING_KEY);
        const spendingPrivHex = await getSecure<string>(SECURE_KEYS.STEALTH_SPENDING_KEY);

        if (!viewingSecretHex || !spendingPrivHex) {
          throw new Error('Stealth keys not available for scanning');
        }

        viewingSecret = hexToBytes(viewingSecretHex);
        const spendingSecretKey = hexToBytes(spendingPrivHex);
        spendingPubKey = Keypair.fromSecretKey(spendingSecretKey).publicKey.toBytes();
      }

      return scanStealthPayment(
        ephemeralPublicKey,
        viewingSecret,
        spendingPubKey,
        expectedViewTag,
        kemCiphertext,
        kemSecretKey,
      );
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
