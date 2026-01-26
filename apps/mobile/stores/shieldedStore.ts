import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PublicKey, Transaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import { getZkService, ZkService, ZkAddress, Note } from '../services/zk';

const MNEMONIC_KEY = 'p01_mnemonic';

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
    signTransaction: (tx: Transaction) => Promise<Transaction>
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
  reset: () => void;
}

// Helper to generate UUID
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

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
            phrase = await SecureStore.getItemAsync(MNEMONIC_KEY, SECURE_OPTIONS) || undefined;
            if (!phrase) {
              console.warn('[Shielded] No seed phrase available for initialization');
              set({ isLoading: false });
              return;
            }
            console.log('[Shielded] Retrieved seed phrase from SecureStore');
          }

          // Get or create ZK service instance
          const zkService = getZkService();

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

          console.log('[Shielded] Initialized with ZK address:', zkAddress.encoded);
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
        console.log('[Shielded] Initializing ZK service from SecureStore...');
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

          console.log('[Shielded] Shield successful:', signature);
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

      // Unshield tokens using real ZK SDK
      unshield: async (amount: number, recipient: PublicKey, walletPublicKey: PublicKey, signTransaction) => {
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

          // Call real ZK service
          const signature = await _zkService.unshield(
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

          console.log('[Shielded] Unshield successful:', signature);
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

      // Transfer shielded tokens using real ZK SDK
      transfer: async (recipient: string, amount: number, walletPublicKey: PublicKey, signTransaction) => {
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

        // Parse recipient ZK address
        if (!recipient.startsWith('zk:')) {
          throw new Error('Invalid ZK address format. Must start with "zk:"');
        }

        const combined = Buffer.from(recipient.slice(3), 'base64');
        const receivingPubkeyBytes = combined.slice(0, 32);
        const viewingKey = combined.slice(32, 64);

        // Convert to bigint (little-endian: start from MSB position)
        let receivingPubkey = BigInt(0);
        for (let i = receivingPubkeyBytes.length - 1; i >= 0; i--) {
          receivingPubkey = (receivingPubkey << BigInt(8)) + BigInt(receivingPubkeyBytes[i]);
        }

        console.log('[Shielded Transfer] Recipient ZK address:', recipient.slice(0, 30) + '...');
        console.log('[Shielded Transfer] Parsed receivingPubkey:', receivingPubkey.toString().slice(0, 30) + '...');
        console.log('[Shielded Transfer] Full receivingPubkey:', receivingPubkey.toString());

        const zkRecipient: ZkAddress = {
          receivingPubkey,
          viewingKey,
          encoded: recipient,
        };

        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'transfer',
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
          const signature = await _zkService.transfer(
            zkRecipient,
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

          console.log('[Shielded] Transfer successful:', signature);
          return signature;
        } catch (error) {
          console.error('[Shielded] Transfer error:', error);
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
            console.log(`[Shielded] Found ${found} new incoming notes`);
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

          console.log('[Shielded] Imported note:', amountSOL, 'SOL');
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
        console.log('[Shielded] Notes cleared');
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
    }),
    {
      name: 'p01-shielded-mobile',
      version: 2, // Increment when data format changes
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        zkAddress: state.zkAddress,
        shieldedBalance: state.shieldedBalance,
        notes: state.notes,
        lastSyncedIndex: state.lastSyncedIndex,
        merkleRoot: state.merkleRoot,
      }),
      // Migration: reset on version change (key derivation fix)
      migrate: (persistedState: any, version: number) => {
        console.log('[Shielded] Migration check: stored version', version, '-> current version 2');
        if (version < 2) {
          console.log('[Shielded] Resetting shielded wallet due to key derivation fix');
          // Also clear ZK service SecureStore notes (async, fire-and-forget)
          ZkService.resetStorage().catch(err =>
            console.error('[Shielded] Failed to reset ZK storage:', err)
          );
          // Return fresh state - old notes are incompatible
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
