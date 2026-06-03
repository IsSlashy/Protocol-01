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
import { getSolanaWebSocket } from '../services/solana/websocket';
import { resetAllPrivacyStores, restorePrivacyStoresForWallet } from './resetStores';
import { scheduleLocalNotification } from '../services/notifications';
import { requestAirdrop, isDevnet, initializeConnection } from '../services/solana/connection';

// Track WS listener cleanup so we can remove it on logout/re-init
let _wsAccountChangeCleanup: (() => void) | null = null;

// Track the autonomous runner start timer so we can cancel it on logout
let _autonomousRunnerTimer: ReturnType<typeof setTimeout> | null = null;

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

      // Initialize connection — non-fatal, wallet can still load without network
      try {
        await initializeConnection();
      } catch (connErr: any) {
        // Connection init failed — non-fatal, wallet can still load
      }

      const exists = await walletExists();
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

  // Create new wallet
  createNewWallet: async () => {
    try {
      set({ loading: true, error: null });

      // Archive notes for outgoing wallet (if any), then reset privacy stores.
      // Prevents stale notes from a prior Privy/local session leaking into the new identity.
      const oldPublicKey = get().publicKey;
      await resetAllPrivacyStores(oldPublicKey ?? undefined);

      const wallet = await createWallet();

      // Pre-stamp the recovery-scan flag for this brand-new pubkey BEFORE
      // we publish the wallet to the global store. There is nothing to
      // recover — the user just minted this keypair. (Seed-import + cross-
      // device flows intentionally leave the flag unset.)
      //
      // Order matters: the RecoveryBootModal mounted in app/(main)/_layout
      // triggers `runScan` from a useEffect on `publicKey` change. If we
      // set state first and write the flag second, the modal's
      // `AsyncStorage.getItem(flagKey)` can race the `setItem` and read
      // empty — re-firing the rescan even though there's nothing to find.
      // Writing the flag first closes the race.
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await AsyncStorage.setItem(`p01_auto_recovery_v1_${wallet.publicKey}`, Date.now().toString());
      } catch {
        // Non-fatal — worst case the modal fires once, finds nothing, and self-silences.
      }

      set({
        hasWallet: true,
        publicKey: wallet.publicKey,
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
      // Local keypair is the only signing path (Privy removed, spec §3 Phase 1).
      const result: TransactionResult = await sendSol(to, amount);

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
