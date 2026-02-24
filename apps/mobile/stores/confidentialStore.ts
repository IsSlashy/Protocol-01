import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  getZkSplService,
  resetZkSplService,
  NATIVE_SOL_MINT,
  NATIVE_SOL_MINT_STR,
  type ZkSplService,
} from '../services/zkspl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfidentialState {
  // Persisted state
  isInitialized: boolean;
  isLoading: boolean;
  /** Per-token confidential balances (tokenMint -> balance in lamports) */
  balances: Record<string, number>;
  /** Account status (tokenMint -> exists on-chain) */
  accounts: Record<string, boolean>;
  /** Pending credits awaiting apply (tokenMint -> count) */
  pendingCredits: Record<string, number>;
  /** Error message */
  error: string | null;

  // Internal (not persisted)
  _service: ZkSplService | null;

  // Actions
  initialize: () => Promise<void>;
  ensureInitialized: () => Promise<boolean>;
  refreshBalance: (tokenMint?: string) => Promise<void>;
  deposit: (tokenMint: string, amount: number) => Promise<string>;
  withdraw: (tokenMint: string, amount: number) => Promise<string>;
  confidentialTransfer: (
    tokenMint: string,
    recipient: string,
    amount: number,
  ) => Promise<string>;
  applyPending: (
    tokenMint: string,
    amount: number,
    amountSalt: string,
  ) => Promise<string>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConfidentialStore = create<ConfidentialState>()(
  persist(
    (set, get) => ({
      // Initial state
      isInitialized: false,
      isLoading: false,
      balances: {},
      accounts: {},
      pendingCredits: {},
      error: null,
      _service: null,

      /**
       * Initialize the confidential balance system.
       * Checks if a confidential account exists on-chain for native SOL;
       * creates one if not.
       */
      initialize: async () => {
        set({ isLoading: true, error: null });

        try {
          const service = await getZkSplService();
          if (!service) {
            throw new Error('Could not create ZkSPL service. Wallet may not be available.');
          }

          set({ _service: service });

          // Check if on-chain account exists for native SOL
          const accountInfo = await service.getAccountInfo(NATIVE_SOL_MINT);
          const accountExists = accountInfo !== null && accountInfo.isInitialized;

          if (!accountExists) {
            // Create the confidential account on-chain
            console.log('[Confidential] Creating on-chain account for native SOL...');
            try {
              await service.createAccount(NATIVE_SOL_MINT);
              console.log('[Confidential] Account created successfully');
            } catch (createErr: any) {
              // Account might already exist from a previous session with lost local state
              if (
                createErr.message?.includes('already in use') ||
                createErr.message?.includes('already been processed')
              ) {
                console.log('[Confidential] Account already exists on-chain');
              } else {
                throw createErr;
              }
            }
          }

          // Fetch local balance
          const localBalance = await service.getLocalBalance(NATIVE_SOL_MINT);
          const balanceLamports = Number(localBalance);

          // Fetch pending credits count
          let pendingCount = 0;
          try {
            pendingCount = await service.getPendingCreditsCount(NATIVE_SOL_MINT);
          } catch {
            // Non-critical; account may not exist yet
          }

          set({
            isInitialized: true,
            isLoading: false,
            accounts: { [NATIVE_SOL_MINT_STR]: true },
            balances: { [NATIVE_SOL_MINT_STR]: balanceLamports },
            pendingCredits: { [NATIVE_SOL_MINT_STR]: pendingCount },
          });
        } catch (error) {
          console.error('[Confidential] Initialize error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      /**
       * Ensure the service is initialized (handles app restart).
       */
      ensureInitialized: async () => {
        const { _service } = get();
        if (_service) return true;

        try {
          await get().initialize();
          return get()._service !== null;
        } catch (error) {
          console.error('[Confidential] Failed to initialize:', error);
          return false;
        }
      },

      /**
       * Refresh the confidential balance for a given token mint.
       * Defaults to native SOL.
       */
      refreshBalance: async (tokenMint?: string) => {
        await get().ensureInitialized();

        const { _service } = get();
        if (!_service) return;

        const mint = tokenMint || NATIVE_SOL_MINT_STR;
        const mintPubkey = new PublicKey(mint);

        set({ isLoading: true, error: null });

        try {
          const localBalance = await _service.getLocalBalance(mintPubkey);
          const balanceLamports = Number(localBalance);

          let pendingCount = 0;
          try {
            pendingCount = await _service.getPendingCreditsCount(mintPubkey);
          } catch {
            // Non-critical
          }

          set((state) => ({
            isLoading: false,
            balances: { ...state.balances, [mint]: balanceLamports },
            pendingCredits: { ...state.pendingCredits, [mint]: pendingCount },
          }));
        } catch (error) {
          console.error('[Confidential] Refresh balance error:', error);
          set({ isLoading: false, error: (error as Error).message });
        }
      },

      /**
       * Deposit tokens into the confidential account.
       */
      deposit: async (tokenMint: string, amount: number) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const amountLamports = BigInt(Math.floor(amount * 1e9));

          const { signature, newBalance } = await _service.deposit(
            mintPubkey,
            amountLamports,
          );

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] Deposit error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Withdraw tokens from the confidential account.
       */
      withdraw: async (tokenMint: string, amount: number) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        const currentBalance = get().balances[tokenMint] || 0;
        const amountLamports = Math.floor(amount * 1e9);
        if (amountLamports > currentBalance) {
          throw new Error('Insufficient confidential balance');
        }

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const amountBigint = BigInt(amountLamports);

          const { signature, newBalance } = await _service.withdraw(
            mintPubkey,
            amountBigint,
          );

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] Withdraw error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Send a confidential transfer to another user.
       */
      confidentialTransfer: async (
        tokenMint: string,
        recipient: string,
        amount: number,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        const currentBalance = get().balances[tokenMint] || 0;
        const amountLamports = Math.floor(amount * 1e9);
        if (amountLamports > currentBalance) {
          throw new Error('Insufficient confidential balance');
        }

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const recipientPubkey = new PublicKey(recipient);
          const amountBigint = BigInt(amountLamports);

          const { signature } = await _service.transfer(
            mintPubkey,
            recipientPubkey,
            amountBigint,
          );

          // Refresh balance after transfer
          const newBalance = await _service.getLocalBalance(mintPubkey);

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] Transfer error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Apply a pending credit to the confidential balance.
       */
      applyPending: async (
        tokenMint: string,
        amount: number,
        amountSalt: string,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const amountLamports = BigInt(Math.floor(amount * 1e9));
          const salt = BigInt(amountSalt);

          const { signature, newBalance } = await _service.applyPending(
            mintPubkey,
            amountLamports,
            salt,
          );

          // Refresh pending credits count
          let pendingCount = 0;
          try {
            pendingCount = await _service.getPendingCreditsCount(mintPubkey);
          } catch {
            // Non-critical
          }

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
            pendingCredits: {
              ...state.pendingCredits,
              [tokenMint]: pendingCount,
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] Apply pending error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Reset all state (e.g., on wallet logout).
       */
      reset: () => {
        resetZkSplService();
        set({
          isInitialized: false,
          isLoading: false,
          balances: {},
          accounts: {},
          pendingCredits: {},
          error: null,
          _service: null,
        });
      },
    }),
    {
      name: 'p01-confidential-mobile',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        balances: state.balances,
        accounts: state.accounts,
        pendingCredits: state.pendingCredits,
      }),
    },
  ),
);
