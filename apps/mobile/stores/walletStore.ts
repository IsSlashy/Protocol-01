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
  sendSolWithSigner,
  TransactionResult,
} from '../services/solana/transactions';
import { PublicKey, Transaction } from '@solana/web3.js';
import { getSolanaWebSocket } from '../services/solana/websocket';
import { resetAllPrivacyStores, restorePrivacyStoresForWallet } from './resetStores';
import { scheduleLocalNotification } from '../services/notifications';

// Store Privy signer for transactions
let privySigner: ((tx: Transaction) => Promise<Transaction>) | null = null;

// Track WS listener cleanup so we can remove it on logout/re-init
let _wsAccountChangeCleanup: (() => void) | null = null;

// Track the autonomous runner start timer so we can cancel it on logout
let _autonomousRunnerTimer: ReturnType<typeof setTimeout> | null = null;
export function setPrivySigner(signer: ((tx: Transaction) => Promise<Transaction>) | null) {
  privySigner = signer;
}
export function getPrivySigner(): ((tx: Transaction) => Promise<Transaction>) | null {
  return privySigner;
}
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
  isPrivyWallet: boolean; // Track if using Privy embedded wallet

  // Computed
  formattedPublicKey: string;
  formattedSolBalance: string;
  formattedUsdBalance: string;

  // Actions
  initialize: () => Promise<void>;
  initializeWithPrivy: (address: string) => Promise<void>; // Initialize with Privy wallet
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
  isPrivyWallet: false,

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

      // Initialize connection — non-fatal, wallet can still load without network
      try {
        await initializeConnection();
      } catch (connErr: any) {
        // Connection init failed — non-fatal, wallet can still load
      }

      const exists = await walletExists();
      if (!exists) {
        // No local wallet on disk. Any notes currently hydrated from zustand-persist
        // can only belong to a prior abandoned session (e.g. Privy closed without logout).
        // Wipe them so a freshly-created wallet never inherits stale notes.
        try {
          await resetAllPrivacyStores(undefined);
        } catch {}
      }
      if (exists) {
        const publicKey = await getPublicKey();

        // INSTANT: Load cached data immediately (like Phantom)
        let cachedBalance = null;
        let cachedTransactions: any[] = [];
        try {
          [cachedBalance, cachedTransactions] = await Promise.all([
            getCachedBalance(publicKey),
            getCachedTransactions(publicKey),
          ]);
        } catch {}

        set({
          hasWallet: true,
          publicKey,
          balance: cachedBalance || { sol: 0, tokens: [], totalUsd: 0 },
          transactions: cachedTransactions || [],
        });

        // BACKGROUND: Refresh balance (update cache)
        setTimeout(async () => {
          try {
            const balance = await getWalletBalance(publicKey);
            set({ balance });
          } catch (err: any) {
            // Failed to fetch fresh balance — will retry on next refresh
          }
        }, 500);

        // BACKGROUND: Fetch fresh transactions (will update cache)
        setTimeout(async () => {
          try {
            const transactions = await getTransactionHistory(publicKey);
            set({ transactions });
          } catch (err: any) {
            // Failed to fetch fresh transactions — will retry on next refresh
          }
        }, 3000);

        // REAL-TIME: Subscribe to account changes via WebSocket
        // Auto-refresh balance when SOL is received/sent (any page, no pull needed)
        try {
          // Clean up previous listener before re-subscribing (prevents accumulation)
          if (_wsAccountChangeCleanup) {
            _wsAccountChangeCleanup();
            _wsAccountChangeCleanup = null;
          }

          const ws = getSolanaWebSocket();
          await ws.connect();
          await ws.subscribe(publicKey);
          let lastRefresh = 0;
          const handler = async () => {
            // Debounce: skip if refreshed within last 2s
            const now = Date.now();
            if (now - lastRefresh < 2000) return;
            lastRefresh = now;

            // Capture previous SOL balance before refresh
            const prevSol = get().balance?.sol ?? 0;

            await get().refreshBalance();

            // Compare new balance to previous — notify on increase
            const newSol = get().balance?.sol ?? 0;
            const received = newSol - prevSol;
            if (received > 0) {
              const formattedAmount = formatBalance(received);
              scheduleLocalNotification(
                'SOL Received',
                `You received ${formattedAmount} SOL`,
                {
                  category: 'transaction',
                  amount: formattedAmount,
                  token: 'SOL',
                  action: 'received',
                  channelId: 'transactions',
                  newTotal: formatBalance(newSol),
                },
              ).catch(() => {});
            }
          };
          ws.on('account_change', handler);
          // Store cleanup function so logout/re-init can remove this listener
          _wsAccountChangeCleanup = () => ws.off('account_change', handler);
        } catch (err: any) {
          console.warn('[Wallet] WebSocket subscription failed:', err.message);
        }
      }

      set({ initialized: true, loading: false });

      // Restore any previously archived notes for this wallet
      const currentPk = get().publicKey;
      if (currentPk) {
        restorePrivacyStoresForWallet(currentPk).catch(() => {});
      }
    } catch (error: any) {
      // Even if init fails, check for wallet existence so we don't lose it
      try {
        const exists = await walletExists();
        if (exists) {
          const publicKey = await getPublicKey();
          set({ hasWallet: true, publicKey });
        }
      } catch {}
      set({
        error: error.message || 'Failed to initialize wallet',
        loading: false,
        initialized: true,
      });
    }
  },

  // Initialize with Privy embedded wallet
  initializeWithPrivy: async (address: string) => {
    try {
      set({ loading: true, error: null });

      // Initialize connection
      await initializeConnection();

      // If the incoming Privy address differs from the currently-loaded wallet,
      // archive outgoing notes + reset privacy stores before restoring for the new one.
      // Prevents stale notes from a previous session/identity leaking across wallets.
      const oldPublicKey = get().publicKey;
      if (oldPublicKey !== address) {
        await resetAllPrivacyStores(oldPublicKey ?? undefined);
      }

      // Load cached data for this address
      const [cachedBalance, cachedTransactions] = await Promise.all([
        getCachedBalance(address),
        getCachedTransactions(address),
      ]);

      set({
        hasWallet: true,
        publicKey: address,
        isPrivyWallet: true,
        balance: cachedBalance || { sol: 0, tokens: [], totalUsd: 0 },
        transactions: cachedTransactions,
        initialized: true,
        loading: false,
      });

      // Restore any previously archived notes for this Privy wallet
      await restorePrivacyStoresForWallet(address);

      // Background refresh balance
      setTimeout(async () => {
        try {
          const balance = await getWalletBalance(address);
          set({ balance });
        } catch (err: any) {
          // Failed to fetch Privy wallet balance — will retry on next refresh
        }
      }, 500);

      // Background refresh transactions
      setTimeout(async () => {
        try {
          const transactions = await getTransactionHistory(address);
          set({ transactions });
        } catch (err: any) {
          // Failed to fetch Privy wallet transactions — will retry on next refresh
        }
      }, 2000);

      // Start autonomous privacy router (non-blocking, cancellable on logout)
      if (_autonomousRunnerTimer) clearTimeout(_autonomousRunnerTimer);
      _autonomousRunnerTimer = setTimeout(async () => {
        _autonomousRunnerTimer = null;
        // Guard: don't start if wallet was logged out before timer fired
        if (!get().hasWallet || !get().publicKey) return;
        try {
          const { startAutonomousRunner } = await import('../services/privacyRouter/autonomousRunner');
          await startAutonomousRunner();
        } catch (err: any) {
          console.warn('[WalletStore] Privacy router auto-start failed:', err.message);
        }
      }, 5000);

    } catch (error: any) {
      console.error('[WalletStore] Failed to initialize Privy wallet:', error);
      set({
        error: error.message || 'Failed to initialize Privy wallet',
        loading: false,
        initialized: true,
      });
    }
  },

  // Create new wallet
  createNewWallet: async () => {
    try {
      set({ loading: true, error: null });

      // Archive notes for outgoing wallet (if any), then reset privacy stores.
      // Prevents stale notes from a prior Privy/local session leaking into the new identity.
      const oldPublicKey = get().publicKey;
      await resetAllPrivacyStores(oldPublicKey ?? undefined);

      const wallet = await createWallet();
      set({
        hasWallet: true,
        publicKey: wallet.publicKey,
        isPrivyWallet: false,
        balance: { sol: 0, tokens: [], totalUsd: 0 },
        transactions: [],
        loading: false,
        error: null,
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
        await Promise.all([
          clearBalanceCache(oldPublicKey),
          clearTransactionCache(oldPublicKey),
        ]);
      }

      // Archive notes for outgoing wallet, then reset stores
      await resetAllPrivacyStores(oldPublicKey ?? undefined);

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

      // Restore any previously archived notes for this wallet
      await restorePrivacyStoresForWallet(wallet.publicKey);

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

      // 1. Cancel pending autonomous runner start timer (race condition guard)
      if (_autonomousRunnerTimer) {
        clearTimeout(_autonomousRunnerTimer);
        _autonomousRunnerTimer = null;
      }

      // 2. Stop the autonomous privacy router (clears intervals + AppState listener)
      try {
        const { stopAutonomousRunner } = await import('../services/privacyRouter/autonomousRunner');
        await stopAutonomousRunner();
      } catch {}

      // 3. Remove WS account_change listener before disconnecting
      if (_wsAccountChangeCleanup) {
        _wsAccountChangeCleanup();
        _wsAccountChangeCleanup = null;
      }

      // 4. Disconnect WebSocket before deleting wallet
      try {
        const ws = getSolanaWebSocket();
        await ws.disconnect();
      } catch {}

      const outgoingAddress = get().publicKey;
      await deleteWallet();
      // Archive notes for outgoing wallet, then reset stores
      await resetAllPrivacyStores(outgoingAddress ?? undefined);
      set({
        hasWallet: false,
        publicKey: null,
        balance: null,
        transactions: [],
        loading: false,
        isPrivyWallet: false,
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
      set({ refreshing: true });
      const transactions = await getTransactionHistory(publicKey);
      set({ transactions, refreshing: false });
    } catch (error: any) {
      console.error('Failed to refresh transactions:', error);
      set({ refreshing: false });
    }
  },

  // Send transaction
  sendTransaction: async (to: string, amount: number) => {
    set({ loading: true, error: null });

    const shortRecipient = to.length > 8
      ? `${to.slice(0, 4)}...${to.slice(-4)}`
      : to;
    const formattedAmount = formatBalance(amount);

    try {
      let result: TransactionResult;

      // Use Privy signer if available (for Privy wallets)
      if (get().isPrivyWallet && privySigner && get().publicKey) {
        const fromPubkey = new PublicKey(get().publicKey!);
        result = await sendSolWithSigner(to, amount, fromPubkey, privySigner);
      } else {
        // Fallback to local keypair
        result = await sendSol(to, amount);
      }

      if (result.success) {
        // Refresh balance after successful transaction
        setTimeout(() => {
          get().refreshBalance();
          get().refreshTransactions();
        }, 2000);

        // Notify user of successful transfer
        scheduleLocalNotification(
          'Transfer Sent',
          `${formattedAmount} SOL sent to ${shortRecipient}`,
          {
            category: 'transaction',
            amount: formattedAmount,
            token: 'SOL',
            action: 'sent',
            transactionId: result.signature ?? undefined,
          },
          { channelId: 'transactions' },
        ).catch(() => {});
      }

      set({ loading: false });
      return result;
    } catch (error: any) {
      const errorMsg = error.message || 'Transaction failed';

      // Notify user of failed transfer
      scheduleLocalNotification(
        'Transfer Failed',
        `Failed to send ${formattedAmount} SOL: ${errorMsg}`,
        {
          category: 'transaction',
          amount: formattedAmount,
          token: 'SOL',
          action: 'send_failed',
        },
        { channelId: 'transactions' },
      ).catch(() => {});

      set({
        error: errorMsg,
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
