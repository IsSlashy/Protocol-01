import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { PublicKey } from '@solana/web3.js';
import { poseidon1 } from 'poseidon-lite';
import { getConnection } from '../services/solana/connection';
import {
  type VaultInfo,
  type SubscribeNormalConfig,
  type SubscribePrivateConfig,
  type WalletSigner,
  subscribeNormal,
  subscribePrivate,
  subscribePrivateStark,
  claimPeriod,
  pauseNormal,
  pausePrivate,
  pausePrivateStark,
  resumeNormal,
  resumePrivate,
  resumePrivateStark,
  cancelNormal,
  cancelPrivate,
  fetchVault,
  computeClaimable,
  computeClaimableAmount,
} from '../services/subscriptionVault';
import type { ShieldReceipt, PoolConfig, ProofGenerator } from '../services/denominatedPool';
import { useWalletStore, getPrivySigner } from './walletStore';
import { scheduleLocalNotification } from '../services/notifications';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredVaultInfo {
  vaultAddress: string;
  retailer: string;
  tokenMint: string;
  rate: string; // bigint as string
  intervalSlots: string; // bigint as string
  isNormalMode: boolean;
  isPrivateMode: boolean;
  subscriberSecret?: string; // encrypted, only for private mode
  createdAt: number;
}

interface SubscriptionVaultState {
  // Persisted
  vaults: StoredVaultInfo[];
  subscriberSecrets: Record<string, string>; // vault address → encrypted secret (private mode)

  // Transient (not persisted)
  isLoading: boolean;
  error: string | null;
  progress: string | null;

  // Actions
  addVault: (vault: StoredVaultInfo) => void;
  removeVault: (vaultAddress: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setProgress: (progress: string | null) => void;
  refreshVault: (vaultAddress: string) => Promise<VaultInfo | null>;
  subscribeNormalAction: (
    config: SubscribeNormalConfig,
    vkHashSubscriber: Uint8Array,
  ) => Promise<string>;
  subscribePrivateAction: (
    receipt: ShieldReceipt,
    poolConfig: PoolConfig,
    vaultConfig: SubscribePrivateConfig,
    subscriberSecret: bigint,
    vkHashSubscriber: Uint8Array,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  /** STARK variant: quantum-resistant subscribe_private using pre-verified proof buffer */
  subscribePrivateStarkAction: (
    receipt: ShieldReceipt,
    poolConfig: PoolConfig,
    vaultConfig: SubscribePrivateConfig,
    subscriberSecret: bigint,
    vkHashSubscriber: Uint8Array,
    starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  ) => Promise<string>;
  claimPeriodAction: (vaultAddress: string) => Promise<string>;
  pauseNormalAction: (vaultAddress: string) => Promise<string>;
  pausePrivateAction: (
    vaultAddress: string,
    subscriberSecret: bigint,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  /** STARK variant: quantum-resistant pause_private using pre-verified proof buffer */
  pausePrivateStarkAction: (
    vaultAddress: string,
    starkProofData: { proofBytes: Uint8Array; commitment: bigint; proofSize: number },
  ) => Promise<string>;
  resumeNormalAction: (vaultAddress: string) => Promise<string>;
  resumePrivateAction: (
    vaultAddress: string,
    subscriberSecret: bigint,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  /** STARK variant: quantum-resistant resume_private using pre-verified proof buffer */
  resumePrivateStarkAction: (
    vaultAddress: string,
    starkProofData: { proofBytes: Uint8Array; commitment: bigint; proofSize: number },
  ) => Promise<string>;
  cancelNormalAction: (vaultAddress: string, retailer: string) => Promise<string>;
  cancelPrivateAction: (
    vaultAddress: string,
    retailer: string,
    poolConfig: PoolConfig,
    subscriberSecret: bigint,
    newCommitments: bigint[],
    newRoot: bigint,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Secure secret storage (SecureStore instead of AsyncStorage)
// ---------------------------------------------------------------------------

const SECURE_SECRET_PREFIX = 'p01_vault_secret_';

async function saveSecretSecurely(vaultAddress: string, secret: string): Promise<void> {
  await SecureStore.setItemAsync(`${SECURE_SECRET_PREFIX}${vaultAddress}`, secret);
}

async function loadSecretSecurely(vaultAddress: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${SECURE_SECRET_PREFIX}${vaultAddress}`);
}

async function deleteSecretSecurely(vaultAddress: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${SECURE_SECRET_PREFIX}${vaultAddress}`);
}

/** Format lamports as SOL for notification display */
function formatRateSOL(rateLamports: string | bigint): string {
  const lamports = typeof rateLamports === 'string' ? Number(rateLamports) : Number(rateLamports);
  if (!Number.isFinite(lamports) || lamports <= 0) return '0 SOL';
  return `${(lamports / 1_000_000_000).toFixed(4)} SOL`;
}

/** Fire a subscription lifecycle notification (fire-and-forget, never throws) */
function notifySubscriptionEvent(title: string, body: string, extra?: Record<string, unknown>): void {
  scheduleLocalNotification(title, body, {
    category: 'transaction',
    channelId: 'payments',
    ...extra,
  }).catch(() => {});
}

/** Build a WalletSigner for Privy wallets, or undefined for local keypair wallets. */
function getWalletSignerIfPrivy(): WalletSigner | undefined {
  const { isPrivyWallet, publicKey } = useWalletStore.getState();
  if (!isPrivyWallet || !publicKey) return undefined;
  const signer = getPrivySigner();
  if (!signer) return undefined;
  return { publicKey: new PublicKey(publicKey), signTransaction: signer };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSubscriptionVaultStore = create<SubscriptionVaultState>()(
  persist(
    (set, get) => ({
      // Initial state
      vaults: [],
      subscriberSecrets: {},
      isLoading: false,
      error: null,
      progress: null,

      // ------------------------------------------------------------------
      // Vault Management
      // ------------------------------------------------------------------

      addVault: (vault) => {
        set(state => ({
          vaults: [vault, ...state.vaults],
          error: null,
        }));
      },

      removeVault: (vaultAddress) => {
        deleteSecretSecurely(vaultAddress).catch(() => {});
        set(state => ({
          vaults: state.vaults.filter(v => v.vaultAddress !== vaultAddress),
        }));
      },

      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error }),
      setProgress: (progress) => set({ progress }),

      // ------------------------------------------------------------------
      // Refresh Vault
      // ------------------------------------------------------------------

      refreshVault: async (vaultAddress) => {
        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const vault = await fetchVault(vaultPDA);
          return vault;
        } catch (err) {
          console.error('[SubscriptionVault] refreshVault error:', err);
          return null;
        }
      },

      // ------------------------------------------------------------------
      // Subscribe Normal
      // ------------------------------------------------------------------

      subscribeNormalAction: async (config, vkHashSubscriber) => {
        set({ isLoading: true, error: null, progress: 'Preparing...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await subscribeNormal(
            config,
            vkHashSubscriber,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          // Add vault to store
          const { getPublicKey } = await import('../services/solana/wallet');
          const subscriberPubkey = await getPublicKey();
          if (!subscriberPubkey) throw new Error('Failed to get wallet pubkey');

          const { deriveVaultPDA } = await import('../services/subscriptionVault');
          const [vaultPDA] = deriveVaultPDA(
            config.retailer,
            new PublicKey(subscriberPubkey),
            config.tokenMint
          );

          const storedVault: StoredVaultInfo = {
            vaultAddress: vaultPDA.toBase58(),
            retailer: config.retailer.toBase58(),
            tokenMint: config.tokenMint.toBase58(),
            rate: config.rate.toString(),
            intervalSlots: config.intervalSlots.toString(),
            isNormalMode: true,
            isPrivateMode: false,
            createdAt: Date.now(),
          };

          set(state => ({
            isLoading: false,
            progress: null,
            vaults: [storedVault, ...state.vaults],
          }));

          notifySubscriptionEvent(
            'Subscription Active',
            `Subscribed at ${formatRateSOL(config.rate)} per period`,
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] subscribeNormal error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Subscribe Private
      // ------------------------------------------------------------------

      subscribePrivateAction: async (
        receipt,
        poolConfig,
        vaultConfig,
        subscriberSecret,
        vkHashSubscriber,
        proofGenerator,
      ) => {
        set({ isLoading: true, error: null, progress: 'Preparing...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await subscribePrivate(
            receipt,
            poolConfig,
            vaultConfig,
            proofGenerator,
            subscriberSecret,
            vkHashSubscriber,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          // Add vault to store
          const subscriberCommitment = poseidon1([subscriberSecret]);
          const subscriberCommitmentBytes = new Uint8Array(32);
          let tmpCommitment = subscriberCommitment;
          for (let i = 0; i < 32; i++) {
            subscriberCommitmentBytes[i] = Number(tmpCommitment & 0xFFn);
            tmpCommitment >>= 8n;
          }

          const { deriveVaultPDA } = await import('../services/subscriptionVault');
          const [vaultPDA] = deriveVaultPDA(
            vaultConfig.retailer,
            subscriberCommitmentBytes,
            poolConfig.tokenMint
          );

          const storedVault: StoredVaultInfo = {
            vaultAddress: vaultPDA.toBase58(),
            retailer: vaultConfig.retailer.toBase58(),
            tokenMint: poolConfig.tokenMint.toBase58(),
            rate: vaultConfig.rate.toString(),
            intervalSlots: vaultConfig.intervalSlots.toString(),
            isNormalMode: false,
            isPrivateMode: true,
            createdAt: Date.now(),
          };

          // Save secret to SecureStore (not AsyncStorage)
          await saveSecretSecurely(vaultPDA.toBase58(), subscriberSecret.toString());

          set(state => ({
            isLoading: false,
            progress: null,
            vaults: [storedVault, ...state.vaults],
          }));

          notifySubscriptionEvent(
            'Subscription Active',
            `Subscribed at ${formatRateSOL(vaultConfig.rate)} per period`,
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] subscribePrivate error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Subscribe Private (STARK — quantum-resistant)
      // ------------------------------------------------------------------

      subscribePrivateStarkAction: async (
        receipt,
        poolConfig,
        vaultConfig,
        subscriberSecret,
        vkHashSubscriber,
        starkProofData,
      ) => {
        set({ isLoading: true, error: null, progress: 'Preparing STARK subscription...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await subscribePrivateStark(
            receipt,
            poolConfig,
            vaultConfig,
            subscriberSecret,
            vkHashSubscriber,
            starkProofData,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          // Add vault to store
          const subscriberCommitment = poseidon1([subscriberSecret]);
          const subscriberCommitmentBytes = new Uint8Array(32);
          let tmpCommitment = subscriberCommitment;
          for (let i = 0; i < 32; i++) {
            subscriberCommitmentBytes[i] = Number(tmpCommitment & 0xFFn);
            tmpCommitment >>= 8n;
          }

          const { deriveVaultPDA } = await import('../services/subscriptionVault');
          const [vaultPDA] = deriveVaultPDA(
            vaultConfig.retailer,
            subscriberCommitmentBytes,
            poolConfig.tokenMint
          );

          const storedVault: StoredVaultInfo = {
            vaultAddress: vaultPDA.toBase58(),
            retailer: vaultConfig.retailer.toBase58(),
            tokenMint: poolConfig.tokenMint.toBase58(),
            rate: vaultConfig.rate.toString(),
            intervalSlots: vaultConfig.intervalSlots.toString(),
            isNormalMode: false,
            isPrivateMode: true,
            createdAt: Date.now(),
          };

          // Save secret to SecureStore (not AsyncStorage)
          await saveSecretSecurely(vaultPDA.toBase58(), subscriberSecret.toString());

          set(state => ({
            isLoading: false,
            progress: null,
            vaults: [storedVault, ...state.vaults],
          }));

          notifySubscriptionEvent(
            'Subscription Active',
            `Subscribed at ${formatRateSOL(vaultConfig.rate)} per period`,
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] subscribePrivateStark error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Claim Period
      // ------------------------------------------------------------------

      claimPeriodAction: async (vaultAddress) => {
        set({ isLoading: true, error: null, progress: 'Claiming...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await claimPeriod(
            vaultPDA,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          set({ isLoading: false, progress: null });

          const storedVault = get().vaults.find(v => v.vaultAddress === vaultAddress);
          const rateLabel = storedVault ? formatRateSOL(storedVault.rate) : 'SOL';
          notifySubscriptionEvent(
            'Payment Claimed',
            `${rateLabel} claimed from subscription`,
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] claimPeriod error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Pause Normal
      // ------------------------------------------------------------------

      pauseNormalAction: async (vaultAddress) => {
        set({ isLoading: true, error: null, progress: 'Pausing...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await pauseNormal(
            vaultPDA,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          set({ isLoading: false, progress: null });

          notifySubscriptionEvent(
            'Subscription Paused',
            'Your subscription has been paused',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] pauseNormal error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Pause Private
      // ------------------------------------------------------------------

      pausePrivateAction: async (vaultAddress, subscriberSecret, proofGenerator) => {
        set({ isLoading: true, error: null, progress: 'Pausing...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await pausePrivate(
            vaultPDA,
            subscriberSecret,
            proofGenerator,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          set({ isLoading: false, progress: null });

          notifySubscriptionEvent(
            'Subscription Paused',
            'Your subscription has been paused',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] pausePrivate error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Pause Private (STARK — quantum-resistant)
      // ------------------------------------------------------------------

      pausePrivateStarkAction: async (vaultAddress, starkProofData) => {
        set({ isLoading: true, error: null, progress: 'Pausing (STARK)...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await pausePrivateStark(
            vaultPDA,
            starkProofData,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          set({ isLoading: false, progress: null });

          notifySubscriptionEvent(
            'Subscription Paused',
            'Your subscription has been paused',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] pausePrivateStark error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Resume Normal
      // ------------------------------------------------------------------

      resumeNormalAction: async (vaultAddress) => {
        set({ isLoading: true, error: null, progress: 'Resuming...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await resumeNormal(
            vaultPDA,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          set({ isLoading: false, progress: null });

          notifySubscriptionEvent(
            'Subscription Resumed',
            'Your subscription has been resumed',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] resumeNormal error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Resume Private
      // ------------------------------------------------------------------

      resumePrivateAction: async (vaultAddress, subscriberSecret, proofGenerator) => {
        set({ isLoading: true, error: null, progress: 'Resuming...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await resumePrivate(
            vaultPDA,
            subscriberSecret,
            proofGenerator,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          set({ isLoading: false, progress: null });

          notifySubscriptionEvent(
            'Subscription Resumed',
            'Your subscription has been resumed',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] resumePrivate error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Resume Private (STARK — quantum-resistant)
      // ------------------------------------------------------------------

      resumePrivateStarkAction: async (vaultAddress, starkProofData) => {
        set({ isLoading: true, error: null, progress: 'Resuming (STARK)...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await resumePrivateStark(
            vaultPDA,
            starkProofData,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          set({ isLoading: false, progress: null });

          notifySubscriptionEvent(
            'Subscription Resumed',
            'Your subscription has been resumed',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] resumePrivateStark error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Cancel Normal
      // ------------------------------------------------------------------

      cancelNormalAction: async (vaultAddress, retailer) => {
        set({ isLoading: true, error: null, progress: 'Cancelling...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const retailerKey = new PublicKey(retailer);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await cancelNormal(
            vaultPDA,
            retailerKey,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          // Remove vault from store
          set(state => ({
            isLoading: false,
            progress: null,
            vaults: state.vaults.filter(v => v.vaultAddress !== vaultAddress),
          }));

          notifySubscriptionEvent(
            'Subscription Cancelled',
            'Your subscription has been cancelled',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] cancelNormal error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Cancel Private
      // ------------------------------------------------------------------

      cancelPrivateAction: async (
        vaultAddress,
        retailer,
        poolConfig,
        subscriberSecret,
        newCommitments,
        newRoot,
        proofGenerator,
      ) => {
        set({ isLoading: true, error: null, progress: 'Cancelling...' });

        try {
          const vaultPDA = new PublicKey(vaultAddress);
          const retailerKey = new PublicKey(retailer);
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await cancelPrivate(
            vaultPDA,
            retailerKey,
            poolConfig,
            subscriberSecret,
            newCommitments,
            newRoot,
            proofGenerator,
            (step) => {
              set({ progress: step });
            },
            walletSigner,
          );

          // Remove vault from store and delete secret from SecureStore
          await deleteSecretSecurely(vaultAddress);
          set(state => ({
            isLoading: false,
            progress: null,
            vaults: state.vaults.filter(v => v.vaultAddress !== vaultAddress),
          }));

          notifySubscriptionEvent(
            'Subscription Cancelled',
            'Your subscription has been cancelled',
            { transactionId: sig },
          );

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] cancelPrivate error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      reset: () => {
        // Delete all secrets from SecureStore
        const { vaults } = get();
        for (const v of vaults) {
          deleteSecretSecurely(v.vaultAddress).catch(() => {});
        }
        set({
          vaults: [],
          subscriberSecrets: {},
          isLoading: false,
          error: null,
          progress: null,
        });
      },
    }),
    {
      name: 'p01-subscription-vault',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        vaults: state.vaults,
        // subscriberSecrets are now stored in SecureStore, not AsyncStorage
      }),
    },
  ),
);
