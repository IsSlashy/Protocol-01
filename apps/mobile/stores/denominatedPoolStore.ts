import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../services/solana/connection';
import {
  type PoolConfig,
  type ShieldReceipt,
  type PoolOnChainInfo,
  type ProofGenerator,
  type WalletSigner,
  type ShareableNote,
  ALL_POOLS,
  SOL_POOLS,
  USDC_POOLS,
  fetchPoolInfo,
  shield,
  unshield,
  emergencyUnshield,
  transferNote as serviceTransferNote,
  importNote as serviceImportNote,
  exportNote as serviceExportNote,
  encodeShareableNote,
  decodeShareableNote,
  receiptToJSON,
  receiptFromJSON,
  slotToEpoch,
  findPool,
  createNullifier,
  bigintToLeBytes32,
  deriveNullifierPDA,
} from '../services/denominatedPool';
import { useWalletStore, getPrivySigner } from './walletStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoteStatus = 'pending' | 'mature' | 'spent' | 'transferred' | 'imported';
export type NoteSource = 'shielded' | 'received' | 'imported_backup';

export interface StoredNote {
  id: string; // commitment hex (first 16 chars)
  receiptJSON: string;
  token: 'SOL' | 'USDC';
  denomination: number;
  poolPDA: string;
  shieldedAt: number;
  status: NoteStatus;
  source: NoteSource;
  spentTxSig?: string;
  transferredTo?: string; // encoded shareable note (for re-display)
}

interface PoolCacheEntry {
  info: PoolOnChainInfo;
  fetchedAt: number;
}

type TokenFilter = 'SOL' | 'USDC' | 'ALL';

interface DenominatedPoolState {
  // Persisted
  notes: StoredNote[];
  selectedToken: TokenFilter;
  selectedDenomination: number | null;

  // Transient (not persisted)
  isLoading: boolean;
  error: string | null;
  /** Cached pool info keyed by pool PDA base58 */
  poolCache: Record<string, PoolCacheEntry>;
  /** Current operation progress message */
  progress: string | null;
  /** Whether proof generation is in progress (long-running) */
  isProving: boolean;

  // Actions
  refreshPoolInfo: (poolPDA?: string) => Promise<void>;
  refreshAllPools: () => Promise<void>;
  refreshNoteStatuses: () => Promise<void>;
  setSelectedToken: (token: TokenFilter) => void;
  setSelectedDenomination: (denom: number | null) => void;
  shieldNote: (pool: PoolConfig) => Promise<string>;
  unshieldNote: (
    noteId: string,
    recipient: string,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  emergencyUnshieldNote: (
    noteId: string,
    recipient: string,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  transferNote: (
    noteId: string,
    proofGenerator: ProofGenerator,
  ) => Promise<{ txSig: string; shareableNote: string }>;
  importNote: (encodedNote: string, source?: NoteSource) => void;
  exportAllNotes: () => string[];
  exportNote: (noteId: string) => string;
  getFilteredPools: () => PoolConfig[];
  getNotesForPool: (poolPDA: string) => StoredNote[];
  getActiveNotes: () => StoredNote[];
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POOL_CACHE_TTL = 30_000; // 30s

/** Build a WalletSigner for Privy wallets, or undefined for local keypair wallets. */
function getWalletSignerIfPrivy(): WalletSigner | undefined {
  const { isPrivyWallet, publicKey } = useWalletStore.getState();
  if (!isPrivyWallet || !publicKey) return undefined;
  const signer = getPrivySigner();
  if (!signer) return undefined;
  return { publicKey: new PublicKey(publicKey), signTransaction: signer };
}

function noteIdFromReceipt(receipt: ShieldReceipt): string {
  return receipt.commitment.toString(16).slice(0, 16);
}

function serializablePoolInfo(info: PoolOnChainInfo): PoolOnChainInfo {
  return {
    ...info,
    // Ensure bigints survive
    totalShielded: info.totalShielded,
    epochDelay: info.epochDelay,
    currentRoot: info.currentRoot,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDenominatedPoolStore = create<DenominatedPoolState>()(
  persist(
    (set, get) => ({
      // Initial state
      notes: [],
      selectedToken: 'SOL',
      selectedDenomination: null,
      isLoading: false,
      error: null,
      poolCache: {},
      progress: null,
      isProving: false,

      // ------------------------------------------------------------------
      // Pool info
      // ------------------------------------------------------------------

      refreshPoolInfo: async (poolPDA?: string) => {
        const connection = getConnection();
        const pools = poolPDA
          ? ALL_POOLS.filter(p => p.poolPDA.toBase58() === poolPDA)
          : ALL_POOLS;

        const cache = { ...get().poolCache };

        for (const pool of pools) {
          const key = pool.poolPDA.toBase58();
          const cached = cache[key];
          if (cached && Date.now() - cached.fetchedAt < POOL_CACHE_TTL) continue;

          try {
            const info = await fetchPoolInfo(connection, pool);
            if (info) {
              cache[key] = { info: serializablePoolInfo(info), fetchedAt: Date.now() };
            }
          } catch (err) {
            // Failed to fetch pool info — will retry on next refresh
          }
        }

        set({ poolCache: cache });
      },

      refreshAllPools: async () => {
        set({ isLoading: true, error: null });
        try {
          await get().refreshPoolInfo();
          await get().refreshNoteStatuses();
          set({ isLoading: false });
        } catch (err) {
          console.error('[DenomPool] refreshAllPools error:', err);
          set({ isLoading: false, error: (err as Error).message });
        }
      },

      // ------------------------------------------------------------------
      // Note status (mature / pending)
      // ------------------------------------------------------------------

      refreshNoteStatuses: async () => {
        const { notes } = get();
        if (notes.length === 0) return;

        try {
          const connection = getConnection();
          const slot = await connection.getSlot('confirmed');
          const currentEpoch = slotToEpoch(slot);

          // Check nullifier PDAs on-chain for non-terminal notes
          // If a nullifier PDA exists, the note was already spent (possibly on another device)
          const activeNotes = notes.filter(n => n.status !== 'spent' && n.status !== 'transferred');
          const nullifierPDAs: { noteId: string; pda: PublicKey }[] = [];

          for (const note of activeNotes) {
            try {
              const receipt = receiptFromJSON(note.receiptJSON);
              const nullifier = createNullifier(receipt.nullifierPreimage, receipt.secret);
              const nullifierBytes = bigintToLeBytes32(nullifier);
              const poolKey = new PublicKey(note.poolPDA);
              const [pda] = deriveNullifierPDA(poolKey, nullifierBytes);
              nullifierPDAs.push({ noteId: note.id, pda });
            } catch {
              // skip notes with invalid receipts
            }
          }

          // Batch fetch nullifier accounts
          const spentNoteIds = new Set<string>();
          if (nullifierPDAs.length > 0) {
            const accounts = await connection.getMultipleAccountsInfo(
              nullifierPDAs.map(n => n.pda)
            );
            for (let i = 0; i < accounts.length; i++) {
              if (accounts[i] !== null) {
                spentNoteIds.add(nullifierPDAs[i].noteId);
              }
            }
          }

          const updated = notes.map(note => {
            // Terminal states — never change
            if (note.status === 'spent' || note.status === 'transferred') return note;

            // Nullifier exists on-chain — note was spent (possibly on another device)
            if (spentNoteIds.has(note.id)) {
              return { ...note, status: 'spent' as NoteStatus };
            }

            const receipt = receiptFromJSON(note.receiptJSON);
            const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
            if (!pool) return note;

            const cached = get().poolCache[note.poolPDA];
            const epochDelay = cached?.info.epochDelay ?? 1n;

            const minEpoch = currentEpoch - epochDelay;
            const epochMature = receipt.depositEpoch <= minEpoch;
            // Enforce 1 hour minimum from deposit time
            const timeMature = (Date.now() - note.shieldedAt) >= 60 * 60 * 1000;
            const isMature = epochMature && timeMature;

            // imported notes go to mature when ready, pending/imported when not
            const newStatus: NoteStatus = isMature ? 'mature' : (note.status === 'imported' ? 'imported' : 'pending');
            return { ...note, status: newStatus };
          });

          set({ notes: updated });
        } catch (err) {
          // refreshNoteStatuses error — non-fatal
        }
      },

      // ------------------------------------------------------------------
      // Filters
      // ------------------------------------------------------------------

      setSelectedToken: (token) => set({ selectedToken: token, selectedDenomination: null }),
      setSelectedDenomination: (denom) => set({ selectedDenomination: denom }),

      getFilteredPools: () => {
        const { selectedToken } = get();
        if (selectedToken === 'SOL') return SOL_POOLS;
        if (selectedToken === 'USDC') return USDC_POOLS;
        return ALL_POOLS;
      },

      getNotesForPool: (poolPDA) => {
        return get().notes.filter(n => n.poolPDA === poolPDA && n.status !== 'spent');
      },

      getActiveNotes: () => {
        return get().notes.filter(n => n.status !== 'spent' && n.status !== 'transferred');
      },

      // ------------------------------------------------------------------
      // Shield (deposit)
      // ------------------------------------------------------------------

      shieldNote: async (pool) => {
        set({ isLoading: true, error: null, progress: 'Preparing...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const receipt = await shield(pool, (step) => {
            set({ progress: step });
          }, walletSigner);

          const storedNote: StoredNote = {
            id: noteIdFromReceipt(receipt),
            receiptJSON: receiptToJSON(receipt),
            token: pool.token,
            denomination: pool.denomination,
            poolPDA: pool.poolPDA.toBase58(),
            shieldedAt: receipt.shieldedAt,
            status: 'pending',
            source: 'shielded',
          };

          set(state => ({
            isLoading: false,
            progress: null,
            notes: [storedNote, ...state.notes],
          }));

          return storedNote.id;
        } catch (err) {
          console.error('[DenomPool] Shield error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Unshield (withdraw)
      // ------------------------------------------------------------------

      unshieldNote: async (noteId, recipientAddress, proofGenerator) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');

        const receipt = receiptFromJSON(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        const { PublicKey } = await import('@solana/web3.js');
        const recipient = new PublicKey(recipientAddress);

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await unshield(
            receipt,
            pool,
            recipient,
            proofGenerator,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
          );

          // Mark note as spent
          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          return sig;
        } catch (err) {
          console.error('[DenomPool] Unshield error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Emergency Unshield (bypass maturity)
      // ------------------------------------------------------------------

      emergencyUnshieldNote: async (noteId, recipientAddress, proofGenerator) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');

        const receipt = receiptFromJSON(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        const { PublicKey } = await import('@solana/web3.js');
        const recipient = new PublicKey(recipientAddress);

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing emergency unshield...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await emergencyUnshield(
            receipt,
            pool,
            recipient,
            proofGenerator,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
          );

          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          return sig;
        } catch (err) {
          console.error('[DenomPool] Emergency unshield error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Transfer note (peer-to-peer)
      // ------------------------------------------------------------------

      transferNote: async (noteId, proofGenerator) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status !== 'mature') throw new Error('Note must be mature for transfer');

        const receipt = receiptFromJSON(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing transfer...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const { txSig, recipientNote } = await serviceTransferNote(
            receipt,
            pool,
            proofGenerator,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
          );

          const encoded = encodeShareableNote(recipientNote);

          // Mark old note as transferred (not just spent)
          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'transferred' as NoteStatus, spentTxSig: txSig, transferredTo: encoded } : n
            ),
          }));

          return { txSig, shareableNote: encoded };
        } catch (err) {
          console.error('[DenomPool] Transfer error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Note import/export (backup & sharing)
      // ------------------------------------------------------------------

      importNote: (encodedNote, source: NoteSource = 'received') => {
        try {
          const noteData = decodeShareableNote(encodedNote);
          const receipt = serviceImportNote(noteData);
          const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === noteData.pool);
          if (!pool) throw new Error('Unknown pool');

          const storedNote: StoredNote = {
            id: noteIdFromReceipt(receipt),
            receiptJSON: receiptToJSON(receipt),
            token: noteData.token,
            denomination: noteData.denominationHuman,
            poolPDA: noteData.pool,
            shieldedAt: Date.now(),
            status: 'imported',
            source,
          };

          // Check if note already exists
          const existing = get().notes.find(n => n.id === storedNote.id);
          if (existing) {
            throw new Error('This note already exists in your wallet');
          }

          set(state => ({
            notes: [storedNote, ...state.notes],
            error: null,
          }));
        } catch (err) {
          console.error('[DenomPool] Import error:', err);
          set({ error: (err as Error).message });
          throw err;
        }
      },

      exportAllNotes: () => {
        const { notes } = get();
        return notes
          .filter(n => n.status !== 'spent')
          .map(n => {
            const receipt = receiptFromJSON(n.receiptJSON);
            const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === n.poolPDA);
            if (!pool) return '';
            return encodeShareableNote(serviceExportNote(receipt, pool));
          })
          .filter(Boolean);
      },

      exportNote: (noteId) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        const receipt = receiptFromJSON(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found');
        return encodeShareableNote(serviceExportNote(receipt, pool));
      },

      reset: () => {
        set({
          notes: [],
          selectedToken: 'SOL',
          selectedDenomination: null,
          isLoading: false,
          error: null,
          poolCache: {},
          progress: null,
          isProving: false,
        });
      },
    }),
    {
      name: 'p01-denominated-pool',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        notes: state.notes,
        selectedToken: state.selectedToken,
      }),
    },
  ),
);
