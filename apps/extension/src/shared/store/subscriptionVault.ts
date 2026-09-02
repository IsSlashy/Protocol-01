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
  subscribePrivate,
  claimPeriod,
  pauseNormal,
  pausePrivate,
  resumeNormal,
  resumePrivate,
  computeClaimable,
  computeClaimableAmount,
  computeOutstandingToRetailer,
  entitlementStatus,
  nextClaimableSlot,
} from '../services/subscriptionVault';
import type { EntitlementStatus } from '../services/subscriptionVault';
import type { VaultInfo } from '../services/subscriptionVault.types';
import type { ShieldReceipt } from '../services/denominatedPool';
import {
  encryptForSession,
  decryptFromSession,
  isEncryptedBlob,
  getSessionPassword,
  type EncryptedBlob,
} from '../services/sessionCrypto';

// Re-export for convenience so pages that import from the store get the type
export type { VaultInfo };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionVaultState {
  /** List of vaults */
  vaults: VaultInfo[];
  /**
   * Subscriber secrets for private vaults (vaultAddress -> secret).
   *
   * Stored ENCRYPTED at rest: each value is an AES-256-GCM EncryptedBlob keyed
   * by the in-memory session password (sessionCrypto). Legacy entries may still
   * be plaintext bigint strings — getSecret tolerates both and re-encrypts is
   * not auto-triggered (the secret is only read on pause/resume).
   */
  subscriberSecrets: Record<string, EncryptedBlob | string>;
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
  /**
   * Encrypt + persist a subscriber secret. Async because encryption uses
   * WebCrypto + PBKDF2. Throws if the wallet is locked (no session password) —
   * we must never write the secret to disk in plaintext.
   */
  saveSecret: (vaultAddress: string, secret: string) => Promise<void>;
  /** Decrypt + return a subscriber secret (or null if absent / undecryptable). */
  getSecret: (vaultAddress: string) => Promise<string | null>;
  reset: () => void;

  // -------------------------------------------------------------------
  // On-chain LEGACY normal-mode actions. There is no createNormalVault: the
  // on-chain `subscribe_normal` derived the vault address from the subscriber's
  // wallet, which made every wallet-mode subscription publicly linkable. These
  // only service vaults created before that instruction was removed.
  // -------------------------------------------------------------------

  /** Pause a normal vault subscription. */
  pauseNormalVault: (vaultAddress: string) => Promise<string>;

  /** Resume a paused normal vault subscription. */
  resumeNormalVault: (vaultAddress: string) => Promise<string>;

  /**
   * Push a vault's accrued periods to its retailer. Permissionless — the local
   * wallet only pays the fee, and the retailer is read off the vault.
   */
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
   * STARK circuit-0 proof (used for pause/resume authentication).
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
    /** Service id for the license-key HKDF info (slug, else retailer base58). */
    serviceId?: string;
    /** Display name stored next to the license key the service persists at confirmation. */
    serviceName?: string;
    onProgress?: (step: string) => void;
  }) => Promise<string>;

  /** Pause a private vault (generates circuit-0 STARK proof). */
  pausePrivateVault: (vaultAddress: string, onProgress?: (step: string) => void) => Promise<string>;

  /** Resume a private vault (generates circuit-0 STARK proof). */
  resumePrivateVault: (vaultAddress: string, onProgress?: (step: string) => void) => Promise<string>;

  // -------------------------------------------------------------------
  // Computed helpers (use current slot from state)
  // -------------------------------------------------------------------

  getClaimable: (vaultAddress: string) => number;
  getClaimableAmount: (vaultAddress: string) => number;
  /**
   * What the retailer is still owed on this vault, in atomic units.
   *
   * NOT a refund quote. A subscription is a one-way prepaid envelope: money that
   * enters a vault can only ever leave it toward the retailer. Replaces
   * `getRefundable`.
   */
  getOutstandingToRetailer: (vaultAddress: string) => number;
  getNextClaimableSlot: (vaultAddress: string) => number | null;
  /**
   * What the UI is allowed to say about this vault, using the slot last polled.
   *
   * Never derive a badge from `vault.isActive`: the program writes it `true` at
   * subscribe and `false` nowhere, so an exhausted subscription reports `true`
   * for ever and the popup rendered it ACTIVE. `'unknown'` covers the other
   * half of the problem — `currentSlot` starts at 0 and is persisted, so a
   * freshly opened popup can be holding no clock at all.
   */
  getEntitlementStatus: (vaultAddress: string) => EntitlementStatus | 'missing';
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

      saveSecret: async (vaultAddress: string, secret: string) => {
        // Encrypt at rest with the in-memory session password (AES-256-GCM).
        // The subscribe flow runs while the wallet is unlocked, so the password
        // is available. Refuse to persist plaintext — an uncontrollable-but-
        // private vault is preferable to leaking the controlling secret.
        const password = getSessionPassword();
        if (!password) {
          throw new Error(
            'Wallet is locked — cannot encrypt the subscriber secret. Unlock and retry.',
          );
        }
        const blob = await encryptForSession(secret, password);
        set((state) => ({
          subscriberSecrets: {
            ...state.subscriberSecrets,
            [vaultAddress]: blob,
          },
        }));
      },

      getSecret: async (vaultAddress: string) => {
        const stored = get().subscriberSecrets[vaultAddress];
        if (!stored) return null;
        // Legacy plaintext entry (pre-encryption): return as-is.
        if (typeof stored === 'string') return stored;
        if (isEncryptedBlob(stored)) {
          const password = getSessionPassword();
          if (!password) return null; // locked — caller surfaces "unlock first"
          try {
            return await decryptFromSession(stored, password);
          } catch (e) {
            console.warn('[SubscriptionVaultStore] getSecret decrypt failed:', e);
            return null;
          }
        }
        return null;
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
      // LEGACY normal-mode on-chain actions (service existing vaults only)
      // -------------------------------------------------------------------

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
            serviceId: params.serviceId,
            serviceName: params.serviceName,
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
        const secret = await get().getSecret(vaultAddress);
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
        const secret = await get().getSecret(vaultAddress);
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

      getOutstandingToRetailer: (vaultAddress: string) => {
        const state = get();
        const vault = state.vaults.find((v) => v.address === vaultAddress);
        if (!vault) return 0;
        return computeOutstandingToRetailer(vault);
      },

      getNextClaimableSlot: (vaultAddress: string) => {
        const state = get();
        const vault = state.vaults.find((v) => v.address === vaultAddress);
        if (!vault) return null;
        return nextClaimableSlot(vault);
      },

      getEntitlementStatus: (vaultAddress: string) => {
        const state = get();
        const vault = state.vaults.find((v) => v.address === vaultAddress);
        if (!vault) return 'missing';
        return entitlementStatus(vault, state.currentSlot);
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
