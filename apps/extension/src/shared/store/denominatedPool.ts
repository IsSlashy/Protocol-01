/**
 * Denominated Pool Store — Extension
 *
 * Zustand store with chrome.storage.local persistence for denominated pool
 * notes (ShieldReceipt[]). Implements shieldNote (C6 shield) and
 * getSpendableNote (lookup for C1 subscribe).
 *
 * Storage adapter pattern mirrors subscriptionVault store.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { PublicKey } from '@solana/web3.js';

import {
  type ShieldReceipt,
  type PoolConfig,
  type PrepareUnshieldResult,
  type ShareableNote,
  findPoolV3,
  prepareShieldInsert,
  shieldV3,
  prepareUnshield,
  unshieldDenominatedStarkV3,
  prepareTransfer,
  transferDenominatedStarkV3,
  importNote,
  shareableNoteToReceipt,
} from '../services/denominatedPool';
import {
  decryptNote,
  createNoteEncryptionAddress,
  isEncryptedNoteBlob,
} from '../services/noteCrypto';
import { noteMaturity } from '../services/maturity';

import { useWalletStore } from './wallet';
import { getConnection } from '../services/wallet';
import type { WalletSigner } from '../services/stark';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serialised ShieldReceipt (bigints → strings for JSON). */
interface SerializedReceipt {
  secret: string;
  nullifierPreimage: string;
  depositEpoch: string;
  tokenMint: string;
  commitment: string;
  leafIndex: number;
  denomination: string;
  pool: string;
  token: 'SOL' | 'USDC';
  denominationHuman: number;
  shieldedAt: number;
  merklePathElements?: string[];
  merklePathIndices?: number[];
  merkleRoot?: string;
  source?: 'shielded' | 'received';
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function serializeReceipt(r: ShieldReceipt): SerializedReceipt {
  return {
    secret: r.secret.toString(),
    nullifierPreimage: r.nullifierPreimage.toString(),
    depositEpoch: r.depositEpoch.toString(),
    tokenMint: r.tokenMint.toString(),
    commitment: r.commitment.toString(),
    leafIndex: r.leafIndex,
    denomination: r.denomination.toString(),
    pool: r.pool,
    token: r.token,
    denominationHuman: r.denominationHuman,
    shieldedAt: r.shieldedAt,
    merklePathElements: r.merklePathElements?.map(e => e.toString()),
    merklePathIndices: r.merklePathIndices,
    merkleRoot: r.merkleRoot?.toString(),
    source: r.source,
  };
}

function deserializeReceipt(s: SerializedReceipt): ShieldReceipt {
  return {
    secret: BigInt(s.secret),
    nullifierPreimage: BigInt(s.nullifierPreimage),
    depositEpoch: BigInt(s.depositEpoch),
    tokenMint: BigInt(s.tokenMint),
    commitment: BigInt(s.commitment),
    leafIndex: s.leafIndex,
    denomination: BigInt(s.denomination),
    pool: s.pool,
    token: s.token,
    denominationHuman: s.denominationHuman,
    shieldedAt: s.shieldedAt,
    merklePathElements: s.merklePathElements?.map(BigInt),
    merklePathIndices: s.merklePathIndices,
    merkleRoot: s.merkleRoot !== undefined ? BigInt(s.merkleRoot) : undefined,
    source: s.source,
  };
}

// ---------------------------------------------------------------------------
// Store state / actions
// ---------------------------------------------------------------------------

interface DenominatedPoolState {
  /** Stored notes (serialised for JSON persistence). */
  serializedNotes: SerializedReceipt[];
  /** Per-pool note counter: poolPDA (base58) -> next counter. */
  counterByPool: Record<string, number>;
  loading: boolean;
  error: string | null;

  // Computed
  getNotes: () => ShieldReceipt[];
  getSpendableNote: (token: 'SOL' | 'USDC', denomination: number) => ShieldReceipt | null;

  // Actions
  addNote: (receipt: ShieldReceipt) => void;
  /** Drop a note from the local picker by its commitment string (e.g. once it
   * has been spent by a subscription, or detected spent on-chain). */
  removeNote: (noteId: string) => void;
  shieldNote: (params: {
    token: 'SOL' | 'USDC';
    denomination: number;
    onProgress?: (step: string) => void;
  }) => Promise<{ txSig: string; receipt: ShieldReceipt }>;
  unshieldNote: (params: {
    noteId: string; // commitment.toString() — uniquely identifies the note
    recipient?: string; // Solana address; defaults to own wallet
    emergency?: boolean; // true = bypass maturity (min_epoch = 0)
    onProgress?: (step: string) => void;
  }) => Promise<{ txSig: string }>;
  /**
   * Private note-to-note transfer (C1+C3+C6). Spends a mature note and mints a
   * fresh note for the recipient, returned as a post-quantum ENCRYPTED blob
   * addressed to `recipientAddress` (p01pq:…). Only the recipient's wallet seed
   * can decrypt it, so the blob is safe to intercept. The note must be MATURE
   * (the on-chain handler enforces it).
   */
  transferNote: (params: {
    noteId: string; // commitment.toString() of the note to spend
    recipientAddress: string; // recipient's p01pq:… note address
    onProgress?: (step: string) => void;
  }) => Promise<{ txSig: string; encryptedNote: string }>;
  /** Import a received note (plaintext or p01enc1 encrypted) into the note set. */
  importNoteAction: (params: {
    encoded: string;
    source?: 'received';
  }) => Promise<ShieldReceipt>;
  /** Decode a received note for preview (decrypts p01enc1 blobs with the seed). */
  peekNote: (encoded: string) => ShareableNote;
  /** This wallet's public p01pq:… address — share it to receive private notes. */
  getMyNoteAddress: () => string;
  reset: () => void;
  setError: (error: string | null) => void;

  /** Prepared unshield result cache — avoids re-generating proofs on retry. */
  _preparedUnshield: PrepareUnshieldResult | null;
}

// ---------------------------------------------------------------------------
// WalletSigner factory (same pattern as subscriptionVault)
// ---------------------------------------------------------------------------

function createWalletSigner(): { signer: WalletSigner; connection: ReturnType<typeof getConnection> } {
  const walletState = useWalletStore.getState();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  if (!keypair) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const signer: WalletSigner = {
    publicKey: walletPublicKey,
    signTransaction: async (tx) => {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
      if (!tx.feePayer) tx.feePayer = walletPublicKey;
      tx.sign(keypair);
      return tx;
    },
  };

  return { signer, connection };
}

/**
 * Derive walletSeed from the current wallet store.
 * Uses _keypair.secretKey.slice(0,32) (mirrors mobile
 * denominatedPoolStore.ts:841). The local keypair is the only key source post
 * Privy-removal — throws if the wallet is locked.
 */
function getWalletSeed(): Uint8Array {
  const walletState = useWalletStore.getState();
  const keypair = walletState._keypair;
  if (!keypair) {
    throw new Error(
      'Cannot derive wallet seed: wallet is locked. Unlock and try again.',
    );
  }
  return keypair.secretKey.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDenominatedPoolStore = create<DenominatedPoolState>()(
  persist(
    (set, get) => ({
      serializedNotes: [],
      counterByPool: {},
      loading: false,
      error: null,
      _preparedUnshield: null,

      getNotes: () => get().serializedNotes.map(deserializeReceipt),

      getSpendableNote: (token, denomination) => {
        const pool = findPoolV3(token, denomination);
        if (!pool) return null;
        const poolAddr = pool.poolPDA.toBase58();
        const notes = get().serializedNotes
          .map(deserializeReceipt)
          .filter(n => n.pool === poolAddr);
        return notes[0] ?? null;
      },

      addNote: (receipt) => {
        set((state) => ({
          serializedNotes: [...state.serializedNotes, serializeReceipt(receipt)],
        }));
      },

      removeNote: (noteId) => {
        set((state) => ({
          serializedNotes: state.serializedNotes.filter((n) => n.commitment !== noteId),
        }));
      },

      shieldNote: async ({ token, denomination, onProgress }) => {
        const pool: PoolConfig | undefined = findPoolV3(token, denomination);
        if (!pool) {
          throw new Error(`No V3 pool found for ${token} ${denomination}`);
        }

        set({ loading: true, error: null });

        try {
          const { signer, connection } = createWalletSigner();
          const walletSeed = getWalletSeed();

          const poolAddr = pool.poolPDA.toBase58();
          const counter = get().counterByPool[poolAddr] ?? 0;

          // Prepare (derive note, compute path, generate C6 proof).
          const { c6ProofResult, insertParams } = await prepareShieldInsert(
            pool,
            connection,
            walletSeed,
            counter,
            onProgress,
          );

          // Shield on-chain.
          const { txSig, receipt } = await shieldV3(
            pool,
            c6ProofResult,
            insertParams,
            signer,
            connection,
            onProgress,
          );

          // Persist note + advance counter.
          set((state) => ({
            serializedNotes: [...state.serializedNotes, serializeReceipt(receipt)],
            counterByPool: {
              ...state.counterByPool,
              [poolAddr]: counter + 1,
            },
            loading: false,
          }));

          return { txSig, receipt };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          set({ loading: false, error: msg });
          throw err;
        }
      },

      unshieldNote: async ({ noteId, recipient, emergency = false, onProgress }) => {
        const notes = get().getNotes();
        const receipt = notes.find((n) => n.commitment.toString() === noteId);
        if (!receipt) {
          throw new Error(`Note ${noteId} not found in store`);
        }

        const { signer, connection } = createWalletSigner();

        // Resolve recipient — default to own wallet pubkey.
        let recipientPubkey: import('@solana/web3.js').PublicKey;
        if (recipient) {
          const { PublicKey } = await import('@solana/web3.js');
          recipientPubkey = new PublicKey(recipient);
        } else {
          const { PublicKey } = await import('@solana/web3.js');
          const walletState = useWalletStore.getState();
          if (!walletState.publicKey) throw new Error('Wallet not unlocked');
          recipientPubkey = new PublicKey(walletState.publicKey);
        }

        const poolConfig: PoolConfig | undefined = findPoolV3(receipt.token, receipt.denominationHuman);
        if (!poolConfig) {
          throw new Error(`Pool not found for note: ${receipt.token} ${receipt.denominationHuman}`);
        }

        set({ loading: true, error: null });
        try {
          // Prepare (fetch leaves, build path, root-preflight, C1+C3 proofs).
          onProgress?.('Preparing unshield proofs...');
          const prepared = await prepareUnshield(receipt, poolConfig, connection, onProgress);
          set({ _preparedUnshield: prepared });

          // Submit C1 + C3, send unshield ix.
          const txSig = await unshieldDenominatedStarkV3(
            receipt,
            poolConfig,
            recipientPubkey,
            prepared,
            signer,
            connection,
            onProgress,
            emergency,
          );

          // Remove spent note from store.
          set((state) => ({
            serializedNotes: state.serializedNotes.filter(
              (n) => n.commitment !== noteId,
            ),
            loading: false,
            _preparedUnshield: null,
          }));

          return { txSig };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          set({ loading: false, error: msg });
          throw err;
        }
      },

      transferNote: async ({ noteId, recipientAddress, onProgress }) => {
        const notes = get().getNotes();
        const receipt = notes.find((n) => n.commitment.toString() === noteId);
        if (!receipt) {
          throw new Error(`Note ${noteId} not found in store`);
        }

        const poolConfig: PoolConfig | undefined = findPoolV3(receipt.token, receipt.denominationHuman);
        if (!poolConfig) {
          throw new Error(`Pool not found for note: ${receipt.token} ${receipt.denominationHuman}`);
        }

        const { signer, connection } = createWalletSigner();

        set({ loading: true, error: null });
        try {
          // Fast pre-flight BEFORE the ~2-3 min of proving: the transfer funds an
          // ephemeral signer with ~2.7 SOL (3 STARK proof buffers held open at
          // once, ~0.9 SOL rent each, all swept back after). Gate on the full
          // 3-buffer estimate so we never prove then fail to fund the ephemeral.
          onProgress?.('Checking wallet balance...');
          const balance = await connection.getBalance(signer.publicKey);
          const perBuffer = await connection.getMinimumBalanceForRentExemption(83 + 135_000);
          const estRequired = perBuffer * 3 + 10_000_000; // 3 buffers + nullifier + fees + margin
          if (balance < estRequired) {
            throw new Error(
              `Insufficient SOL for transfer. It needs ~${(estRequired / 1e9).toFixed(2)} SOL ` +
              `of temporary proof-buffer rent (3 STARK proofs, fully recovered after the tx), but ` +
              `the wallet has only ${(balance / 1e9).toFixed(3)} SOL. Fund the wallet (devnet: ` +
              `request an airdrop) and try again.`,
            );
          }

          // Maturity pre-flight: transfer ENFORCES current_epoch >= deposit_epoch +
          // dynamic_delay on-chain (unlike unshield). Fail BEFORE the ~2-3 min of
          // proving + buffer-rent churn instead of dying on EpochDelayNotMet (6023).
          // Same logic as the live countdown the user sees (shared noteMaturity).
          onProgress?.('Checking note maturity...');
          const slot = await connection.getSlot('confirmed');
          const mat = noteMaturity(receipt.depositEpoch, { slot, at: Date.now() }, Date.now());
          if (!mat.ready) {
            throw new Error(
              `Note is not mature enough to transfer yet (${mat.label}). ` +
              `Wait for it to mature, then transfer.`,
            );
          }

          // Prepare: C1+C3 over the old note + fresh-secret C6 for the new note.
          onProgress?.('Preparing transfer proofs...');
          const prepared = await prepareTransfer(receipt, poolConfig, connection, onProgress);

          // Submit C1+C3+C6, send transfer ix; the service encrypts the output
          // note to recipientAddress (post-quantum hybrid).
          const { txSig, encryptedNote } = await transferDenominatedStarkV3(
            receipt,
            poolConfig,
            prepared,
            signer,
            connection,
            recipientAddress,
            onProgress,
          );

          // The old note is spent (nullified on-chain) — drop it from the picker.
          set((state) => ({
            serializedNotes: state.serializedNotes.filter((n) => n.commitment !== noteId),
            loading: false,
          }));

          return { txSig, encryptedNote };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          set({ loading: false, error: msg });
          throw err;
        }
      },

      peekNote: (encoded) => {
        const trimmed = encoded.trim();
        if (isEncryptedNoteBlob(trimmed)) {
          const plaintext = decryptNote(getWalletSeed(), trimmed);
          return JSON.parse(new TextDecoder().decode(plaintext)) as ShareableNote;
        }
        // Plaintext fallback (legacy / cross-client).
        return JSON.parse(atob(trimmed)) as ShareableNote;
      },

      getMyNoteAddress: () => createNoteEncryptionAddress(getWalletSeed()),

      importNoteAction: async ({ encoded, source = 'received' }) => {
        const trimmed = encoded.trim();
        let receipt: ShieldReceipt;
        if (isEncryptedNoteBlob(trimmed)) {
          // Decrypt with this wallet's seed, then validate + reconstruct.
          const plaintext = decryptNote(getWalletSeed(), trimmed);
          const note = JSON.parse(new TextDecoder().decode(plaintext)) as ShareableNote;
          receipt = shareableNoteToReceipt(note);
        } else {
          receipt = importNote(trimmed);
        }
        receipt.source = source;

        const exists = get().serializedNotes.some(
          (n) => n.commitment === receipt.commitment.toString(),
        );
        if (exists) {
          throw new Error('This note is already in your wallet.');
        }

        set((state) => ({
          serializedNotes: [...state.serializedNotes, serializeReceipt(receipt)],
        }));

        return receipt;
      },

      reset: () => set({ serializedNotes: [], counterByPool: {}, loading: false, error: null, _preparedUnshield: null }),

      setError: (error) => set({ error }),
    }),
    {
      name: 'p01-denominated-pool',
      storage: createJSONStorage(() => ({
        getItem: async (name: string) => {
          const result = await chrome.storage.local.get(name);
          return result[name] || null;
        },
        setItem: async (name: string, value: string) => {
          await chrome.storage.local.set({ [name]: value });
        },
        removeItem: async (name: string) => {
          await chrome.storage.local.remove(name);
        },
      })),
      partialize: (state) => ({
        serializedNotes: state.serializedNotes,
        counterByPool: state.counterByPool,
      }),
    },
  ),
);
