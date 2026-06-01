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
  findPoolV3,
  prepareShieldInsert,
  shieldV3,
} from '../services/denominatedPool';

import { useWalletStore, getPrivySigner } from './wallet';
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
  shieldNote: (params: {
    token: 'SOL' | 'USDC';
    denomination: number;
    onProgress?: (step: string) => void;
  }) => Promise<{ txSig: string; receipt: ShieldReceipt }>;
  reset: () => void;
  setError: (error: string | null) => void;
}

// ---------------------------------------------------------------------------
// WalletSigner factory (same pattern as subscriptionVault)
// ---------------------------------------------------------------------------

function createWalletSigner(): { signer: WalletSigner; connection: ReturnType<typeof getConnection> } {
  const walletState = useWalletStore.getState();
  const privySigner = getPrivySigner();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  const signer: WalletSigner = {
    publicKey: walletPublicKey,
    signTransaction: async (tx) => {
      if (walletState.isPrivyWallet && privySigner) {
        return (await privySigner(tx)) as unknown as typeof tx;
      } else if (keypair) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
        if (!tx.feePayer) tx.feePayer = walletPublicKey;
        tx.sign(keypair);
        return tx;
      }
      throw new Error('No signing method available');
    },
  };

  return { signer, connection };
}

/**
 * Derive walletSeed from the current wallet store.
 * Uses _keypair.secretKey.slice(0,32) for local wallets (mirrors mobile
 * denominatedPoolStore.ts:841). For Privy wallets the keypair is also set
 * after the note-seed ceremony — if null, throws an instructive error.
 */
function getWalletSeed(): Uint8Array {
  const walletState = useWalletStore.getState();
  const keypair = walletState._keypair;
  if (!keypair) {
    throw new Error(
      'Cannot derive wallet seed: no local keypair available. ' +
      'For Privy wallets, ensure the note-seed ceremony has completed.',
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

      reset: () => set({ serializedNotes: [], counterByPool: {}, loading: false, error: null }),

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
