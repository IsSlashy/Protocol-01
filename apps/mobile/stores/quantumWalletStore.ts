/**
 * Quantum Wallet Store
 *
 * Single source of truth for the user's post-quantum wallet state. Pairs
 * with `services/quantumWallet/*` for protocol logic. UI components read
 * `balance`, `pendingTransactions`, and call `initWallet` / `enqueueSend`.
 *
 * State is persisted to AsyncStorage so a cold boot can immediately render
 * the last known balance + reconcile pending sends.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Buffer } from 'buffer';

import { getConnection } from '../services/solana/connection';
import { getKeypair } from '../services/solana/wallet';
import {
  buildInitQuantumWalletIx,
  buildDepositIx,
  fetchQuantumWallet,
  feltStringToCommitment,
  commitmentToFeltString,
  getQuantumWalletPDA,
} from '../services/quantumWallet';
import {
  buildAndSubmitAuthProof,
  isAuthProofStillFresh,
  invalidateAuthProof,
  type AuthProofRecord,
  type ProverHandle,
} from '../services/quantumWallet/authProof';
import {
  autoDepositOnce,
  subscribeOwnerBalance,
} from '../services/quantumWallet/autoDeposit';
import { executeSend } from '../services/quantumWallet/sendExecutor';
import {
  reconcilePending,
  type PendingRecord,
} from '../services/quantumWallet/reconcile';

// ---------------------------------------------------------------------------
// SecureStore keys
// ---------------------------------------------------------------------------

const SECRET_KEY = 'p01_qw_secret_v1';
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainService: 'protocol-01-qw',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingSendStatus =
  | 'pending'
  | 'proving'
  | 'submitting'
  | 'confirmed'
  | 'failed';

export interface PendingSend {
  id: string;
  recipient: string; // base58
  amountLamports: number;
  expectedNonce: string; // bigint as string for persistence
  status: PendingSendStatus;
  error?: string;
  txSignature?: string;
  createdAt: number;
}

interface PersistedState {
  initialized: boolean;
  ownerIdB58: string | null;
  commitmentFelt: string | null; // Goldilocks u64 as decimal string
  recoveryPubkeyHex: string | null;
  balanceLamports: number;
  nonce: string; // bigint as string
  pendingSends: PendingSend[];
  /** Persisted as base58 — the cached `ProofBuffer` PDA. Re-validated on boot. */
  cachedProofBufferB58: string | null;
  cachedProofCommitmentFelt: string | null;
  cachedProofVerifiedAtSlot: number | null;
}

interface QuantumWalletState extends PersistedState {
  /** True while the FIFO send queue is draining. */
  isProcessing: boolean;
  /** Live Ed25519 balance (lamports) from the WS subscription. Not persisted. */
  ed25519BalanceLamports: number;
  /** Single sub handle so we can clean up on logout. */
  _ownerSubUnsub: (() => void) | null;

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Called once on app start. Loads on-chain state, reconciles pending. */
  hydrate: () => Promise<void>;

  /** Initialize the on-chain wallet. Generates a Goldilocks secret, stores it
   *  in SecureStore, computes Poseidon commitment, submits init_quantum_wallet. */
  initWallet: (args: {
    prover: ProverHandle;
    enableRecovery: boolean;
  }) => Promise<{ ownerIdB58: string; commitmentFelt: string }>;

  /** Fetch on-chain balance + nonce; update store. Cheap, idempotent. */
  refreshOnChainState: () => Promise<void>;

  /** Start the Ed25519 → quantum auto-deposit subscription. Safe to call
   *  multiple times — subsequent calls are no-ops if already subscribed. */
  startAutoDeposit: () => Promise<void>;
  stopAutoDeposit: () => void;

  /** Push a send onto the FIFO queue. Optimistically deducts balance. Returns
   *  the local id of the pending entry. */
  enqueueSend: (args: {
    prover: ProverHandle;
    recipient: PublicKey;
    amountLamports: number;
  }) => Promise<string>;

  /** Cancel a pending send if it hasn't started proving yet. Rolls back the
   *  optimistic balance. */
  cancelPending: (id: string) => void;

  /** Wipe the local wallet completely. Does NOT close the on-chain PDA
   *  (those funds become un-spendable unless the user keeps the secret). */
  wipeLocal: () => Promise<void>;

  /** Unified balance: on-chain quantum + Ed25519 in-flight. */
  unifiedBalance: () => number;

  /** @internal — exposed so persisted state hydration can call it; UI should
   *  use `enqueueSend` which fires it. */
  _drainQueue: (prover: ProverHandle) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a 64-bit Goldilocks-friendly secret. Goldilocks field modulus is
 *  2^64 - 2^32 + 1 ≈ 1.84e19. Drawing 8 bytes from CSPRNG and treating as a
 *  u64 has ~1-in-2^32 probability of overflowing the field — negligible. */
async function generateGoldilocksSecret(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(8);
  let u = BigInt(0);
  for (let i = 0; i < 8; i++) u |= BigInt(bytes[i]) << BigInt(8 * i);
  // Modulo the Goldilocks prime to stay in-field (avoids the 1-in-2^32 edge).
  const GOLDILOCKS = (BigInt(1) << BigInt(64)) - (BigInt(1) << BigInt(32)) + BigInt(1);
  u %= GOLDILOCKS;
  return u.toString();
}

async function loadSecret(): Promise<string | null> {
  return SecureStore.getItemAsync(SECRET_KEY, SECURE_OPTS);
}

async function saveSecret(secret: string): Promise<void> {
  await SecureStore.setItemAsync(SECRET_KEY, secret, SECURE_OPTS);
}

function makeId(): string {
  // 12 bytes of randomness — enough to avoid local collisions.
  const u = Math.random().toString(36).slice(2);
  const t = Date.now().toString(36);
  return `qw_${t}_${u}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const initialState: PersistedState = {
  initialized: false,
  ownerIdB58: null,
  commitmentFelt: null,
  recoveryPubkeyHex: null,
  balanceLamports: 0,
  nonce: '0',
  pendingSends: [],
  cachedProofBufferB58: null,
  cachedProofCommitmentFelt: null,
  cachedProofVerifiedAtSlot: null,
};

export const useQuantumWalletStore = create<QuantumWalletState>()(
  persist(
    (set, get) => ({
      ...initialState,
      isProcessing: false,
      ed25519BalanceLamports: 0,
      _ownerSubUnsub: null,

      hydrate: async () => {
        const state = get();
        if (!state.initialized || !state.ownerIdB58) return;
        const conn = getConnection();
        try {
          await state.refreshOnChainState();
        } catch (err: any) {
          console.warn('[QuantumWallet] hydrate refresh failed:', err.message);
        }
        // Reconcile any pending sends that may have landed (or timed out)
        // while the app was closed.
        if (state.pendingSends.length > 0) {
          const ownerId = new PublicKey(state.ownerIdB58);
          const records: PendingRecord[] = state.pendingSends.map((p) => ({
            id: p.id,
            expectedNonce: BigInt(p.expectedNonce),
            amountLamports: p.amountLamports,
            createdAt: p.createdAt,
            status: p.status,
          }));
          try {
            const outcome = await reconcilePending({
              connection: conn,
              ownerId,
              pending: records,
            });
            set((s) => ({
              pendingSends: s.pendingSends.flatMap((p) => {
                if (outcome.confirmed.includes(p.id)) {
                  return [{ ...p, status: 'confirmed' as const }];
                }
                const failure = outcome.failed.find((f) => f.id === p.id);
                if (failure) {
                  return [{ ...p, status: 'failed' as const, error: failure.reason }];
                }
                return [p];
              }),
            }));
          } catch (err: any) {
            console.warn('[QuantumWallet] reconcile failed:', err.message);
          }
        }
      },

      initWallet: async ({ prover, enableRecovery }) => {
        const existing = await loadSecret();
        if (existing && get().initialized) {
          throw new Error('Wallet already initialized — wipe local first to reinit.');
        }
        if (!prover.isReady) {
          throw new Error('STARK prover not ready yet — wait a moment.');
        }

        const secret = existing ?? (await generateGoldilocksSecret());
        if (!existing) await saveSecret(secret);

        // Derive commitment via Poseidon (computeCommitment runs in the WebView).
        const commitmentFelt = await prover.computeCommitment(secret);
        const commitmentBytes = feltStringToCommitment(commitmentFelt);

        // The Ed25519 keypair is the user's existing wallet — same identity
        // as walletStore. We use its pubkey as `owner_id` (PDA seed material,
        // NOT spending key).
        const kp = await getKeypair();
        if (!kp) throw new Error('Local Ed25519 keypair not found.');
        const ownerId = kp.publicKey;
        const [walletPda] = getQuantumWalletPDA(ownerId);

        // TODO[sphincs+]: when slh-dsa wiring lands, gen a SPHINCS+ keypair
        // here, persist private to SecureStore, send public on-chain. For now
        // we keep recovery_pubkey = None.
        const recoveryPubkey: Uint8Array | null = enableRecovery ? null : null;

        const conn = getConnection();
        const onChain = await fetchQuantumWallet(conn, ownerId);
        if (!onChain) {
          // Not initialized on-chain yet — submit init tx.
          const ix = buildInitQuantumWalletIx({
            payer: ownerId,
            ownerId,
            commitmentToSecret: commitmentBytes,
            recoveryPubkey,
          });
          const tx = new Transaction().add(ix);
          const { blockhash } = await conn.getLatestBlockhash('confirmed');
          tx.recentBlockhash = blockhash;
          tx.feePayer = ownerId;
          tx.partialSign(kp);
          const sig = await conn.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });
          await conn.confirmTransaction(sig, 'confirmed');
          console.log('[QuantumWallet] init tx confirmed:', sig);
        } else {
          console.log('[QuantumWallet] PDA already exists on-chain — reusing.');
        }

        set({
          initialized: true,
          ownerIdB58: ownerId.toBase58(),
          commitmentFelt,
          recoveryPubkeyHex: null,
          balanceLamports: onChain ? Number(onChain.balance) : 0,
          nonce: onChain ? onChain.nonce.toString() : '0',
        });

        return { ownerIdB58: ownerId.toBase58(), commitmentFelt };
      },

      refreshOnChainState: async () => {
        const state = get();
        if (!state.ownerIdB58) return;
        const conn = getConnection();
        const ownerId = new PublicKey(state.ownerIdB58);
        const w = await fetchQuantumWallet(conn, ownerId);
        if (!w) {
          set({ balanceLamports: 0, nonce: '0' });
          return;
        }
        set({
          balanceLamports: Number(w.balance),
          nonce: w.nonce.toString(),
          commitmentFelt: commitmentToFeltString(w.commitmentToSecret),
        });
      },

      startAutoDeposit: async () => {
        const state = get();
        if (!state.ownerIdB58 || state._ownerSubUnsub) return;
        const conn = getConnection();
        const ownerId = new PublicKey(state.ownerIdB58);

        // Initial probe — sweep any standing balance right away.
        try {
          const kp = await getKeypair();
          if (kp) {
            const res = await autoDepositOnce({ connection: conn, ownerKeypair: kp });
            if (res) {
              console.log(`[QuantumWallet] auto-deposit swept ${res.depositedLamports} lamports`);
              await get().refreshOnChainState();
            }
          }
        } catch (err: any) {
          console.warn('[QuantumWallet] initial auto-deposit failed:', err.message);
        }

        // Live subscription for future inflows.
        const unsub = subscribeOwnerBalance({
          connection: conn,
          ownerId,
          onChange: async (lamports) => {
            set({ ed25519BalanceLamports: lamports });
            try {
              const kp = await getKeypair();
              if (!kp) return;
              const res = await autoDepositOnce({ connection: conn, ownerKeypair: kp });
              if (res) {
                console.log(`[QuantumWallet] auto-deposit swept ${res.depositedLamports} lamports on change`);
                await get().refreshOnChainState();
              }
            } catch (err: any) {
              console.warn('[QuantumWallet] reactive auto-deposit failed:', err.message);
            }
          },
        });
        set({ _ownerSubUnsub: unsub });
      },

      stopAutoDeposit: () => {
        const unsub = get()._ownerSubUnsub;
        if (unsub) unsub();
        set({ _ownerSubUnsub: null });
      },

      enqueueSend: async ({ prover, recipient, amountLamports }) => {
        const state = get();
        if (!state.initialized || !state.ownerIdB58 || !state.commitmentFelt) {
          throw new Error('Quantum wallet is not initialized.');
        }
        if (amountLamports <= 0) throw new Error('Amount must be > 0.');
        if (amountLamports > state.balanceLamports) {
          throw new Error('Insufficient quantum balance.');
        }

        const id = makeId();
        const pendingCount = state.pendingSends.filter(
          (p) => p.status === 'pending' || p.status === 'proving' || p.status === 'submitting',
        ).length;
        const expectedNonce = (BigInt(state.nonce) + BigInt(pendingCount)).toString();

        // Optimistic deduct + enqueue.
        set((s) => ({
          pendingSends: [
            ...s.pendingSends,
            {
              id,
              recipient: recipient.toBase58(),
              amountLamports,
              expectedNonce,
              status: 'pending',
              createdAt: Date.now(),
            },
          ],
          balanceLamports: s.balanceLamports - amountLamports,
        }));

        // Fire-and-forget drain.
        void get()._drainQueue(prover);
        return id;
      },

      cancelPending: (id) => {
        set((s) => {
          const entry = s.pendingSends.find((p) => p.id === id);
          if (!entry || entry.status !== 'pending') return s;
          return {
            ...s,
            pendingSends: s.pendingSends.filter((p) => p.id !== id),
            balanceLamports: s.balanceLamports + entry.amountLamports,
          };
        });
      },

      wipeLocal: async () => {
        get().stopAutoDeposit();
        await SecureStore.deleteItemAsync(SECRET_KEY, SECURE_OPTS).catch(() => {});
        set({ ...initialState, isProcessing: false, ed25519BalanceLamports: 0, _ownerSubUnsub: null });
      },

      unifiedBalance: () => {
        const s = get();
        return s.balanceLamports + s.ed25519BalanceLamports;
      },

      _drainQueue: async (prover: ProverHandle) => {
        if (get().isProcessing) return;
        set({ isProcessing: true });
        try {
          while (true) {
            const next = get().pendingSends.find((p) => p.status === 'pending');
            if (!next) break;
            const conn = getConnection();
            const kp = await getKeypair();
            if (!kp) {
              set((s) => ({
                pendingSends: s.pendingSends.map((p) =>
                  p.id === next.id ? { ...p, status: 'failed', error: 'No keypair' } : p,
                ),
              }));
              continue;
            }

            // 1. Ensure auth proof is fresh.
            set((s) => ({
              pendingSends: s.pendingSends.map((p) =>
                p.id === next.id ? { ...p, status: 'proving' } : p,
              ),
            }));
            try {
              const state = get();
              const commitmentFelt = state.commitmentFelt!;
              let record: import('../services/quantumWallet/authProof').AuthProofRecord | null = null;
              if (state.cachedProofBufferB58 && state.cachedProofCommitmentFelt) {
                const cached = {
                  proofBuffer: new PublicKey(state.cachedProofBufferB58),
                  authority: kp.publicKey,
                  verifiedAtSlot: state.cachedProofVerifiedAtSlot ?? 0,
                  commitmentFelt: state.cachedProofCommitmentFelt,
                };
                const fresh = await isAuthProofStillFresh(conn, cached, commitmentFelt);
                if (fresh) record = cached;
              }
              if (!record) {
                const secret = await loadSecret();
                if (!secret) throw new Error('Quantum wallet secret missing.');
                record = await buildAndSubmitAuthProof({
                  prover,
                  secret,
                  walletSigner: {
                    publicKey: kp.publicKey,
                    signTransaction: async (tx) => {
                      tx.partialSign(kp);
                      return tx;
                    },
                  },
                  connection: conn,
                });
                set({
                  cachedProofBufferB58: record.proofBuffer.toBase58(),
                  cachedProofCommitmentFelt: record.commitmentFelt,
                  cachedProofVerifiedAtSlot: record.verifiedAtSlot,
                });
              }

              // 2. Build + submit withdraw.
              set((s) => ({
                pendingSends: s.pendingSends.map((p) =>
                  p.id === next.id ? { ...p, status: 'submitting' } : p,
                ),
              }));
              const recipient = new PublicKey(next.recipient);
              const sendRes = await executeSend({
                connection: conn,
                intent: {
                  id: next.id,
                  recipient,
                  amountLamports: next.amountLamports,
                },
                ownerKeypair: kp,
                authProof: record,
                expectedNonce: BigInt(next.expectedNonce),
              });

              // 3. Confirm.
              set((s) => ({
                pendingSends: s.pendingSends.map((p) =>
                  p.id === next.id
                    ? { ...p, status: 'confirmed', txSignature: sendRes.txSignature }
                    : p,
                ),
              }));
              // Auto-cleanup confirmed entries after 5s.
              setTimeout(() => {
                set((s) => ({
                  pendingSends: s.pendingSends.filter((p) => p.id !== next.id),
                }));
              }, 5000);

              await get().refreshOnChainState();
            } catch (err: any) {
              console.warn('[QuantumWallet] send failed:', err.message);
              set((s) => ({
                pendingSends: s.pendingSends.map((p) =>
                  p.id === next.id
                    ? { ...p, status: 'failed', error: err.message ?? 'unknown error' }
                    : p,
                ),
                balanceLamports: s.balanceLamports + next.amountLamports,
              }));
            }
          }
        } finally {
          set({ isProcessing: false });
        }
      },
    }) as any,
    {
      name: 'p01_quantum_wallet_v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) =>
        ({
          initialized: s.initialized,
          ownerIdB58: s.ownerIdB58,
          commitmentFelt: s.commitmentFelt,
          recoveryPubkeyHex: s.recoveryPubkeyHex,
          balanceLamports: s.balanceLamports,
          nonce: s.nonce,
          pendingSends: s.pendingSends,
          cachedProofBufferB58: s.cachedProofBufferB58,
          cachedProofCommitmentFelt: s.cachedProofCommitmentFelt,
          cachedProofVerifiedAtSlot: s.cachedProofVerifiedAtSlot,
        }) as PersistedState,
    },
  ),
);

/** Pre-prove helper: kick off an auth proof in the background at app boot so
 *  the user's first send is instant. No-op if a fresh proof is already cached. */
export async function preProveQuantumAuth(prover: ProverHandle): Promise<void> {
  const state = useQuantumWalletStore.getState();
  if (!state.initialized || !state.ownerIdB58 || !state.commitmentFelt) return;
  if (!prover.isReady) return;
  const conn = getConnection();
  const kp = await getKeypair();
  if (!kp) return;
  if (state.cachedProofBufferB58) {
    const cached = {
      proofBuffer: new PublicKey(state.cachedProofBufferB58),
      authority: kp.publicKey,
      verifiedAtSlot: state.cachedProofVerifiedAtSlot ?? 0,
      commitmentFelt: state.cachedProofCommitmentFelt ?? '',
    };
    const fresh = await isAuthProofStillFresh(conn, cached, state.commitmentFelt);
    if (fresh) return; // Already have a usable proof.
  }
  const secret = await loadSecret();
  if (!secret) return;
  try {
    const record = await buildAndSubmitAuthProof({
      prover,
      secret,
      walletSigner: {
        publicKey: kp.publicKey,
        signTransaction: async (tx) => {
          tx.partialSign(kp);
          return tx;
        },
      },
      connection: conn,
    });
    useQuantumWalletStore.setState({
      cachedProofBufferB58: record.proofBuffer.toBase58(),
      cachedProofCommitmentFelt: record.commitmentFelt,
      cachedProofVerifiedAtSlot: record.verifiedAtSlot,
    });
    console.log('[QuantumWallet] pre-proving complete — first send will be instant.');
  } catch (err: any) {
    console.warn('[QuantumWallet] pre-proving failed:', err.message);
  }
}
