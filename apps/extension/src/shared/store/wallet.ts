import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import { encrypt, decrypt, hashPassword, verifyPassword, EncryptedData } from '../services/crypto';
import {
  generateMnemonic,
  validateMnemonic,
  deriveKeypairFromMnemonic,
  getSolBalance,
  getTokenBalances,
  sendSol,
  requestAirdrop,
  isValidSolanaAddress,
  NetworkType,
  TokenBalance,
} from '../services/wallet';

// Re-export TokenBalance for use in components
export type { TokenBalance };
import { getRecentTransactions } from '../services/transactions';
import {
  Keypair,
  Transaction,
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from '@solana/web3.js';
import type { TransactionRecord } from '../types';

// Session timeout in milliseconds (10 minutes)
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// Session storage keys
const SESSION_KEYS = {
  SECRET_KEY: 'p01_session_secret',
  TIMESTAMP: 'p01_session_timestamp',
};

/**
 * Save session to chrome.storage.local with timestamp for expiry
 */
async function saveSession(secretKey: Uint8Array): Promise<void> {
  try {
    await chrome.storage.local.set({
      [SESSION_KEYS.SECRET_KEY]: Array.from(secretKey),
      [SESSION_KEYS.TIMESTAMP]: Date.now(),
    });
  } catch (e) {
    console.warn('[Session] Failed to save session:', e);
  }
}

/**
 * Clear session from storage
 */
async function clearSession(): Promise<void> {
  try {
    await chrome.storage.local.remove([SESSION_KEYS.SECRET_KEY, SESSION_KEYS.TIMESTAMP]);
  } catch (e) {
    console.warn('[Session] Failed to clear session:', e);
  }
}

/**
 * Try to restore session if still valid
 * Returns keypair if session is valid, null otherwise
 */
async function tryRestoreSession(): Promise<Keypair | null> {
  try {
    const result = await chrome.storage.local.get([SESSION_KEYS.SECRET_KEY, SESSION_KEYS.TIMESTAMP]);

    const secretKeyArray = result[SESSION_KEYS.SECRET_KEY];
    const timestamp = result[SESSION_KEYS.TIMESTAMP];

    if (!secretKeyArray || !timestamp) {
      return null;
    }

    // Check if session has expired
    const elapsed = Date.now() - timestamp;
    if (elapsed > SESSION_TIMEOUT_MS) {
      await clearSession();
      return null;
    }

    // Restore keypair from secret key
    const secretKey = new Uint8Array(secretKeyArray);
    const keypair = Keypair.fromSecretKey(secretKey);

    // Refresh session timestamp on successful restore
    await chrome.storage.local.set({ [SESSION_KEYS.TIMESTAMP]: Date.now() });

    return keypair;
  } catch (e) {
    console.warn('[Session] Failed to restore session:', e);
    return null;
  }
}

// --- Privy wallet support ---
type PrivySignTransaction = (transaction: Transaction) => Promise<Transaction>;
let privySigner: PrivySignTransaction | null = null;

export function setPrivySigner(signer: PrivySignTransaction | null): void {
  privySigner = signer;
}

export function getPrivySigner(): PrivySignTransaction | null {
  return privySigner;
}

export interface Token {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: number;
  usdValue: number;
  icon?: string;
}

export interface WalletState {
  // Auth state
  isInitialized: boolean;
  isUnlocked: boolean;
  isLoading: boolean;
  error: string | null;

  // Wallet data (persisted encrypted)
  publicKey: string | null;
  encryptedSeedPhrase: EncryptedData | null;
  passwordHash: string | null;

  // Balances (not persisted - fetched from chain)
  solBalance: number;
  tokens: TokenBalance[];
  isRefreshing: boolean;

  // Transactions (not persisted - fetched from chain)
  transactions: TransactionRecord[];
  isLoadingTransactions: boolean;

  // Settings
  network: NetworkType;
  hideBalance: boolean;

  // Privy wallet flag
  isPrivyWallet: boolean;

  // In-memory only (never persisted)
  _keypair: Keypair | null;

  // Actions
  createWallet: (password: string) => Promise<string[]>;
  importWallet: (seedPhrase: string[], password: string) => Promise<void>;
  initializeWithPrivy: (address: string) => void;
  logout: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  tryAutoUnlock: () => Promise<boolean>;
  lock: () => void;
  reset: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  sendTransaction: (toAddress: string, amountSol: number) => Promise<string>;
  requestFaucet: (amountSol?: number) => Promise<string>;
  setNetwork: (network: NetworkType) => void;
  toggleHideBalance: () => void;
  clearError: () => void;
  fetchTransactions: (limit?: number) => Promise<void>;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      // Initial state
      isInitialized: false,
      isUnlocked: false,
      isLoading: false,
      error: null,
      publicKey: null,
      encryptedSeedPhrase: null,
      passwordHash: null,
      solBalance: 0,
      tokens: [],
      isRefreshing: false,
      transactions: [],
      isLoadingTransactions: false,
      network: 'devnet',
      hideBalance: false,
      isPrivyWallet: false,
      _keypair: null,

      // Create a new wallet
      createWallet: async (password: string) => {
        set({ isLoading: true, error: null });
        try {
          // Generate mnemonic
          const mnemonic = generateMnemonic();
          const seedPhraseArray = mnemonic.split(' ');

          // Derive keypair
          const keypair = await deriveKeypairFromMnemonic(mnemonic);
          const publicKey = keypair.publicKey.toBase58();

          // Encrypt seed phrase
          const encryptedSeedPhrase = await encrypt(mnemonic, password);
          const passwordHash = await hashPassword(password);

          set({
            isInitialized: true,
            isUnlocked: true,
            publicKey,
            encryptedSeedPhrase,
            passwordHash,
            _keypair: keypair,
            isLoading: false,
          });

          // Fetch initial balance
          get().refreshBalance();

          return seedPhraseArray;
        } catch (error) {
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      // Import existing wallet
      importWallet: async (seedPhrase: string[], password: string) => {
        set({ isLoading: true, error: null });
        try {
          const mnemonic = seedPhrase.join(' ');

          // Validate mnemonic
          if (!validateMnemonic(mnemonic)) {
            throw new Error('Invalid seed phrase');
          }

          // Derive keypair
          const keypair = await deriveKeypairFromMnemonic(mnemonic);
          const publicKey = keypair.publicKey.toBase58();

          // Encrypt seed phrase
          const encryptedSeedPhrase = await encrypt(mnemonic, password);
          const passwordHash = await hashPassword(password);

          set({
            isInitialized: true,
            isUnlocked: true,
            publicKey,
            encryptedSeedPhrase,
            passwordHash,
            _keypair: keypair,
            isLoading: false,
          });

          // Fetch initial balance and transactions for imported wallet
          get().refreshBalance();
          get().fetchTransactions();
        } catch (error) {
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      // Initialize with Privy wallet (no seed phrase, no password)
      initializeWithPrivy: (address: string) => {
        set({
          isInitialized: true,
          isUnlocked: true,
          publicKey: address,
          isPrivyWallet: true,
          isLoading: false,
          error: null,
        });
        // Fetch balance and transactions
        get().refreshBalance();
        get().fetchTransactions();
      },

      // Logout (for Privy users — full reset)
      logout: async () => {
        clearSession();
        // Clear chrome storage directly to ensure clean state
        try {
          await chrome.storage.local.remove('p01-wallet');
          } catch (e) {
          console.error('[WalletStore] Failed to clear chrome storage:', e);
        }
        set({
          isInitialized: false,
          isUnlocked: false,
          isLoading: false,
          error: null,
          publicKey: null,
          encryptedSeedPhrase: null,
          passwordHash: null,
          solBalance: 0,
          tokens: [],
          transactions: [],
          _keypair: null,
          isPrivyWallet: false,
        });
      },

      // Unlock wallet with password
      unlock: async (password: string) => {
        const { encryptedSeedPhrase, passwordHash } = get();

        if (!encryptedSeedPhrase || !passwordHash) {
          set({ error: 'Wallet not initialized' });
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          // Verify password
          const isValid = await verifyPassword(password, passwordHash);
          if (!isValid) {
            set({ isLoading: false, error: 'Invalid password' });
            return false;
          }

          // Decrypt seed phrase
          const mnemonic = await decrypt(encryptedSeedPhrase, password);

          // Derive keypair
          const keypair = await deriveKeypairFromMnemonic(mnemonic);

          set({
            isUnlocked: true,
            _keypair: keypair,
            isLoading: false,
          });

          // Save session for auto-unlock (10 minute timeout)
          await saveSession(keypair.secretKey);

          // Fetch balance and transactions
          get().refreshBalance();
          get().fetchTransactions();

          return true;
        } catch (error) {
          console.error('[WalletStore] Unlock error:', error);
          set({ isLoading: false, error: 'Failed to unlock wallet' });
          return false;
        }
      },

      // Try to auto-unlock from saved session
      tryAutoUnlock: async () => {
        const { isUnlocked, isInitialized, publicKey } = get();

        // Already unlocked or not initialized
        if (isUnlocked || !isInitialized || !publicKey) {
          return isUnlocked;
        }

        try {
          const keypair = await tryRestoreSession();

          if (!keypair) {
            return false;
          }

          // Verify the keypair matches our stored public key
          if (keypair.publicKey.toBase58() !== publicKey) {
            await clearSession();
            return false;
          }

          set({
            isUnlocked: true,
            _keypair: keypair,
          });

          // Fetch balance and transactions
          get().refreshBalance();
          get().fetchTransactions();

          return true;
        } catch (error) {
          console.error('[WalletStore] Auto-unlock error:', error);
          return false;
        }
      },

      // Lock wallet
      lock: () => {
        // Clear session
        clearSession();

        set({
          isUnlocked: false,
          _keypair: null,
          solBalance: 0,
          tokens: [],
          transactions: [],
        });
      },

      // Reset wallet completely
      reset: async () => {
        clearSession();
        // Clear chrome storage directly to ensure clean state
        try {
          await chrome.storage.local.remove('p01-wallet');
        } catch (e) {
          console.error('[WalletStore] Failed to clear chrome storage:', e);
        }
        set({
          isInitialized: false,
          isUnlocked: false,
          isLoading: false,
          error: null,
          publicKey: null,
          encryptedSeedPhrase: null,
          passwordHash: null,
          solBalance: 0,
          tokens: [],
          transactions: [],
          _keypair: null,
          isPrivyWallet: false,
        });
      },

      // Refresh balance from blockchain
      refreshBalance: async () => {
        const { publicKey, network, isUnlocked } = get();

        if (!publicKey || !isUnlocked) {
          return;
        }

        set({ isRefreshing: true });

        try {
          const [solBalance, tokens] = await Promise.all([
            getSolBalance(publicKey, network),
            getTokenBalances(publicKey, network),
          ]);

          set({ solBalance, tokens, isRefreshing: false });
        } catch (error) {
          console.error('[WalletStore] Failed to refresh balance:', error);
          set({ isRefreshing: false });
        }
      },

      // Send SOL transaction
      sendTransaction: async (toAddress: string, amountSol: number) => {
        const { _keypair, network, isPrivyWallet, publicKey } = get();

        if (!isValidSolanaAddress(toAddress)) {
          throw new Error('Invalid recipient address');
        }

        set({ isLoading: true, error: null });

        try {
          let signature: string;

          if (isPrivyWallet) {
            // Privy wallet path — use privySigner (no raw keypair available)
            if (!privySigner || !publicKey) {
              throw new Error('Privy wallet not ready');
            }

            const rpcUrl = network === 'devnet'
              ? clusterApiUrl('devnet')
              : 'https://api.mainnet-beta.solana.com';
            const connection = new Connection(rpcUrl);

            const transaction = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: new PublicKey(publicKey),
                toPubkey: new PublicKey(toAddress),
                lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
              })
            );

            const { blockhash } = await connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = new PublicKey(publicKey);

            const signedTx = await privySigner(transaction);
            signature = await connection.sendRawTransaction(signedTx.serialize());
            await connection.confirmTransaction(signature);
          } else {
            // Legacy path — use raw keypair
            if (!_keypair) {
              throw new Error('Wallet not unlocked');
            }
            signature = await sendSol(_keypair, toAddress, amountSol, network);
          }

          // Refresh balance and transactions after transaction
          await get().refreshBalance();
          // Delay transaction fetch slightly to allow blockchain to index
          setTimeout(() => get().fetchTransactions(), 2000);

          set({ isLoading: false });
          return signature;
        } catch (error) {
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      // Request airdrop from devnet faucet
      requestFaucet: async (amountSol: number = 1) => {
        const { publicKey, network } = get();

        if (!publicKey) {
          throw new Error('Wallet not initialized');
        }

        if (network !== 'devnet') {
          throw new Error('Faucet only available on devnet');
        }

        set({ isLoading: true, error: null });

        try {
          const signature = await requestAirdrop(publicKey, amountSol);

          // Refresh balance after airdrop
          await get().refreshBalance();

          set({ isLoading: false });
          return signature;
        } catch (error) {
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      // Fetch transactions from blockchain
      fetchTransactions: async (limit: number = 10) => {
        const { publicKey, network, isUnlocked } = get();

        if (!publicKey || !isUnlocked) return;

        set({ isLoadingTransactions: true });

        try {
          const transactions = await getRecentTransactions(publicKey, network, limit);
          set({ transactions, isLoadingTransactions: false });
        } catch (error) {
          console.error('Failed to fetch transactions:', error);
          set({ isLoadingTransactions: false });
        }
      },

      // Set network
      setNetwork: (network: NetworkType) => {
        set({ network, solBalance: 0, tokens: [], transactions: [] });
        // Refresh balance and transactions for new network
        get().refreshBalance();
        get().fetchTransactions();
      },

      // Toggle hide balance
      toggleHideBalance: () => {
        set((state) => ({ hideBalance: !state.hideBalance }));
      },

      // Clear error
      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: 'p01-wallet',
      storage: createJSONStorage(() => chromeStorage),
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        publicKey: state.publicKey,
        encryptedSeedPhrase: state.encryptedSeedPhrase,
        passwordHash: state.passwordHash,
        network: state.network,
        hideBalance: state.hideBalance,
        isPrivyWallet: state.isPrivyWallet,
      }),
    }
  )
);
