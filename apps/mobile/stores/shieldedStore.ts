import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PublicKey, Transaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { getZkService, ZkService, ZkAddress, Note } from '../services/zk';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

const MNEMONIC_KEY = 'p01_mnemonic';
const ZK_SEED_KEY = 'p01_zk_seed'; // Separate seed for ZK features (Privy users)

// Must match wallet.ts SecureStore options for reading mnemonic
const SECURE_OPTIONS = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Shielded note data (serializable version)
 */
interface ShieldedNote {
  amount: string; // bigint as string for storage
  commitment: string;
  leafIndex?: number;
  createdAt: number;
}

/**
 * Pending transaction
 */
interface PendingTransaction {
  id: string;
  type: 'shield' | 'unshield' | 'transfer';
  amount: number;
  status: 'pending' | 'generating_proof' | 'submitting' | 'confirmed' | 'failed';
  error?: string;
  createdAt: number;
  signature?: string;
}

/**
 * Shielded wallet state
 */
interface ShieldedState {
  // State
  isInitialized: boolean;
  isLoading: boolean;
  shieldedBalance: number;
  notes: ShieldedNote[];
  zkAddress: string | null;
  pendingTransactions: PendingTransaction[];
  lastSyncedIndex: number;
  merkleRoot: string | null;

  // Internal
  _zkService: ZkService | null;

  // Actions
  initialize: (seedPhrase?: string) => Promise<void>;
  ensureInitialized: () => Promise<boolean>;
  refreshBalance: () => Promise<void>;
  shield: (
    amount: number,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<string>;
  unshield: (
    amount: number,
    recipient: PublicKey,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    useRelay?: boolean
  ) => Promise<string>;
  transfer: (
    recipient: string,
    amount: number,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<string>;
  scanNotes: () => Promise<void>;
  importNote: (noteString: string) => Promise<void>;
  getLastSentNote: () => { noteString: string; amount: number; leafIndex: number } | null;
  clearNotes: () => Promise<void>;
  cleanUpNotes: () => Promise<number>;
  dismissPendingTransaction: (id: string) => void;
  reset: () => void;
  // Stealth address methods
  getStealthKeys: () => { spendingPublicKey: string; viewingPublicKey: string; encoded: string } | null;
  unshieldStealth: (
    amount: number,
    recipientSpendingPubKey: string,
    recipientViewingPubKey: string,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<{ signature: string; stealthAddress: string; ephemeralPublicKey: string; viewTag: number }>;

  // True ZK private send via relayer
  privateSend: (
    recipientStealthKeys: string,
    denominationIndex: number,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<{
    success: boolean;
    txSignature?: string;
    stealthAddress?: string;
    error?: string;
  }>;

  // Stealth payment scanning and sweeping
  scanStealthPayments: () => Promise<{
    found: number;
    amount: number;
    payments: Array<{ stealthAddress: string; amount: number; signature: string }>;
  }>;
  getPendingStealthPayments: () => Array<{ stealthAddress: string; amount: number; signature: string }>;
  sweepStealthPayment: (stealthAddress: string, recipientAddress: string) => Promise<{
    success: boolean;
    signature?: string;
    error?: string;
  }>;
  sweepAllStealthPayments: (recipientAddress: string) => Promise<{
    success: boolean;
    swept: number;
    totalAmount: number;
    signatures: string[];
    errors: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Encrypted storage adapter (H2 — shielded notes and merkleRoot must not sit in AsyncStorage plaintext)
// ---------------------------------------------------------------------------

let _shieldedEncryptionKey: Uint8Array | null = null;

async function getShieldedEncryptionKey(): Promise<Uint8Array> {
  if (_shieldedEncryptionKey) return _shieldedEncryptionKey;
  const existing = await SecureStore.getItemAsync('p01_shielded_encryption_key');
  if (existing) {
    _shieldedEncryptionKey = new Uint8Array(Buffer.from(existing, 'base64'));
    return _shieldedEncryptionKey;
  }
  const key = nacl.randomBytes(32);
  await SecureStore.setItemAsync('p01_shielded_encryption_key', Buffer.from(key).toString('base64'));
  _shieldedEncryptionKey = key;
  return key;
}

function encryptShieldedData(data: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(new TextEncoder().encode(data), nonce, key);
  if (!encrypted) throw new Error('Encryption failed');
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return Buffer.from(combined).toString('base64');
}

function decryptShieldedData(encrypted: string, key: Uint8Array): string {
  const data = new Uint8Array(Buffer.from(encrypted, 'base64'));
  const nonce = data.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = data.slice(nacl.secretbox.nonceLength);
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) throw new Error('Decryption failed');
  return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Wallet-scoped archival (prevents note loss on wallet switch)
// ---------------------------------------------------------------------------

const SHIELDED_ARCHIVE_PREFIX = 'p01_shielded_archive_';

/** Archive shielded state for a wallet before switching. */
export async function archiveShieldedForWallet(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  const { notes, shieldedBalance, zkAddress, lastSyncedIndex, merkleRoot } = useShieldedStore.getState();
  if (notes.length === 0 && shieldedBalance === 0) return;
  try {
    const key = await getShieldedEncryptionKey();
    const data = JSON.stringify({ notes, shieldedBalance, zkAddress, lastSyncedIndex, merkleRoot });
    const encrypted = encryptShieldedData(data, key);
    await AsyncStorage.setItem(`${SHIELDED_ARCHIVE_PREFIX}${walletAddress}`, encrypted);
    console.log(`[Shielded] Archived ${notes.length} notes for wallet ${walletAddress.slice(0, 8)}...`);
  } catch (err) {
    console.error('[Shielded] Failed to archive:', (err as Error).message);
  }
}

/** Restore archived shielded state when switching back to a wallet. */
export async function restoreShieldedForWallet(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  try {
    const raw = await AsyncStorage.getItem(`${SHIELDED_ARCHIVE_PREFIX}${walletAddress}`);
    if (!raw) return;
    const key = await getShieldedEncryptionKey();
    const decrypted = decryptShieldedData(raw, key);
    const archived = JSON.parse(decrypted);
    if (!archived || !Array.isArray(archived.notes)) return;

    const current = useShieldedStore.getState();
    if (current.notes.length === 0 && archived.notes.length > 0) {
      useShieldedStore.setState({
        notes: archived.notes,
        shieldedBalance: archived.shieldedBalance ?? 0,
        zkAddress: archived.zkAddress ?? null,
        lastSyncedIndex: archived.lastSyncedIndex ?? 0,
        merkleRoot: archived.merkleRoot ?? null,
        isInitialized: true,
      });
      console.log(`[Shielded] Restored ${archived.notes.length} notes for wallet ${walletAddress.slice(0, 8)}...`);
    }
  } catch (err) {
    console.error('[Shielded] Failed to restore:', (err as Error).message);
  }
}

/** AsyncStorage wrapper that encrypts values at rest using nacl.secretbox */
const encryptedShieldedStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const raw = await AsyncStorage.getItem(name);
    if (!raw) return null;
    const key = await getShieldedEncryptionKey();
    return decryptShieldedData(raw, key);
  },
  setItem: async (name: string, value: string): Promise<void> => {
    const key = await getShieldedEncryptionKey();
    const encrypted = encryptShieldedData(value, key);
    await AsyncStorage.setItem(name, encrypted);
  },
  removeItem: async (name: string): Promise<void> => {
    await AsyncStorage.removeItem(name);
  },
};

const generateUUID = (): string => Crypto.randomUUID();

/**
 * Shielded wallet store for mobile
 * Uses the real ZK SDK service for proof generation and on-chain transactions
 */
export const useShieldedStore = create<ShieldedState>()(
  persist(
    (set, get) => ({
      // Initial state
      isInitialized: false,
      isLoading: false,
      shieldedBalance: 0,
      notes: [],
      zkAddress: null,
      pendingTransactions: [],
      lastSyncedIndex: 0,
      merkleRoot: null,
      _zkService: null,

      // AUTO-RESET: Clear old data due to key derivation fix (v2)
      // This runs once on app start to clear incompatible notes
      _dataVersion: 2,

      // Initialize the shielded wallet with real ZK service
      initialize: async (seedPhrase?: string) => {
        set({ isLoading: true });

        try {
          // If no seed phrase provided, try to get it from SecureStore
          let phrase = seedPhrase;
          if (!phrase) {
            // First try the main wallet mnemonic
            phrase = await SecureStore.getItemAsync(MNEMONIC_KEY, SECURE_OPTIONS) || undefined;

            if (!phrase) {
              // Try the ZK-specific seed (for Privy users who don't have local mnemonic)
              phrase = await SecureStore.getItemAsync(ZK_SEED_KEY, SECURE_OPTIONS) || undefined;

              if (phrase) {
              } else {
                // Generate a new ZK seed for Privy users
                phrase = generateMnemonic(wordlist, 128); // 12 words
                await SecureStore.setItemAsync(ZK_SEED_KEY, phrase, SECURE_OPTIONS);
              }
            } else {
            }
          }

          // Get or create ZK service instance
          const zkService = getZkService();

          // All proving is client-side (WebView snarkjs). No backend needed.

          // Initialize with user's seed phrase
          await zkService.initialize(phrase);

          // Get ZK address
          const zkAddress = zkService.getZkAddress();

          // Get initial balance and notes
          const balanceLamports = zkService.getShieldedBalance();
          const balance = Number(balanceLamports) / 1e9;

          // Sync notes from ZK service
          const zkNotes = zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set({
            isInitialized: true,
            zkAddress: zkAddress.encoded,
            shieldedBalance: balance,
            notes: serializedNotes,
            isLoading: false,
            _zkService: zkService,
          });

        } catch (error) {
          console.error('[Shielded] Initialize error:', error);
          set({ isLoading: false });
          throw error;
        }
      },

      // Ensure ZK service is initialized (called before shield/unshield/transfer)
      ensureInitialized: async () => {
        const { _zkService } = get();

        // If service exists, we're good
        if (_zkService) {
          return true;
        }

        // Try to initialize from SecureStore (handles app restart and post-migration cases)
        try {
          await get().initialize();
          return get()._zkService !== null;
        } catch (error) {
          console.error('[Shielded] Failed to initialize:', error);
          return false;
        }
      },

      // Refresh shielded balance from ZK service
      refreshBalance: async () => {
        // Try to ensure initialized first
        await get().ensureInitialized();

        const { _zkService } = get();
        if (!_zkService) return;

        set({ isLoading: true });

        try {
          const balanceLamports = _zkService.getShieldedBalance();
          const balance = Number(balanceLamports) / 1e9;

          set({
            shieldedBalance: balance,
            isLoading: false,
          });
        } catch (error) {
          console.error('[Shielded] Refresh balance error:', error);
          set({ isLoading: false });
        }
      },

      // Shield tokens using real ZK SDK
      shield: async (amount: number, walletPublicKey: PublicKey, signTransaction) => {
        // Ensure ZK service is initialized (handles app restart case)
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized. Please restart the app.');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = generateUUID();
        const amountLamports = BigInt(Math.floor(amount * 1e9));

        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'shield',
              amount,
              status: 'generating_proof',
              createdAt: Date.now(),
            },
          ],
        }));

        try {
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Call real ZK service
          const signature = await _zkService.shield(
            amountLamports,
            walletPublicKey,
            signTransaction
          );

          // Update state
          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;

          // Sync notes from ZK service
          const zkNotes = _zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set(state => ({
            shieldedBalance: newBalance,
            notes: serializedNotes,
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed', signature } : tx
            ),
          }));

          // Remove from pending after delay
          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 5000);

          return signature;
        } catch (error) {
          console.error('[Shielded] Shield error:', error);
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId
                ? { ...tx, status: 'failed', error: (error as Error).message }
                : tx
            ),
          }));
          throw error;
        }
      },

      // Unshield tokens using real ZK SDK (optional: via decentralized relay)
      unshield: async (amount: number, recipient: PublicKey, walletPublicKey: PublicKey, signTransaction, useRelay = false) => {
        // Ensure ZK service is initialized (handles app restart case)
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized. Please restart the app.');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = generateUUID();
        const amountLamports = BigInt(Math.floor(amount * 1e9));

        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'unshield',
              amount,
              status: 'generating_proof',
              createdAt: Date.now(),
            },
          ],
        }));

        try {
          // Update status to submitting
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Route through decentralized relay or direct
          const signature = useRelay
            ? await _zkService.unshieldViaRelay(
                recipient,
                amountLamports,
                walletPublicKey,
                signTransaction
              )
            : await _zkService.unshield(
                recipient,
                amountLamports,
                walletPublicKey,
                signTransaction
              );

          // Update state
          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;

          // Sync notes from ZK service
          const zkNotes = _zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set(state => ({
            shieldedBalance: newBalance,
            notes: serializedNotes,
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed', signature } : tx
            ),
          }));

          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 5000);

          return signature;
        } catch (error) {
          console.error('[Shielded] Unshield error:', error);
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId
                ? { ...tx, status: 'failed', error: (error as Error).message }
                : tx
            ),
          }));
          throw error;
        }
      },

      // Transfer shielded tokens via on-chain decentralized relay
      // Sender hidden (ephemeral payer), recipient hidden (stealth address)
      transfer: async (recipient: string, amount: number, walletPublicKey: PublicKey, signTransaction) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized. Please restart the app.');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = generateUUID();

        // Parse recipient ZK address to extract stealth keys
        if (!recipient.startsWith('zk:')) {
          throw new Error('Invalid ZK address format. Must start with "zk:"');
        }

        const combined = Buffer.from(recipient.slice(3), 'base64');
        const stealthKeysBase64 = combined.toString('base64');

        // Map denominations to indices
        const DENOMINATIONS = [0.1, 1, 10]; // SOL
        const closestDenom = DENOMINATIONS.reduce((prev, curr) =>
          Math.abs(curr - amount) < Math.abs(prev - amount) ? curr : prev
        );
        const denominationIndex = DENOMINATIONS.indexOf(closestDenom);

        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            { id: txId, type: 'transfer', amount, status: 'generating_proof', createdAt: Date.now() },
          ],
        }));

        try {
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Use privateSend which now routes through the on-chain relay
          const result = await _zkService.privateSend(
            stealthKeysBase64,
            denominationIndex,
            walletPublicKey,
            signTransaction
          );

          if (!result.success) {
            throw new Error(result.error || 'Private transfer failed');
          }

          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
          const zkNotes = _zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set(state => ({
            shieldedBalance: newBalance,
            notes: serializedNotes,
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed', signature: result.txSignature } : tx
            ),
          }));

          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 5000);

          return result.txSignature || '';

        } catch (error) {
          console.error('[Private Transfer] Error:', error);
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'failed', error: (error as Error).message } : tx
            ),
          }));
          throw error;
        }
      },

      // Scan for incoming notes on the blockchain
      scanNotes: async () => {
        // Try to ensure initialized first
        await get().ensureInitialized();

        const { _zkService } = get();
        if (!_zkService) return;

        set({ isLoading: true });

        try {
          // Get last scanned position
          const lastSignature = await _zkService.getLastScannedSignature();

          // Scan blockchain for incoming shielded notes
          const { found, newBalance } = await _zkService.scanIncomingNotes(lastSignature);

          // Update balance from scanned notes
          const balance = Number(newBalance) / 1e9;

          set({
            shieldedBalance: balance,
            lastSyncedIndex: get().lastSyncedIndex + found,
            isLoading: false,
          });

          if (found > 0) {
          }
        } catch (error) {
          console.error('[Shielded] Scan notes error:', error);
          // Fall back to just refreshing local balance
          await get().refreshBalance();
        } finally {
          set({ isLoading: false });
        }
      },

      // Import a note received from another user
      importNote: async (noteString: string) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not available');
        }

        set({ isLoading: true });

        try {
          const note = await _zkService.importNote(noteString);
          const amountSOL = Number(note.amount) / 1e9;

          // Refresh balance
          await get().refreshBalance();

        } finally {
          set({ isLoading: false });
        }
      },

      // Get the last sent note for sharing with recipient
      getLastSentNote: () => {
        const { _zkService } = get();
        if (!_zkService) return null;

        const lastNote = _zkService.getLastSentNote();
        if (!lastNote) return null;

        return {
          noteString: lastNote.noteString,
          amount: Number(lastNote.amount) / 1e9,
          leafIndex: lastNote.leafIndex,
        };
      },

      // Clear all notes (for when notes become unrecoverable)
      clearNotes: async () => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not available');
        }

        await _zkService.clearNotes();
        set({ shieldedBalance: 0, notes: [] });
      },

      // Clean up only 0-amount notes (safe alternative to clearNotes)
      cleanUpNotes: async () => {
        const { notes } = get();

        // Find 0-amount notes to remove
        const zeroNotes = notes.filter(n => Number(n.amount) === 0);
        if (zeroNotes.length === 0) return 0;

        // Update store - keep only non-zero notes
        const remaining = notes.filter(n => Number(n.amount) > 0);
        const newBalance = remaining.reduce((sum, n) => sum + Number(n.amount), 0) / 1e9;
        set({ notes: remaining, shieldedBalance: newBalance });

        return zeroNotes.length;
      },

      // Dismiss a pending transaction (remove from list)
      dismissPendingTransaction: (id: string) => {
        set(state => ({
          pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== id),
        }));
      },

      // Reset state
      reset: () => {
        const { _zkService } = get();
        if (_zkService) {
          _zkService.reset();
        }

        set({
          isInitialized: false,
          isLoading: false,
          shieldedBalance: 0,
          notes: [],
          zkAddress: null,
          pendingTransactions: [],
          lastSyncedIndex: 0,
          merkleRoot: null,
          _zkService: null,
        });
      },

      // Get stealth keys for receiving anonymous payments
      getStealthKeys: () => {
        const { _zkService } = get();
        if (!_zkService) {
          return null;
        }
        try {
          return _zkService.getStealthKeys();
        } catch (e) {
          console.error('[Shielded] Failed to get stealth keys:', e);
          return null;
        }
      },

      // Unshield to a stealth address for maximum privacy
      unshieldStealth: async (
        amount: number,
        recipientSpendingPubKey: string,
        recipientViewingPubKey: string,
        walletPublicKey: PublicKey,
        signTransaction: (tx: Transaction) => Promise<Transaction>
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not available');
        }

        set({ isLoading: true });
        const txId = generateUUID();

        try {
          // Add pending transaction
          const pendingTx: PendingTransaction = {
            id: txId,
            type: 'unshield',
            amount,
            createdAt: Date.now(),
            status: 'generating_proof',
          };
          set(state => ({
            pendingTransactions: [...state.pendingTransactions, pendingTx],
          }));

          // Perform stealth unshield
          const amountLamports = BigInt(Math.floor(amount * 1e9));
          const result = await _zkService.unshieldStealth(
            recipientSpendingPubKey,
            recipientViewingPubKey,
            amountLamports,
            walletPublicKey,
            signTransaction
          );

          // Update pending transaction
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed' as const, signature: result.signature } : tx
            ),
          }));

          // Refresh balance
          await get().refreshBalance();

          // Remove pending after delay
          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 3000);

          return {
            signature: result.signature,
            stealthAddress: result.stealthAddress,
            ephemeralPublicKey: result.ephemeralPublicKey,
            viewTag: result.viewTag,
          };
        } catch (e) {
          // Update pending transaction with error
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'failed' as const, error: (e as Error).message } : tx
            ),
          }));
          throw e;
        } finally {
          set({ isLoading: false });
        }
      },

      // TRUE ZK: Private send via relayer (anonymizing relay)
      // Sender hidden (relayer sends), recipient hidden (stealth address), amount hidden (fixed denominations)
      privateSend: async (
        recipientStealthKeys: string,
        denominationIndex: number,
        walletPublicKey: PublicKey,
        signTransaction: (tx: Transaction) => Promise<Transaction>
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { success: false, error: 'ZK service not initialized' };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { success: false, error: 'ZK service not available' };
        }

        const DENOMINATIONS = [0.1, 1, 10]; // SOL
        if (denominationIndex < 0 || denominationIndex >= DENOMINATIONS.length) {
          return { success: false, error: 'Invalid denomination' };
        }

        const amount = DENOMINATIONS[denominationIndex];
        const txId = generateUUID();

        set({ isLoading: true });
        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'transfer' as const,
              amount,
              status: 'generating_proof' as const,
              createdAt: Date.now(),
            },
          ],
        }));

        try {
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' as const } : tx
            ),
          }));

          const result = await _zkService.privateSend(
            recipientStealthKeys,
            denominationIndex,
            walletPublicKey,
            signTransaction
          );

          if (result.success) {
            // Refresh balance
            const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
            set(state => ({
              shieldedBalance: newBalance,
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'confirmed' as const, signature: result.txSignature } : tx
              ),
            }));

            setTimeout(() => {
              set(state => ({
                pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
              }));
            }, 5000);
          } else {
            set(state => ({
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'failed' as const, error: result.error } : tx
              ),
            }));
          }

          return result;
        } catch (e) {
          const error = (e as Error).message;
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'failed' as const, error } : tx
            ),
          }));
          return { success: false, error };
        } finally {
          set({ isLoading: false });
        }
      },

      // Scan for stealth payments sent to our addresses
      scanStealthPayments: async () => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { found: 0, amount: 0, payments: [] };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { found: 0, amount: 0, payments: [] };
        }

        const result = await _zkService.scanStealthPayments();
        return result;
      },

      // Get pending stealth payments that can be swept
      getPendingStealthPayments: () => {
        const { _zkService } = get();
        if (!_zkService) {
          return [];
        }
        return _zkService.getPendingStealthPayments();
      },

      // Sweep a single stealth payment to recipient address
      sweepStealthPayment: async (stealthAddress: string, recipientAddress: string) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { success: false, error: 'ZK service not initialized' };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { success: false, error: 'ZK service not available' };
        }

        return await _zkService.sweepStealthPayment(stealthAddress, recipientAddress);
      },

      // Sweep all pending stealth payments
      sweepAllStealthPayments: async (recipientAddress: string) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { success: false, swept: 0, totalAmount: 0, signatures: [], errors: ['ZK service not initialized'] };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { success: false, swept: 0, totalAmount: 0, signatures: [], errors: ['ZK service not available'] };
        }

        return await _zkService.sweepAllStealthPayments(recipientAddress);
      },
    }),
    {
      name: 'p01-shielded-mobile',
      version: 3, // v3: encrypted storage (H2)
      storage: createJSONStorage(() => encryptedShieldedStorage),
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        zkAddress: state.zkAddress,
        shieldedBalance: state.shieldedBalance,
        notes: state.notes,
        lastSyncedIndex: state.lastSyncedIndex,
        merkleRoot: state.merkleRoot,
      }),
      // Migration: reset on version change (key derivation fix / encrypted storage)
      migrate: (persistedState: any, version: number) => {
        if (version < 3) {
          // Also clear ZK service SecureStore notes (async, fire-and-forget)
          ZkService.resetStorage().catch(err =>
            console.error('[Shielded] Failed to reset ZK storage:', err)
          );
          // Return fresh state - old notes are incompatible / need re-encryption
          return {
            isInitialized: false,
            isLoading: false,
            shieldedBalance: 0,
            notes: [],
            zkAddress: null,
            pendingTransactions: [],
            lastSyncedIndex: 0,
            merkleRoot: null,
            _zkService: null,
          };
        }
        return persistedState;
      },
    }
  )
);
