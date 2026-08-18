import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import { encrypt, decrypt, hashPassword, verifyPassword, EncryptedData, getLockoutRemaining, recordFailedAttempt, resetUnlockAttempts } from '../services/crypto';
import {
  encryptForSession,
  decryptFromSession,
  isEncryptedBlob,
  setSessionPassword,
  getSessionPassword,
  clearSessionPassword,
} from '../services/sessionCrypto';
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
import { Keypair } from '@solana/web3.js';
import type { TransactionRecord } from '../types';

// Session timeout in milliseconds (10 minutes)
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// Session storage keys
const SESSION_KEYS = {
  SECRET_KEY: 'p01_session_secret',
  TIMESTAMP: 'p01_session_timestamp',
};

/**
 * Save session to chrome.storage.local with timestamp for expiry.
 * The secret key is encrypted with the user's password via AES-256-GCM
 * so it never sits in storage as plaintext.
 */
async function saveSession(secretKey: Uint8Array, password: string): Promise<void> {
  try {
    const plaintext = JSON.stringify(Array.from(secretKey));
    const encryptedBlob = await encryptForSession(plaintext, password);
    await chrome.storage.local.set({
      [SESSION_KEYS.SECRET_KEY]: encryptedBlob,
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
 * Try to restore session if still valid.
 * Decrypts the stored secret key using the cached session password.
 * Also handles backward compatibility with legacy plaintext sessions.
 * Returns keypair if session is valid, null otherwise.
 */
async function tryRestoreSession(): Promise<Keypair | null> {
  try {
    const result = await chrome.storage.local.get([SESSION_KEYS.SECRET_KEY, SESSION_KEYS.TIMESTAMP]);

    const storedKey = result[SESSION_KEYS.SECRET_KEY];
    const timestamp = result[SESSION_KEYS.TIMESTAMP];

    if (!storedKey || !timestamp) {
      return null;
    }

    // Check if session has expired
    const elapsed = Date.now() - timestamp;
    if (elapsed > SESSION_TIMEOUT_MS) {
      await clearSession();
      return null;
    }

    let secretKeyArray: number[];

    if (isEncryptedBlob(storedKey)) {
      // Encrypted session (new format) -- need session password
      const password = getSessionPassword();
      if (!password) {
        // No cached password means user must re-enter it; session cannot auto-restore
        return null;
      }
      const plaintext = await decryptFromSession(storedKey, password);
      secretKeyArray = JSON.parse(plaintext);
    } else if (Array.isArray(storedKey)) {
      // Legacy plaintext session -- migrate to encrypted on next save
      console.warn('[Session] Found legacy plaintext session key, will encrypt on next save');
      secretKeyArray = storedKey;

      // Attempt immediate migration if we have a cached password
      const password = getSessionPassword();
      if (password) {
        const plaintext = JSON.stringify(secretKeyArray);
        const encryptedBlob = await encryptForSession(plaintext, password);
        await chrome.storage.local.set({ [SESSION_KEYS.SECRET_KEY]: encryptedBlob });
        console.log('[Session] Migrated legacy plaintext session to encrypted');
      }
    } else {
      // Unknown format
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

  // In-memory only (never persisted)
  _keypair: Keypair | null;

  // Actions
  createWallet: (password: string) => Promise<string[]>;
  importWallet: (seedPhrase: string[], password: string) => Promise<void>;
  logout: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  tryAutoUnlock: () => Promise<boolean>;
  lock: () => void;
  reset: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  sendTransaction: (toAddress: string, amountSol: number, memo?: string) => Promise<string>;
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

          // Cache password for session encryption
          setSessionPassword(password);

          set({
            isInitialized: true,
            isUnlocked: true,
            publicKey,
            encryptedSeedPhrase,
            passwordHash,
            _keypair: keypair,
            isLoading: false,
          });

          // Save encrypted session
          await saveSession(keypair.secretKey, password);

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

          // Cache password for session encryption
          setSessionPassword(password);

          set({
            isInitialized: true,
            isUnlocked: true,
            publicKey,
            encryptedSeedPhrase,
            passwordHash,
            _keypair: keypair,
            isLoading: false,
          });

          // Save encrypted session
          await saveSession(keypair.secretKey, password);

          // Fetch initial balance and transactions for imported wallet
          get().refreshBalance();
          get().fetchTransactions();
        } catch (error) {
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      // Logout — full reset of persisted wallet state
      logout: async () => {
        clearSession();
        clearSessionPassword();
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
        });
      },

      // Unlock wallet with password
      unlock: async (password: string) => {
        const { encryptedSeedPhrase, passwordHash } = get();

        if (!encryptedSeedPhrase || !passwordHash) {
          set({ error: 'Wallet not initialized' });
          return false;
        }

        // Check brute-force lockout before attempting
        const lockoutMs = await getLockoutRemaining();
        if (lockoutMs > 0) {
          const secs = Math.ceil(lockoutMs / 1000);
          set({ isLoading: false, error: `Too many failed attempts. Try again in ${secs}s` });
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          // Verify password
          const isValid = await verifyPassword(password, passwordHash);
          if (!isValid) {
            await recordFailedAttempt();
            set({ isLoading: false, error: 'Invalid password' });
            return false;
          }

          // Password correct — reset brute-force counter
          await resetUnlockAttempts();

          // Decrypt seed phrase
          const mnemonic = await decrypt(encryptedSeedPhrase, password);

          // Derive keypair
          const keypair = await deriveKeypairFromMnemonic(mnemonic);

          // Cache password for session encryption
          setSessionPassword(password);

          set({
            isUnlocked: true,
            _keypair: keypair,
            isLoading: false,
          });

          // Save encrypted session for auto-unlock (10 minute timeout)
          await saveSession(keypair.secretKey, password);

          // 🚨 TELL THE BACKGROUND. It keeps its own lock flag in
          // chrome.storage.session and answers every dApp request from it —
          // and nothing in this repository ever sent this message, so that flag
          // was never set and the background refused every signature with
          // "Wallet is locked. Please unlock your wallet first." while this
          // popup sat there unlocked. MEASURED 2026-08-18: a shield could not
          // be signed no matter how many times the password was entered.
          //
          // Best effort: a popup that cannot reach the background is a popup
          // whose signature request has no one to answer it anyway.
          try {
            await chrome.runtime.sendMessage({ type: 'WALLET_UNLOCKED' });
          } catch (e) {
            console.warn('[WalletStore] could not tell the background we unlocked:', e);
          }

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

          // Auto-unlock reaches an unlocked wallet WITHOUT going through
          // `unlock()`, so it has to send this too. Miss it and reopening the
          // popup inside the ten-minute session leaves the background locked
          // while everything on screen says otherwise — the same failure, only
          // harder to reproduce.
          try {
            await chrome.runtime.sendMessage({ type: 'WALLET_UNLOCKED' });
          } catch (e) {
            console.warn('[WalletStore] could not tell the background we auto-unlocked:', e);
          }

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
        // Wipe cached password from memory
        clearSessionPassword();

        // The other half of the unlock message. Without it the two disagree in
        // the dangerous direction: this popup shows a locked wallet while the
        // background keeps answering dApp signature requests from a stale flag.
        void chrome.runtime
          .sendMessage({ type: 'WALLET_LOCKED' })
          .catch(() => {
            /* nothing to tell if the background is gone */
          });

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
        clearSessionPassword();
        // Clear chrome storage directly to ensure clean state
        try {
          await chrome.storage.local.remove(['p01-wallet', 'p01-wallet-v2']);
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
      sendTransaction: async (toAddress: string, amountSol: number, memo?: string) => {
        const { _keypair, network } = get();

        if (!isValidSolanaAddress(toAddress)) {
          throw new Error('Invalid recipient address');
        }

        set({ isLoading: true, error: null });

        try {
          // Local keypair is the only signing path.
          if (!_keypair) {
            throw new Error('Wallet not unlocked');
          }
          const signature = await sendSol(_keypair, toAddress, amountSol, network, memo);

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
      }),
      // Version 2 — Privy removal. Strips legacy isPrivyWallet/isRemoteWallet
      // flags and forces a clean re-onboard for any wallet that was a Privy /
      // remote (QR) wallet, because those have NO local seed phrase and can no
      // longer sign anything in the extension.
      //
      // NOTE (DATA-LOSS): A wallet that was `isPrivyWallet` without an
      // `encryptedSeedPhrase` is now unrecoverable in the extension — its
      // signing key only ever lived inside Privy (embedded) or on the phone
      // (QR remote). We reset such state to force re-onboarding via seed
      // import. Shielded / zkSPL notes that were keyed to a Privy-derived seed
      // are ORPHANED (accept-loss, see Phase 2 spec). TODO(Phase5-UI): surface
      // a one-time user-facing data-loss notice for affected wallets.
      version: 2,
      migrate: (persistedState: any, version: number) => {
        if (version === 0) {
          // Old data — nuke it
          return {
            isInitialized: false,
            isUnlocked: false,
            publicKey: null,
            encryptedSeedPhrase: null,
            passwordHash: null,
            network: 'devnet',
            hideBalance: false,
          };
        }

        // v1 -> v2: drop the legacy Privy flags. If the wallet claimed to be a
        // Privy / remote wallet but has no local seed phrase, it cannot sign
        // anymore — force a clean re-onboard (closes the keyless-"initialized"
        // bug). Local-seed wallets pass through untouched.
        if (persistedState && typeof persistedState === 'object') {
          const wasPrivy = !!persistedState.isPrivyWallet;
          const hasSeed = !!persistedState.encryptedSeedPhrase;
          // Strip the now-removed flags regardless.
          delete persistedState.isPrivyWallet;
          delete persistedState.isRemoteWallet;

          if (wasPrivy && !hasSeed) {
            return {
              ...persistedState,
              isInitialized: false,
              isUnlocked: false,
              publicKey: null,
              encryptedSeedPhrase: null,
              passwordHash: null,
            };
          }
        }
        return persistedState;
      },
    }
  )
);

/**
 * Get the active signing keypair for the current wallet, or null if the wallet
 * is locked / not unlocked. The local keypair is the ONLY signing path post
 * Privy-removal.
 */
export function getActiveKeypair(): Keypair | null {
  return useWalletStore.getState()._keypair;
}
