import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Shielded note data
 */
interface ShieldedNote {
  amount: bigint;
  commitment: bigint;
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

  // Actions
  initialize: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  shield: (amount: number) => Promise<string>;
  unshield: (amount: number) => Promise<string>;
  transfer: (recipient: string, amount: number) => Promise<string>;
  scanNotes: () => Promise<void>;
  reset: () => void;
}

// Helper to generate random bytes (React Native compatible)
const getRandomBytes = (length: number): Uint8Array => {
  const array = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    array[i] = Math.floor(Math.random() * 256);
  }
  return array;
};

// Helper to generate UUID
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Serialize bigint for storage
const serializeNote = (note: ShieldedNote) => ({
  ...note,
  amount: note.amount.toString(),
  commitment: note.commitment.toString(),
});

const deserializeNote = (note: any): ShieldedNote => ({
  ...note,
  amount: BigInt(note.amount),
  commitment: BigInt(note.commitment),
});

/**
 * Shielded wallet store for mobile
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

      // Initialize the shielded wallet
      initialize: async () => {
        set({ isLoading: true });

        try {
          // In production, this would:
          // 1. Load the spending key from secure storage
          // 2. Initialize the ZK SDK client
          // 3. Generate the ZK address
          // 4. Scan for existing notes

          // For now, generate a mock ZK address
          const randomBytes = getRandomBytes(32);
          const base64 = Buffer.from(randomBytes).toString('base64').slice(0, 32);
          const mockZkAddress = `zk:${base64}`;

          set({
            isInitialized: true,
            zkAddress: mockZkAddress,
            isLoading: false,
          });

          // Scan for notes after initialization
          await get().scanNotes();
        } catch (error) {
          console.error('[Shielded] Initialize error:', error);
          set({ isLoading: false });
          throw error;
        }
      },

      // Refresh shielded balance
      refreshBalance: async () => {
        const { notes } = get();
        set({ isLoading: true });

        try {
          // Calculate balance from notes
          const balance = notes.reduce(
            (sum, note) => sum + Number(note.amount) / 1e9,
            0
          );

          set({
            shieldedBalance: balance,
            isLoading: false,
          });
        } catch (error) {
          console.error('[Shielded] Refresh balance error:', error);
          set({ isLoading: false });
        }
      },

      // Shield tokens
      shield: async (amount: number) => {
        const txId = generateUUID();

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
          // In production, this would:
          // 1. Create a new note commitment
          // 2. Call the shield instruction on-chain
          // 3. Wait for confirmation
          // 4. Update local note storage

          // Simulate proof generation delay
          await new Promise(resolve => setTimeout(resolve, 2000));

          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Simulate transaction submission
          await new Promise(resolve => setTimeout(resolve, 1500));

          // Create new note
          const randomBytes = getRandomBytes(32);
          const newNote: ShieldedNote = {
            amount: BigInt(Math.floor(amount * 1e9)),
            commitment: BigInt('0x' + Buffer.from(randomBytes).toString('hex')),
            leafIndex: get().notes.length,
            createdAt: Date.now(),
          };

          set(state => ({
            notes: [...state.notes, newNote],
            shieldedBalance: state.shieldedBalance + amount,
            pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
          }));

          return 'mock_signature_' + txId;
        } catch (error) {
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

      // Unshield tokens
      unshield: async (amount: number) => {
        const txId = generateUUID();

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
          // In production, this would:
          // 1. Select notes to spend
          // 2. Generate ZK proof
          // 3. Call the unshield instruction
          // 4. Update local state

          // Simulate proof generation
          await new Promise(resolve => setTimeout(resolve, 3000));

          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          await new Promise(resolve => setTimeout(resolve, 1500));

          // Remove spent notes (simplified - would need proper coin selection)
          const amountLamports = BigInt(Math.floor(amount * 1e9));
          let remaining = amountLamports;
          const newNotes: ShieldedNote[] = [];

          for (const note of get().notes) {
            if (remaining > 0 && note.amount <= remaining) {
              remaining -= note.amount;
            } else if (remaining > 0 && note.amount > remaining) {
              // Create change note
              newNotes.push({
                ...note,
                amount: note.amount - remaining,
              });
              remaining = BigInt(0);
            } else {
              newNotes.push(note);
            }
          }

          set(state => ({
            notes: newNotes,
            shieldedBalance: state.shieldedBalance - amount,
            pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
          }));

          return 'mock_signature_' + txId;
        } catch (error) {
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

      // Transfer shielded tokens
      transfer: async (recipient: string, amount: number) => {
        const txId = generateUUID();

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
          // In production, this would:
          // 1. Parse recipient ZK address
          // 2. Select notes to spend
          // 3. Create output notes
          // 4. Generate ZK proof
          // 5. Submit transaction

          await new Promise(resolve => setTimeout(resolve, 4000));

          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          await new Promise(resolve => setTimeout(resolve, 1500));

          // Update balance (simplified)
          set(state => ({
            shieldedBalance: state.shieldedBalance - amount,
            pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
          }));

          return 'mock_signature_' + txId;
        } catch (error) {
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

      // Scan for incoming notes
      scanNotes: async () => {
        set({ isLoading: true });

        try {
          // In production, this would:
          // 1. Fetch commitment events from chain
          // 2. Try to decrypt each with viewing key
          // 3. Add successful decryptions to notes

          // For now, just update balance
          await get().refreshBalance();
        } catch (error) {
          console.error('[Shielded] Scan notes error:', error);
        } finally {
          set({ isLoading: false });
        }
      },

      // Reset state
      reset: () => {
        set({
          isInitialized: false,
          isLoading: false,
          shieldedBalance: 0,
          notes: [],
          zkAddress: null,
          pendingTransactions: [],
          lastSyncedIndex: 0,
          merkleRoot: null,
        });
      },
    }),
    {
      name: 'p01-shielded-mobile',
      storage: createJSONStorage(() => AsyncStorage),
      // Custom serializer for bigint
      partialize: (state) => ({
        ...state,
        notes: state.notes.map(serializeNote),
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.notes) {
          state.notes = state.notes.map(deserializeNote);
        }
      },
    }
  )
);
