/**
 * Confidential Balance Store (zkSPL)
 *
 * Zustand store with Chrome storage persistence for zkSPL
 * confidential token balances. MVP: native SOL only.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { SystemProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getZkSplClient,
  resetZkSplClient,
  hasConfidentialAccount,
  getNativeSolMint,
  NATIVE_SOL_MINT_STR,
  USDC_DEVNET_MINT_STR,
  SUPPORTED_TOKENS,
  getTokenDecimals,
  getTokenSymbol,
} from '../services/zkspl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfidentialState {
  /** Whether the store has been initialized (client created + balance loaded) */
  isInitialized: boolean;
  /** Loading indicator */
  isLoading: boolean;
  /** Per-token confidential balances (mintStr -> atomic amount) */
  balances: Record<string, number>;
  /** Per-token display balances (mintStr -> float) */
  displayBalances: Record<string, number>;
  /** Confidential SOL balance in lamports (backwards compat) */
  balance: number;
  /** Confidential SOL balance as a display float (backwards compat) */
  displayBalance: number;
  /** Per-token account existence (mintStr -> exists) */
  accounts: Record<string, boolean>;
  /** Whether an on-chain confidential account exists for SOL (backwards compat) */
  hasAccount: boolean;
  /** Per-token pending credits count */
  pendingCreditsByToken: Record<string, number>;
  /** Pending SOL credits (backwards compat) */
  pendingCredits: number;
  /** Last error message */
  error: string | null;
  /** Currently selected token */
  selectedToken: string;

  // Actions
  initialize: () => Promise<void>;
  setSelectedToken: (mintStr: string) => void;
  refreshBalance: () => Promise<void>;
  refreshAllBalances: () => Promise<void>;
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
      balances: {},
      displayBalances: {},
      balance: 0,
      displayBalance: 0,
      accounts: {},
      hasAccount: false,
      pendingCreditsByToken: {},
      pendingCredits: 0,
      error: null,
      selectedToken: NATIVE_SOL_MINT_STR,

      // -------------------------------------------------------------------
      // Initialize
      // -------------------------------------------------------------------
      initialize: async () => {
        const { isInitialized } = get();
        if (isInitialized) return;

        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const newBalances: Record<string, number> = {};
          const newDisplayBalances: Record<string, number> = {};
          const newAccounts: Record<string, boolean> = {};
          const newPending: Record<string, number> = {};

          for (const token of SUPPORTED_TOKENS) {
            const accountInfo = await client.getConfidentialAccount(token.mint);
            const exists = accountInfo !== null && accountInfo.isInitialized;
            newAccounts[token.mintStr] = exists;

            if (exists) {
              const localBalance = await client.getLocalBalance(token.mint);
              const bal = localBalance !== null ? Number(localBalance) : 0;
              newBalances[token.mintStr] = bal;
              newDisplayBalances[token.mintStr] = bal / Math.pow(10, token.decimals);
              const pendingList = await client.getPendingCredits(token.mint);
              newPending[token.mintStr] = pendingList.length;
            } else {
              newBalances[token.mintStr] = 0;
              newDisplayBalances[token.mintStr] = 0;
              newPending[token.mintStr] = 0;
            }
          }

          const solBal = newBalances[NATIVE_SOL_MINT_STR] || 0;

          set({
            isInitialized: true,
            isLoading: false,
            balances: newBalances,
            displayBalances: newDisplayBalances,
            balance: solBal,
            displayBalance: solBal / LAMPORTS_PER_SOL,
            accounts: newAccounts,
            hasAccount: newAccounts[NATIVE_SOL_MINT_STR] || false,
            pendingCreditsByToken: newPending,
            pendingCredits: newPending[NATIVE_SOL_MINT_STR] || 0,
            error: null,
          });
        } catch (error) {
          console.error('[Confidential] Initialize error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
        }
      },

      // -------------------------------------------------------------------
      // Token selection
      // -------------------------------------------------------------------
      setSelectedToken: (mintStr: string) => {
        set({ selectedToken: mintStr });
      },

      // -------------------------------------------------------------------
      // Refresh balance (selected token)
      // -------------------------------------------------------------------
      refreshBalance: async () => {
        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const { selectedToken } = get();
          const mint = new PublicKey(selectedToken);
          const decimals = getTokenDecimals(selectedToken);

          const localBalance = await client.getLocalBalance(mint);
          const bal = localBalance !== null ? Number(localBalance) : 0;
          const pendingList = await client.getPendingCredits(mint);

          set((state) => ({
            balances: { ...state.balances, [selectedToken]: bal },
            displayBalances: { ...state.displayBalances, [selectedToken]: bal / Math.pow(10, decimals) },
            pendingCreditsByToken: { ...state.pendingCreditsByToken, [selectedToken]: pendingList.length },
            // Update backwards-compat fields if SOL
            ...(selectedToken === NATIVE_SOL_MINT_STR ? {
              balance: bal,
              displayBalance: bal / LAMPORTS_PER_SOL,
              pendingCredits: pendingList.length,
            } : {}),
            isLoading: false,
          }));
        } catch (error) {
          console.error('[Confidential] Refresh error:', error);
          set({ isLoading: false, error: (error as Error).message });
        }
      },

      // -------------------------------------------------------------------
      // Refresh all token balances
      // -------------------------------------------------------------------
      refreshAllBalances: async () => {
        set({ isLoading: true, error: null });
        try {
          const client = await getZkSplClient();
          const newBalances: Record<string, number> = {};
          const newDisplayBalances: Record<string, number> = {};
          const newPending: Record<string, number> = {};

          for (const token of SUPPORTED_TOKENS) {
            const localBalance = await client.getLocalBalance(token.mint);
            const bal = localBalance !== null ? Number(localBalance) : 0;
            newBalances[token.mintStr] = bal;
            newDisplayBalances[token.mintStr] = bal / Math.pow(10, token.decimals);
            try {
              const pendingList = await client.getPendingCredits(token.mint);
              newPending[token.mintStr] = pendingList.length;
            } catch {
              newPending[token.mintStr] = 0;
            }
          }

          const solBal = newBalances[NATIVE_SOL_MINT_STR] || 0;
          set({
            balances: newBalances,
            displayBalances: newDisplayBalances,
            balance: solBal,
            displayBalance: solBal / LAMPORTS_PER_SOL,
            pendingCreditsByToken: newPending,
            pendingCredits: newPending[NATIVE_SOL_MINT_STR] || 0,
            isLoading: false,
          });
        } catch (error) {
          console.error('[Confidential] Refresh all error:', error);
          set({ isLoading: false, error: (error as Error).message });
        }
      },

      // -------------------------------------------------------------------
      // Deposit (shield tokens into confidential account)
      // -------------------------------------------------------------------
      deposit: async (amount: number) => {
        set({ isLoading: true, error: null });

        try {
          const client = await getZkSplClient();
          const { selectedToken } = get();
          const mint = new PublicKey(selectedToken);
          const decimals = getTokenDecimals(selectedToken);
          const amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));

          // If no account yet, create one first
          if (!get().accounts[selectedToken]) {
            console.log(`[Confidential] Creating on-chain account for ${getTokenSymbol(selectedToken)}...`);
            await client.createAccount(mint);
            set((state) => ({
              accounts: { ...state.accounts, [selectedToken]: true },
              hasAccount: selectedToken === NATIVE_SOL_MINT_STR ? true : state.hasAccount,
            }));
          }

          // For SPL tokens, derive and pass token accounts
          const isNativeSol = selectedToken === NATIVE_SOL_MINT_STR;
          const userTokenAccount = isNativeSol ? undefined : client.deriveUserTokenAccount(client.wallet.publicKey, mint);
          const poolVaultTokenAccount = isNativeSol ? undefined : client.derivePoolVaultTokenAccount(mint);

          const result = await client.deposit(mint, amountAtomic, userTokenAccount, poolVaultTokenAccount);

          const newBal = Number(result.newBalance);
          set((state) => ({
            balances: { ...state.balances, [selectedToken]: newBal },
            displayBalances: { ...state.displayBalances, [selectedToken]: newBal / Math.pow(10, decimals) },
            ...(selectedToken === NATIVE_SOL_MINT_STR ? { balance: newBal, displayBalance: newBal / LAMPORTS_PER_SOL } : {}),
            isLoading: false,
          }));

          return result.signature;
        } catch (error) {
          console.error('[Confidential] Deposit error:', error);
          set({ isLoading: false, error: (error as Error).message });
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
          const { selectedToken } = get();
          const mint = new PublicKey(selectedToken);
          const decimals = getTokenDecimals(selectedToken);
          const amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));

          // For SPL tokens, ensure user ATA exists and pass token accounts
          const isNativeSol = selectedToken === NATIVE_SOL_MINT_STR;
          let userTokenAccount: PublicKey | undefined;
          let poolVaultTokenAccount: PublicKey | undefined;
          if (!isNativeSol) {
            userTokenAccount = await client.ensureTokenAccountExists(client.wallet.publicKey, mint);
            poolVaultTokenAccount = client.derivePoolVaultTokenAccount(mint);
          }

          const result = await client.withdraw(mint, amountAtomic, userTokenAccount, poolVaultTokenAccount);

          const newBal = Number(result.newBalance);
          set((state) => ({
            balances: { ...state.balances, [selectedToken]: newBal },
            displayBalances: { ...state.displayBalances, [selectedToken]: newBal / Math.pow(10, decimals) },
            ...(selectedToken === NATIVE_SOL_MINT_STR ? { balance: newBal, displayBalance: newBal / LAMPORTS_PER_SOL } : {}),
            isLoading: false,
          }));

          return result.signature;
        } catch (error) {
          console.error('[Confidential] Withdraw error:', error);
          set({ isLoading: false, error: (error as Error).message });
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
          const { selectedToken } = get();
          const mint = new PublicKey(selectedToken);
          const decimals = getTokenDecimals(selectedToken);
          const amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));
          const recipientPubkey = new PublicKey(recipient);

          const result = await client.confidentialTransfer(mint, recipientPubkey, amountAtomic);

          const newBal = Number(result.newBalance);
          set((state) => ({
            balances: { ...state.balances, [selectedToken]: newBal },
            displayBalances: { ...state.displayBalances, [selectedToken]: newBal / Math.pow(10, decimals) },
            ...(selectedToken === NATIVE_SOL_MINT_STR ? { balance: newBal, displayBalance: newBal / LAMPORTS_PER_SOL } : {}),
            isLoading: false,
          }));

          return result.signature;
        } catch (error) {
          console.error('[Confidential] Transfer error:', error);
          set({ isLoading: false, error: (error as Error).message });
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
          balances: {},
          displayBalances: {},
          balance: 0,
          displayBalance: 0,
          accounts: {},
          hasAccount: false,
          pendingCreditsByToken: {},
          pendingCredits: 0,
          error: null,
          selectedToken: NATIVE_SOL_MINT_STR,
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
        balances: state.balances,
        displayBalances: state.displayBalances,
        accounts: state.accounts,
        pendingCredits: state.pendingCredits,
        pendingCreditsByToken: state.pendingCreditsByToken,
        selectedToken: state.selectedToken,
      }),
    }
  )
);
