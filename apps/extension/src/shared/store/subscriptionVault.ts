/**
 * Subscription Vault Store
 *
 * Zustand store with Chrome storage persistence for subscription vaults.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionVaultState {
  /** List of vaults */
  vaults: VaultInfo[];
  /** Encrypted subscriber secrets for private vaults (vaultAddress -> encrypted secret) */
  subscriberSecrets: Record<string, string>;
  /** Loading indicator */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Current Solana slot (for claimable calculations) */
  currentSlot: number;

  // Actions
  loadVaults: (walletPubkey: string) => Promise<void>;
  refreshVault: (vaultAddress: string) => Promise<void>;
  addVault: (vault: VaultInfo) => void;
  removeVault: (vaultAddress: string) => void;
  updateVault: (vaultAddress: string, updates: Partial<VaultInfo>) => void;
  setCurrentSlot: (slot: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  saveSecret: (vaultAddress: string, encryptedSecret: string) => void;
  getSecret: (vaultAddress: string) => string | null;
  reset: () => void;

  // Computed helpers (use current slot from state)
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
      // Add vault
      // -------------------------------------------------------------------
      addVault: (vault: VaultInfo) => {
        set((state) => ({
          vaults: [...state.vaults, vault],
        }));
      },

      // -------------------------------------------------------------------
      // Remove vault
      // -------------------------------------------------------------------
      removeVault: (vaultAddress: string) => {
        set((state) => ({
          vaults: state.vaults.filter((v) => v.address !== vaultAddress),
        }));
      },

      // -------------------------------------------------------------------
      // Update vault
      // -------------------------------------------------------------------
      updateVault: (vaultAddress: string, updates: Partial<VaultInfo>) => {
        set((state) => ({
          vaults: state.vaults.map((v) =>
            v.address === vaultAddress ? { ...v, ...updates } : v
          ),
        }));
      },

      // -------------------------------------------------------------------
      // Set current slot
      // -------------------------------------------------------------------
      setCurrentSlot: (slot: number) => {
        set({ currentSlot: slot });
      },

      // -------------------------------------------------------------------
      // Set loading
      // -------------------------------------------------------------------
      setLoading: (loading: boolean) => {
        set({ loading });
      },

      // -------------------------------------------------------------------
      // Set error
      // -------------------------------------------------------------------
      setError: (error: string | null) => {
        set({ error });
      },

      // -------------------------------------------------------------------
      // Save encrypted secret
      // -------------------------------------------------------------------
      saveSecret: (vaultAddress: string, encryptedSecret: string) => {
        set((state) => ({
          subscriberSecrets: {
            ...state.subscriberSecrets,
            [vaultAddress]: encryptedSecret,
          },
        }));
      },

      // -------------------------------------------------------------------
      // Get encrypted secret
      // -------------------------------------------------------------------
      getSecret: (vaultAddress: string) => {
        const state = get();
        return state.subscriberSecrets[vaultAddress] || null;
      },

      // -------------------------------------------------------------------
      // Reset
      // -------------------------------------------------------------------
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
        getItem: async (name) => {
          const result = await chrome.storage.local.get(name);
          return result[name] || null;
        },
        setItem: async (name, value) => {
          await chrome.storage.local.set({ [name]: value });
        },
        removeItem: async (name) => {
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
