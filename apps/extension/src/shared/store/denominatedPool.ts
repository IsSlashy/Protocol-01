import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useWalletStore, getPrivySigner } from './wallet';
import { getConnection } from '../services/wallet';
import {
  type ShieldReceipt,
  type PoolInfo,
  DENOMINATIONS,
  deriveDenominatedPoolPDA,
  prepareShield,
  prepareUnshield,
  receiptToJSON,
  receiptFromJSON,
  slotToEpoch,
  createNullifier,
} from '../services/denominatedPool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoteStatus = 'pending' | 'mature' | 'spent';

export interface StoredNote {
  id: string;
  receiptJSON: string;
  token: 'SOL' | 'USDC';
  denomination: number;
  poolPDA: string;
  shieldedAt: number;
  status: NoteStatus;
  spentTxSig?: string;
}

interface PoolCacheEntry {
  info: PoolInfo;
  fetchedAt: number;
}

type TokenFilter = 'SOL' | 'USDC' | 'ALL';

const NATIVE_SOL_MINT = SystemProgram.programId;
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const SOL_DENOMINATIONS = [0.1, 1, 10, 100]; // SOL amounts
const USDC_DENOMINATIONS = [1, 10, 100, 1000]; // USDC amounts

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface DenominatedPoolState {
  notes: StoredNote[];
  selectedToken: TokenFilter;
  isLoading: boolean;
  isProving: boolean;
  error: string | null;
  progress: string | null;
  poolCache: Record<string, PoolCacheEntry>;

  // Actions
  shieldNote: (token: 'SOL' | 'USDC', denomination: number) => Promise<void>;
  unshieldNote: (noteId: string, recipient?: string) => Promise<string>;
  refreshNotes: () => Promise<void>;
  getActiveNotes: () => StoredNote[];
  getMatureNotes: () => StoredNote[];
  getPendingNotes: () => StoredNote[];
  setSelectedToken: (token: TokenFilter) => void;
  clearError: () => void;
  reset: () => void;
}

function getWalletData() {
  const walletState = useWalletStore.getState();
  const privySigner = getPrivySigner();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const keypair = walletState._keypair;
  const network = walletState.network;
  const connection = getConnection(network);

  const signTransaction = async (tx: any) => {
    if (walletState.isPrivyWallet && privySigner) {
      return await privySigner(tx);
    } else if (keypair) {
      tx.sign(keypair);
      return tx;
    }
    throw new Error('No signing method available');
  };

  return { walletPublicKey, keypair, connection, signTransaction, network };
}

export const useDenominatedPoolStore = create<DenominatedPoolState>()(
  persist(
    (set, get) => ({
      notes: [],
      selectedToken: 'ALL',
      isLoading: false,
      isProving: false,
      error: null,
      progress: null,
      poolCache: {},

      shieldNote: async (token, denomination) => {
        set({ isLoading: true, error: null, progress: 'Preparing shield...' });

        try {
          const { walletPublicKey, connection, signTransaction } = getWalletData();

          const tokenMint = token === 'SOL' ? NATIVE_SOL_MINT : USDC_MINT;
          const denominationLamports = token === 'SOL'
            ? BigInt(Math.round(denomination * LAMPORTS_PER_SOL))
            : BigInt(Math.round(denomination * 1e6));

          const [poolPDA] = deriveDenominatedPoolPDA(tokenMint, denominationLamports);

          set({ progress: 'Computing commitment...' });

          const { receipt, commitment, newRoot, commitmentBytes, newRootBytes } =
            await prepareShield(connection, tokenMint, denominationLamports, poolPDA);

          set({ progress: 'Sending transaction...' });

          // Build and send shield transaction via service
          // For now, store the receipt — the actual TX logic will be added
          const noteId = commitment.toString(16).slice(0, 16);

          const storedNote: StoredNote = {
            id: noteId,
            receiptJSON: receiptToJSON(receipt),
            token,
            denomination,
            poolPDA: poolPDA.toBase58(),
            shieldedAt: Date.now(),
            status: 'pending',
          };

          set(state => ({
            notes: [...state.notes, storedNote],
            isLoading: false,
            progress: null,
          }));
        } catch (err) {
          set({
            isLoading: false,
            progress: null,
            error: (err as Error).message,
          });
          throw err;
        }
      },

      unshieldNote: async (noteId, recipient) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');

        set({ isProving: true, error: null, progress: 'Preparing unshield...' });

        try {
          const { walletPublicKey, connection, signTransaction } = getWalletData();
          const receipt = receiptFromJSON(note.receiptJSON);

          set({ progress: 'Generating ZK proof...' });

          const poolPDA = new PublicKey(note.poolPDA);
          const epochDelay = BigInt(2); // Default epoch delay

          const { circuitInputs, nullifier, nullifierBytes, merkleRootBytes, minEpoch } =
            await prepareUnshield(receipt, connection, epochDelay);

          // TODO: Generate proof via worker and submit transaction
          set({ progress: 'Proof generated. Submitting...' });

          // Mark note as spent
          set(state => ({
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus } : n
            ),
            isProving: false,
            progress: null,
          }));

          return 'pending'; // placeholder signature
        } catch (err) {
          set({
            isProving: false,
            progress: null,
            error: (err as Error).message,
          });
          throw err;
        }
      },

      refreshNotes: async () => {
        set({ isLoading: true });
        try {
          const { connection } = getWalletData();
          const slot = await connection.getSlot('confirmed');
          const currentEpoch = slotToEpoch(slot);

          set(state => ({
            notes: state.notes.map(note => {
              if (note.status === 'spent') return note;
              try {
                const receipt = receiptFromJSON(note.receiptJSON);
                const epochDelay = BigInt(2);
                const minEpoch = currentEpoch - epochDelay;
                const isMature = receipt.depositEpoch <= minEpoch;
                return { ...note, status: isMature ? 'mature' as NoteStatus : 'pending' as NoteStatus };
              } catch {
                return note;
              }
            }),
            isLoading: false,
          }));
        } catch {
          set({ isLoading: false });
        }
      },

      getActiveNotes: () => {
        return get().notes.filter(n => n.status !== 'spent');
      },

      getMatureNotes: () => {
        return get().notes.filter(n => n.status === 'mature');
      },

      getPendingNotes: () => {
        return get().notes.filter(n => n.status === 'pending');
      },

      setSelectedToken: (token) => {
        set({ selectedToken: token });
      },

      clearError: () => {
        set({ error: null });
      },

      reset: () => {
        set({
          notes: [],
          selectedToken: 'ALL',
          isLoading: false,
          isProving: false,
          error: null,
          progress: null,
          poolCache: {},
        });
      },
    }),
    {
      name: 'p01-denominated-pool',
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
        notes: state.notes,
        selectedToken: state.selectedToken,
      }),
    }
  )
);
