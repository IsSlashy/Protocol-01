/**
 * Confidential Balance Store (zkSPL)
 *
 * Zustand store with Chrome storage persistence for zkSPL
 * confidential token balances. MVP: native SOL only.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { SystemProgram, PublicKey } from '@solana/web3.js';
import {
  getZkSplClient,
  resetZkSplClient,
  hasConfidentialAccount,
  getNativeSolMint,
} from '../services/zkspl';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfidentialState {
  /** Whether the store has been initialized (client created + balance loaded) */
  isInitialized: boolean;
  /** Loading indicator */
  isLoading: boolean;
  /** Confidential SOL balance in lamports */
  balance: number;
  /** Confidential SOL balance as a display float */
  displayBalance: number;
  /** Whether an on-chain confidential account exists for this wallet */
  hasAccount: boolean;
  /** Number of pending incoming credits */
  pendingCredits: number;
  /** Last error message */
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  deposit: (amount: number) => Promise<string>;
  withdraw: (amount: number) => Promise<string>;
  transfer: (recipient: string, amount: number) => Promise<string>;
  applyPending: () => Promise<string>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConfidentialStore = create<ConfidentialState>()(
  persist(
    (set, get) => ({
      // Initial state
      isInitialized: false,
      isLoading: false,
      balance: 0,
      displayBalance: 0,
      hasAccount: false,
      pendingCredits: 0,
      error: null,

      // -------------------------------------------------------------------
      // Initialize
      // -------------------------------------------------------------------
      initialize: async () => {
        const { isInitialized } = get();
        if (isInitialized) return;

        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const mint = getNativeSolMint();

          // Check if on-chain account exists
          const accountExists = await hasConfidentialAccount();

          if (accountExists) {
            // Load local balance
            const localBalance = await client.getLocalBalance(mint);
            const balanceLamports = localBalance !== null ? Number(localBalance) : 0;

            // Load pending credits count
            const pendingList = await client.getPendingCredits(mint);

            set({
              isInitialized: true,
              isLoading: false,
              hasAccount: true,
              balance: balanceLamports,
              displayBalance: balanceLamports / LAMPORTS_PER_SOL,
              pendingCredits: pendingList.length,
              error: null,
            });
          } else {
            set({
              isInitialized: true,
              isLoading: false,
              hasAccount: false,
              balance: 0,
              displayBalance: 0,
              pendingCredits: 0,
              error: null,
            });
          }
        } catch (error) {
          console.error('[Confidential] Initialize error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
        }
      },

      // -------------------------------------------------------------------
      // Refresh balance
      // -------------------------------------------------------------------
      refreshBalance: async () => {
        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const mint = getNativeSolMint();

          const localBalance = await client.getLocalBalance(mint);
          const balanceLamports = localBalance !== null ? Number(localBalance) : 0;

          const pendingList = await client.getPendingCredits(mint);

          set({
            balance: balanceLamports,
            displayBalance: balanceLamports / LAMPORTS_PER_SOL,
            pendingCredits: pendingList.length,
            isLoading: false,
          });
        } catch (error) {
          console.error('[Confidential] Refresh error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
        }
      },

      // -------------------------------------------------------------------
      // Deposit (shield SOL into confidential account)
      // -------------------------------------------------------------------
      deposit: async (amount: number) => {
        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const mint = getNativeSolMint();
          const amountLamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));

          // If no account yet, create one first
          if (!get().hasAccount) {
            console.log('[Confidential] Creating on-chain account...');
            await client.createAccount(mint);
            set({ hasAccount: true });
          }

          // Deposit
          const result = await client.deposit(mint, amountLamports);

          const newBalance = Number(result.newBalance);
          set({
            balance: newBalance,
            displayBalance: newBalance / LAMPORTS_PER_SOL,
            isLoading: false,
          });

          return result.signature;
        } catch (error) {
          console.error('[Confidential] Deposit error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      // -------------------------------------------------------------------
      // Withdraw (unshield from confidential account)
      // -------------------------------------------------------------------
      withdraw: async (amount: number) => {
        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const mint = getNativeSolMint();
          const amountLamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));

          const result = await client.withdraw(mint, amountLamports);

          const newBalance = Number(result.newBalance);
          set({
            balance: newBalance,
            displayBalance: newBalance / LAMPORTS_PER_SOL,
            isLoading: false,
          });

          return result.signature;
        } catch (error) {
          console.error('[Confidential] Withdraw error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      // -------------------------------------------------------------------
      // Transfer (confidential send to another wallet)
      // -------------------------------------------------------------------
      transfer: async (recipient: string, amount: number) => {
        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const mint = getNativeSolMint();
          const amountLamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
          const recipientPubkey = new PublicKey(recipient);

          const result = await client.confidentialTransfer(
            mint,
            recipientPubkey,
            amountLamports
          );

          const newBalance = Number(result.newBalance);
          set({
            balance: newBalance,
            displayBalance: newBalance / LAMPORTS_PER_SOL,
            isLoading: false,
          });

          return result.signature;
        } catch (error) {
          console.error('[Confidential] Transfer error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      // -------------------------------------------------------------------
      // Apply pending credit (receive side)
      // -------------------------------------------------------------------
      applyPending: async () => {
        set({ isLoading: true, error: null });

        try {
          // For MVP, applyPending requires out-of-band amount + salt.
          // This is a placeholder; a real implementation would look up
          // known pending credits from local state and apply the first one.
          throw new Error(
            'Apply pending requires the sender to share the amount and salt out-of-band. ' +
            'This feature is coming soon.'
          );
        } catch (error) {
          console.error('[Confidential] Apply pending error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      // -------------------------------------------------------------------
      // Reset
      // -------------------------------------------------------------------
      reset: () => {
        resetZkSplClient();
        set({
          isInitialized: false,
          isLoading: false,
          balance: 0,
          displayBalance: 0,
          hasAccount: false,
          pendingCredits: 0,
          error: null,
        });
      },
    }),
    {
      name: 'p01-confidential',
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
        isInitialized: state.isInitialized,
        hasAccount: state.hasAccount,
        balance: state.balance,
        displayBalance: state.displayBalance,
        pendingCredits: state.pendingCredits,
      }),
    }
  )
);
