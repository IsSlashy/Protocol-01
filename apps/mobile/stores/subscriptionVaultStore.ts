import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PublicKey } from '@solana/web3.js';
import { poseidon1 } from 'poseidon-lite';
import { getConnection } from '../services/solana/connection';
import {
  type VaultInfo,
  type SubscribeNormalConfig,
  type SubscribePrivateConfig,
  type ProofGenerator,
  type WalletSigner,
  subscribeNormal,
  subscribePrivate,
  claimPeriod,
  pauseNormal,
  pausePrivate,
  resumeNormal,
  resumePrivate,
  cancelNormal,
  cancelPrivate,
  fetchVault,
  computeClaimable,
  computeClaimableAmount,
} from '../services/subscriptionVault';
import type { ShieldReceipt, PoolConfig } from '../services/denominatedPool';
import { useWalletStore, getPrivySigner } from './walletStore';

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
  claimPeriodAction: (vaultAddress: string) => Promise<string>;
  pauseNormalAction: (vaultAddress: string) => Promise<string>;
  pausePrivateAction: (
    vaultAddress: string,
    subscriberSecret: bigint,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  resumeNormalAction: (vaultAddress: string) => Promise<string>;
  resumePrivateAction: (
    vaultAddress: string,
    subscriberSecret: bigint,
    proofGenerator: ProofGenerator,
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
        set(state => ({
          vaults: state.vaults.filter(v => v.vaultAddress !== vaultAddress),
          subscriberSecrets: Object.fromEntries(
            Object.entries(state.subscriberSecrets).filter(([k]) => k !== vaultAddress)
          ),
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

          set(state => ({
            isLoading: false,
            progress: null,
            vaults: [storedVault, ...state.vaults],
            subscriberSecrets: {
              ...state.subscriberSecrets,
              [vaultPDA.toBase58()]: subscriberSecret.toString(),
            },
          }));

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] subscribePrivate error:', err);
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
          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] pausePrivate error:', err);
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
          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] resumePrivate error:', err);
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

          // Remove vault from store
          set(state => ({
            isLoading: false,
            progress: null,
            vaults: state.vaults.filter(v => v.vaultAddress !== vaultAddress),
            subscriberSecrets: Object.fromEntries(
              Object.entries(state.subscriberSecrets).filter(([k]) => k !== vaultAddress)
            ),
          }));

          return sig;
        } catch (err) {
          console.error('[SubscriptionVault] cancelPrivate error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      reset: () => {
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
        subscriberSecrets: state.subscriberSecrets,
      }),
    },
  ),
);
