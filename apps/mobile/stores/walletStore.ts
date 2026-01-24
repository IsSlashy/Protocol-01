import { create } from 'zustand';
import {
  walletExists,
  getPublicKey,
  createWallet,
  importWallet,
  deleteWallet,
  getMnemonic,
  formatPublicKey,
} from '../services/solana/wallet';
import {
  getWalletBalance,
  getCachedBalance,
  clearBalanceCache,
  WalletBalance,
  formatBalance,
  formatUsd,
} from '../services/solana/balance';
import {
  getTransactionHistory,
  getCachedTransactions,
  clearTransactionCache,
  TransactionHistory,
  sendSol,
  TransactionResult,
} from '../services/solana/transactions';
import { requestAirdrop, isDevnet, initializeConnection } from '../services/solana/connection';

interface WalletState {
  // State
  initialized: boolean;
  loading: boolean;
  hasWallet: boolean;
  publicKey: string | null;
  balance: WalletBalance | null;
  transactions: TransactionHistory[];
  refreshing: boolean;
  error: string | null;

  // Computed
  formattedPublicKey: string;
  formattedSolBalance: string;
  formattedUsdBalance: string;

  // Actions
  initialize: () => Promise<void>;
  createNewWallet: () => Promise<{ mnemonic: string }>;
  importExistingWallet: (mnemonic: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  refreshTransactions: () => Promise<void>;
  sendTransaction: (to: string, amount: number) => Promise<TransactionResult>;
  requestDevnetAirdrop: (amount?: number) => Promise<string>;
  getBackupMnemonic: () => Promise<string | null>;
  clearError: () => void;
}

export const useWalletStore = create<WalletState>((set, get) => ({
  // Initial state
  initialized: false,
  loading: false,
  hasWallet: false,
  publicKey: null,
  balance: null,
  transactions: [],
  refreshing: false,
  error: null,

  // Computed values (getters)
  get formattedPublicKey() {
    const pk = get().publicKey;
    return pk ? formatPublicKey(pk, 4) : '';
  },
  get formattedSolBalance() {
    const bal = get().balance;
    return bal ? formatBalance(bal.sol) : '0';
  },
  get formattedUsdBalance() {
    const bal = get().balance;
    return bal ? formatUsd(bal.totalUsd || 0) : '$0.00';
  },

  // Initialize - check if wallet exists and load state
  initialize: async () => {
    try {
      set({ loading: true, error: null });

      // Initialize connection with stored network setting
      await initializeConnection();

      const exists = await walletExists();
      if (exists) {
        const publicKey = await getPublicKey();

        // INSTANT: Load cached data immediately (like Phantom)
        const [cachedBalance, cachedTransactions] = await Promise.all([
          getCachedBalance(publicKey),
          getCachedTransactions(publicKey),
        ]);

        set({
          hasWallet: true,
          publicKey,
          // Load cached balance or default
          balance: cachedBalance || { sol: 0, tokens: [], totalUsd: 0 },
          // Load cached transactions instantly
          transactions: cachedTransactions,
        });

        console.log('[WalletStore] INSTANT: Loaded cached balance:', cachedBalance?.sol || 0, 'SOL,', cachedTransactions.length, 'transactions');

        // BACKGROUND: Refresh balance (update cache)
        setTimeout(async () => {
          console.log('[WalletStore] Background refresh: fetching fresh balance...');
          try {
            const balance = await getWalletBalance(publicKey);
            console.log('[WalletStore] Fresh balance fetched:', balance.sol, 'SOL');
            set({ balance });
          } catch (err: any) {
            console.warn('[WalletStore] Failed to fetch fresh balance:', err?.message || err);
            // Keep cached balance on error
          }
        }, 500);

        // BACKGROUND: Fetch fresh transactions (will update cache)
        setTimeout(async () => {
          console.log('[WalletStore] Background refresh: fetching fresh transactions...');
          try {
            const transactions = await getTransactionHistory(publicKey);
            console.log('[WalletStore] Fresh transactions fetched:', transactions.length);
            set({ transactions });
          } catch (err: any) {
            console.warn('[WalletStore] Failed to fetch fresh transactions:', err?.message || err);
            // Keep cached transactions on error
          }
        }, 3000); // Refresh in background after 3s
      }

      set({ initialized: true, loading: false });
    } catch (error: any) {
      set({
        error: error.message || 'Failed to initialize wallet',
        loading: false,
        initialized: true,
      });
    }
  },

  // Create new wallet
  createNewWallet: async () => {
    try {
      set({ loading: true, error: null });

      const wallet = await createWallet();
      set({
        hasWallet: true,
        publicKey: wallet.publicKey,
        loading: false,
      });

      // Refresh balance
      get().refreshBalance();

      return { mnemonic: wallet.mnemonic! };
    } catch (error: any) {
      set({
        error: error.message || 'Failed to create wallet',
        loading: false,
      });
      throw error;
    }
  },

  // Import existing wallet
  importExistingWallet: async (mnemonic: string) => {
    try {
      set({ loading: true, error: null });

      // Clear old wallet data from state
      const oldPublicKey = get().publicKey;
      if (oldPublicKey) {
        console.log('[WalletStore] Clearing old wallet caches...');
        await Promise.all([
          clearBalanceCache(oldPublicKey),
          clearTransactionCache(oldPublicKey),
        ]);
      }

      const wallet = await importWallet(mnemonic);

      // Reset state completely with new wallet
      set({
        hasWallet: true,
        publicKey: wallet.publicKey,
        balance: { sol: 0, tokens: [], totalUsd: 0 },
        transactions: [],
        loading: false,
        error: null,
      });

      console.log('[WalletStore] Wallet imported:', wallet.publicKey);

      // Refresh balance for new wallet
      get().refreshBalance();
      get().refreshTransactions();
    } catch (error: any) {
      set({
        error: error.message || 'Failed to import wallet',
        loading: false,
      });
      throw error;
    }
  },

  // Logout / delete wallet
  logout: async () => {
    try {
      set({ loading: true, error: null });
      await deleteWallet();
      set({
        hasWallet: false,
        publicKey: null,
        balance: null,
        transactions: [],
        loading: false,
      });
    } catch (error: any) {
      set({
        error: error.message || 'Failed to logout',
        loading: false,
      });
    }
  },

  // Refresh balance
  refreshBalance: async () => {
    const { publicKey } = get();
    if (!publicKey) return;

    try {
      set({ refreshing: true });
      const balance = await getWalletBalance(publicKey);
      set({ balance, refreshing: false, error: null });
    } catch (error: any) {
      console.error('Failed to refresh balance:', error);
      // Set default balance on error to avoid UI issues
      set({
        balance: { sol: 0, tokens: [], totalUsd: 0 },
        refreshing: false,
      });
    }
  },

  // Refresh transactions
  refreshTransactions: async () => {
    const { publicKey } = get();
    if (!publicKey) return;

    try {
      const transactions = await getTransactionHistory(publicKey);
      set({ transactions });
    } catch (error: any) {
      console.error('Failed to refresh transactions:', error);
    }
  },

  // Send transaction
  sendTransaction: async (to: string, amount: number) => {
    set({ loading: true, error: null });

    try {
      const result = await sendSol(to, amount);

      if (result.success) {
        // Refresh balance after successful transaction
        setTimeout(() => {
          get().refreshBalance();
          get().refreshTransactions();
        }, 2000);
      }

      set({ loading: false });
      return result;
    } catch (error: any) {
      set({
        error: error.message || 'Transaction failed',
        loading: false,
      });
      throw error;
    }
  },

  // Request devnet airdrop
  requestDevnetAirdrop: async (amount = 1) => {
    const { publicKey } = get();
    if (!publicKey) throw new Error('No wallet');
    if (!isDevnet()) throw new Error('Airdrop only on devnet');

    set({ loading: true, error: null });

    try {
      const signature = await requestAirdrop(publicKey, amount);

      // Refresh balance after airdrop
      setTimeout(() => {
        get().refreshBalance();
        get().refreshTransactions();
      }, 2000);

      set({ loading: false });
      return signature;
    } catch (error: any) {
      set({
        error: error.message || 'Airdrop failed',
        loading: false,
      });
      throw error;
    }
  },

  // Get backup mnemonic
  getBackupMnemonic: async () => {
    return getMnemonic();
  },

  // Clear error
  clearError: () => {
    set({ error: null });
  },
}));
