/**
 * Subscription Vault Store
 *
 * Zustand store with Chrome storage persistence for subscription vaults.
 * Wires real on-chain Anchor ix calls for normal and private (ZK) vault operations.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  fetchAllVaults,
  fetchVault,
  subscribeNormal,
  subscribePrivate,
  claimPeriod,
  pauseNormal,
  pausePrivate,
  resumeNormal,
  resumePrivate,
  cancelNormal,
  cancelPrivate,
  computeClaimable,
  computeClaimableAmount,
  computeRefundable,
  nextClaimableSlot,
} from '../services/subscriptionVault';
import type { VaultInfo } from '../services/subscriptionVault.types';
import type { ShieldReceipt } from '../services/denominatedPool';

// Re-export for convenience so pages that import from the store get the type
export type { VaultInfo };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionVaultState {
  /** List of vaults */
  vaults: VaultInfo[];
  /**
   * Encrypted subscriber secrets for private vaults (vaultAddress -> encrypted secret).
   * Secrets are stored as plaintext bigint strings here; for production,
   * wrap with the wallet's session password via the crypto service.
   */
  subscriberSecrets: Record<string, string>;
  /** Loading indicator */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Current Solana slot (for claimable calculations) */
  currentSlot: number;

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  loadVaults: (walletPubkey: string) => Promise<void>;
  refreshVault: (vaultAddress: string) => Promise<void>;
  addVault: (vault: VaultInfo) => void;
  removeVault: (vaultAddress: string) => void;
  updateVault: (vaultAddress: string, updates: Partial<VaultInfo>) => void;
  setCurrentSlot: (slot: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  saveSecret: (vaultAddress: string, secret: string) => void;
  getSecret: (vaultAddress: string) => string | null;
  reset: () => void;

  // -------------------------------------------------------------------
  // On-chain normal-mode actions
  // -------------------------------------------------------------------

  /** Subscribe to a service with wallet deposit (no ZK proof required). */
  createNormalVault: (params: {
    retailer: string;
    tokenMint: string;
    amount: number;
    rate: number;
    intervalSlots: number;
    vkHashSubscriber?: Uint8Array;
  }) => Promise<string>;

  /** Pause a normal vault subscription. */
  pauseNormalVault: (vaultAddress: string) => Promise<string>;

  /** Resume a paused normal vault subscription. */
  resumeNormalVault: (vaultAddress: string) => Promise<string>;

  /** Cancel a normal vault and refund subscriber. */
  cancelNormalVault: (vaultAddress: string) => Promise<string>;

  /** Claim accrued periods (retailer only). */
  claimVaultPeriod: (vaultAddress: string) => Promise<string>;

  // -------------------------------------------------------------------
  // On-chain private-mode actions
  // -------------------------------------------------------------------

  /**
   * Subscribe with private ZK mode (Phase 1, C3-free).
   *
   * Consumes a shielded denominated note (ShieldReceipt from the denominated
   * pool store) and generates a circuit 1 (pool_commitment) STARK proof to
   * call subscribe_private_stark on-chain.
   *
   * subscriberOwnershipCommitment is the bigint stored from the subscriber's
   * STARK circuit-0 proof (used for pause/resume/cancel authentication).
   */
  createPrivateVault: (params: {
    receipt: ShieldReceipt;
    poolPDA: string;
    treePDA: string;
    retailer: string;
    rate: bigint;
    intervalSlots: bigint;
    subscriberOwnershipCommitment: bigint;
    vkHashSubscriber?: Uint8Array;
    onProgress?: (step: string) => void;
  }) => Promise<string>;

  /** Pause a private vault (generates circuit-0 STARK proof). */
  pausePrivateVault: (vaultAddress: string, onProgress?: (step: string) => void) => Promise<string>;

  /** Resume a private vault (generates circuit-0 STARK proof). */
  resumePrivateVault: (vaultAddress: string, onProgress?: (step: string) => void) => Promise<string>;

  /** Cancel a private vault (generates circuit-0 STARK proof, refund-via-relayer). */
  cancelPrivateVault: (vaultAddress: string, onProgress?: (step: string) => void) => Promise<string>;

  // -------------------------------------------------------------------
  // Computed helpers (use current slot from state)
  // -------------------------------------------------------------------

  getClaimable: (vaultAddress: string) => number;
  getClaimableAmount: (vaultAddress: string) => number;
  getRefundable: (vaultAddress: string) => number;
  getNextClaimableSlot: (vaultAddress: string) => number | null;
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
      loading: false,
      error: null,
      currentSlot: 0,

      // -------------------------------------------------------------------
      // Load all vaults for a wallet
      // -------------------------------------------------------------------
      loadVaults: async (walletPubkey: string) => {
        set({ loading: true, error: null });

        try {
          const vaults = await fetchAllVaults(walletPubkey);
          set({ vaults, loading: false });
        } catch (error) {
          console.error('[SubscriptionVaultStore] loadVaults error:', error);
          set({
            loading: false,
            error: (error as Error).message,
          });
        }
      },

      // -------------------------------------------------------------------
      // Refresh a single vault
      // -------------------------------------------------------------------
      refreshVault: async (vaultAddress: string) => {
        try {
          const vault = await fetchVault(vaultAddress);
          if (vault) {
            set((state) => ({
              vaults: state.vaults.map((v) =>
                v.address === vaultAddress ? vault : v
              ),
            }));
          }
        } catch (error) {
          console.error('[SubscriptionVaultStore] refreshVault error:', error);
        }
      },

      // -------------------------------------------------------------------
      // CRUD helpers
      // -------------------------------------------------------------------
      addVault: (vault: VaultInfo) => {
        set((state) => ({
          vaults: [...state.vaults, vault],
        }));
      },

      removeVault: (vaultAddress: string) => {
        set((state) => ({
          vaults: state.vaults.filter((v) => v.address !== vaultAddress),
        }));
      },

      updateVault: (vaultAddress: string, updates: Partial<VaultInfo>) => {
        set((state) => ({
          vaults: state.vaults.map((v) =>
            v.address === vaultAddress ? { ...v, ...updates } : v
          ),
        }));
      },

      setCurrentSlot: (slot: number) => set({ currentSlot: slot }),
      setLoading: (loading: boolean) => set({ loading }),
      setError: (error: string | null) => set({ error }),

      saveSecret: (vaultAddress: string, secret: string) => {
        set((state) => ({
          subscriberSecrets: {
            ...state.subscriberSecrets,
            [vaultAddress]: secret,
          },
        }));
      },

      getSecret: (vaultAddress: string) => {
        return get().subscriberSecrets[vaultAddress] || null;
      },

      reset: () => {
        set({
          vaults: [],
          subscriberSecrets: {},
          loading: false,
          error: null,
          currentSlot: 0,
        });
      },

      // -------------------------------------------------------------------
      // Normal-mode on-chain actions
      // -------------------------------------------------------------------

      createNormalVault: async (params) => {
        set({ loading: true, error: null });
        try {
          const sig = await subscribeNormal({
            retailer: params.retailer,
            tokenMint: params.tokenMint,
            amount: params.amount,
            rate: params.rate,
            intervalSlots: params.intervalSlots,
            vkHashSubscriber: params.vkHashSubscriber ?? new Uint8Array(32),
          });
          // Reload vaults from chain
          const walletPk = (await import('../store/wallet')).useWalletStore.getState().publicKey;
          if (walletPk) await get().loadVaults(walletPk);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      pauseNormalVault: async (vaultAddress: string) => {
        set({ loading: true, error: null });
        try {
          const sig = await pauseNormal(vaultAddress);
          await get().refreshVault(vaultAddress);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      resumeNormalVault: async (vaultAddress: string) => {
        set({ loading: true, error: null });
        try {
          const sig = await resumeNormal(vaultAddress);
          await get().refreshVault(vaultAddress);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      cancelNormalVault: async (vaultAddress: string) => {
        set({ loading: true, error: null });
        try {
          const sig = await cancelNormal(vaultAddress);
          // Remove from local state (vault is closed on-chain)
          get().removeVault(vaultAddress);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      claimVaultPeriod: async (vaultAddress: string) => {
        set({ loading: true, error: null });
        try {
          const sig = await claimPeriod(vaultAddress);
          await get().refreshVault(vaultAddress);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      // -------------------------------------------------------------------
      // Private-mode on-chain actions
      // -------------------------------------------------------------------

      createPrivateVault: async (params) => {
        set({ loading: true, error: null });
        try {
          const sig = await subscribePrivate({
            receipt: params.receipt,
            poolPDA: params.poolPDA,
            treePDA: params.treePDA,
            retailer: params.retailer,
            rate: params.rate,
            intervalSlots: params.intervalSlots,
            subscriberOwnershipCommitment: params.subscriberOwnershipCommitment,
            vkHashSubscriber: params.vkHashSubscriber ?? new Uint8Array(32),
            onProgress: params.onProgress,
          });
          // Reload vaults after successful subscription.
          const walletPk = (await import('../store/wallet')).useWalletStore.getState().publicKey;
          if (walletPk) await get().loadVaults(walletPk);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      pausePrivateVault: async (vaultAddress: string, onProgress?: (step: string) => void) => {
        set({ loading: true, error: null });
        const secret = get().getSecret(vaultAddress);
        if (!secret) {
          set({ loading: false, error: 'Subscriber secret not found. Cannot generate ZK proof.' });
          throw new Error('Subscriber secret not found for vault ' + vaultAddress);
        }
        try {
          const sig = await pausePrivate(vaultAddress, secret, onProgress);
          await get().refreshVault(vaultAddress);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      resumePrivateVault: async (vaultAddress: string, onProgress?: (step: string) => void) => {
        set({ loading: true, error: null });
        const secret = get().getSecret(vaultAddress);
        if (!secret) {
          set({ loading: false, error: 'Subscriber secret not found. Cannot generate ZK proof.' });
          throw new Error('Subscriber secret not found for vault ' + vaultAddress);
        }
        try {
          const sig = await resumePrivate(vaultAddress, secret, onProgress);
          await get().refreshVault(vaultAddress);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      cancelPrivateVault: async (vaultAddress: string, onProgress?: (step: string) => void) => {
        set({ loading: true, error: null });
        const secret = get().getSecret(vaultAddress);
        if (!secret) {
          set({ loading: false, error: 'Subscriber secret not found. Cannot generate ZK proof.' });
          throw new Error('Subscriber secret not found for vault ' + vaultAddress);
        }
        try {
          const sig = await cancelPrivate(vaultAddress, secret, onProgress);
          get().removeVault(vaultAddress);
          set({ loading: false });
          return sig;
        } catch (error) {
          set({ loading: false, error: (error as Error).message });
          throw error;
        }
      },

      // -------------------------------------------------------------------
      // Computed helpers
      // -------------------------------------------------------------------
      getClaimable: (vaultAddress: string) => {
        const state = get();
        const vault = state.vaults.find((v) => v.address === vaultAddress);
        if (!vault) return 0;
        return computeClaimable(vault, state.currentSlot);
      },

      getClaimableAmount: (vaultAddress: string) => {
        const state = get();
        const vault = state.vaults.find((v) => v.address === vaultAddress);
        if (!vault) return 0;
        return computeClaimableAmount(vault, state.currentSlot);
      },

      getRefundable: (vaultAddress: string) => {
        const state = get();
        const vault = state.vaults.find((v) => v.address === vaultAddress);
        if (!vault) return 0;
        return computeRefundable(vault, state.currentSlot);
      },

      getNextClaimableSlot: (vaultAddress: string) => {
        const state = get();
        const vault = state.vaults.find((v) => v.address === vaultAddress);
        if (!vault) return null;
        return nextClaimableSlot(vault);
      },
    }),
    {
      name: 'p01-subscription-vault',
      storage: createJSONStorage(() => ({
        getItem: async (name: string) => {
          const result = await chrome.storage.local.get(name);
          return result[name] || null;
        },
        setItem: async (name: string, value: string) => {
          await chrome.storage.local.set({ [name]: value });
        },
        removeItem: async (name: string) => {
          await chrome.storage.local.remove(name);
        },
      })),
      partialize: (state) => ({
        vaults: state.vaults,
        subscriberSecrets: state.subscriberSecrets,
        currentSlot: state.currentSlot,
      }),
    }
  )
);
