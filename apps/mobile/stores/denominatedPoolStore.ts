import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { PublicKey, Keypair as SolKeypair, SystemProgram, Transaction, sendAndConfirmTransaction, type Connection } from '@solana/web3.js';
// NOTE: sha256/hmac used to be imported here to build ephemeral signers out of
// PUBLIC values. That derivation moved to `services/privacy/ephemeralSigner.ts`
// and is now keyed on the wallet's secret seed; nothing in this file hashes
// anything any more, so the imports are gone on purpose. Re-adding them to
// derive a key from an address would reintroduce the bug.
import { vaultEncrypt, vaultDecrypt, isVaultUnlocked } from '../utils/crypto/noteVault';
import { getConnection, getCluster } from '../services/solana/connection';
import { getKeypair, deriveLocalNoteSeed } from '../services/solana/wallet';
import {
  type PoolConfig,
  type ShieldReceipt,
  type PoolOnChainInfo,
  type WalletSigner,
  type ShareableNote,
  ALL_POOLS,
  SOL_POOLS,
  USDC_POOLS,
  ALL_POOLS_V3,
  fetchPoolInfo,
  shield,
  shieldV3,
  unshieldStark,
  unshieldDenominatedStarkV3,
  prepareUnshieldV4,
  unshieldDenominatedStarkV4,
  whyCircuit7Cannot,
  V4Unprovable,
  type PrepareUnshieldV4Result,
  type SpendProver,
  transferNoteStark as serviceTransferNoteStark,
  transferDenominatedStarkV3 as serviceTransferDenominatedStarkV3,
  splitNoteStark as serviceSplitNoteStark,
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
import { useWalletStore } from './walletStore';
import { rescanPoolFromSeed, rescanPoolFromSeedV3, fetchPoolCommitments, deriveNoteMaterial } from '../services/denominatedPool';
import {
  deriveStealthSigners,
  sweepLegacyStealth,
} from '../services/privacy/ephemeralSigner';
import {
  computeShieldPrefundLamports,
  deriveShieldEphemeral,
  resumeShieldPrefund,
  sweepShieldEphemeral,
} from '../services/privacy/shieldEphemeral';
import {
  buildPendingStealthSweep,
  executeStealthSweep,
  type PendingStealthSweep,
} from '../services/privacy/stealthSweep';

/**
 * Walk the counter forward until we find one whose derived nullifier PDAs
 * (both Groth16 and STARK forms) are NOT already on-chain. Protects against
 * shieldCounters being wiped (encrypted storage decrypt failure, wallet
 * switch, fresh install) which would otherwise re-use a counter that was
 * previously spent — producing a fresh commitment but a colliding nullifier
 * that would reject any future spend of the new note via `init` constraint.
 *
 * Returns the first safe counter. Throws if no free counter is found within
 * `maxAttempts`.
 */
export async function findSafeShieldCounter(
  connection: Connection,
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  startCounter: number,
  maxAttempts = 1024,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = startCounter + i;
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolPDA, candidate);
    const g16Null = createNullifier(nullifierPreimage, secret);
    const [g16Pda] = deriveNullifierPDA(poolPDA, bigintToLeBytes32(g16Null));
    const starkNull = computeGoldilocksPoolNullifier(nullifierPreimage, secret);
    const [starkPda] = deriveNullifierPDA(poolPDA, goldilocksNullifierToBytes(starkNull));
    const accs = await connection.getMultipleAccountsInfo([g16Pda, starkPda]);
    if (!accs[0] && !accs[1]) {
      if (i > 0) {
        console.warn(
          `[findSafeShieldCounter] counter rewound — start=${startCounter}, safe=${candidate} ` +
            `(skipped ${i} collided counters on pool ${poolPDA.toBase58().slice(0, 8)})`,
        );
      }
      return candidate;
    }
  }
  throw new Error(
    `No free counter found after ${maxAttempts} attempts starting from ${startCounter} on pool ${poolPDA.toBase58()}`,
  );
}
import { scheduleLocalNotification } from '../services/notifications';
import { getMetaAddress } from '../services/stealth/keys';
// NOTE: `getOrCreateStealthKeys` / `scanStealthPayment` are no longer imported
// here. Rebuilding a stealth recipient's key now happens in
// `services/privacy/stealthSweep.ts`, against a PERSISTED record, so it works
// on a later run instead of only inside the function that generated it.
import { generateStealthAddress as genStealth, parseMetaAddress } from '../utils/crypto/stealth';
import {
  computeGoldilocksPoolNullifier,
  goldilocksNullifierToBytes,
} from '../services/zk/goldilocks-poseidon';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoteStatus = 'pending' | 'mature' | 'spent' | 'transferred' | 'imported' | 'locked';

/**
 * What `prepareUnshieldNoteV4` hands back and `unshieldNoteStarkV4` consumes:
 * the circuit-7 proof, and the stealth material for the recipient that proof
 * is bound to. Opaque to the screens on purpose — the only thing they do with
 * it is pass it from one action to the other.
 */
export interface PreparedNoteSpendV4 {
  noteId: string;
  prepared: PrepareUnshieldV4Result;
  /** Sender-side stealth material; persisted as the sweep claim before upload. */
  stealth: ReturnType<typeof genStealth>;
  /** `stealth.address`, base58 — the payee inside the proof transcript. */
  stealthRecipient: string;
}
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
  cluster?: 'devnet' | 'mainnet-beta' | 'testnet'; // network where note was created
  spentTxSig?: string;
  transferredTo?: string; // encoded shareable note (for re-display)
  /**
   * Pubkey (base58) of the wallet that created this note. Used to hide notes
   * belonging to other identities when a different user connects on the same
   * device — they'd never be able to spend them (different seed ⇒ different
   * secrets) but the UI should not display them either.
   */
  ownerPubkey?: string;
  /** Set when this note was reconstructed by `rescanPool` rather than freshly shielded. */
  recoveredAt?: number;
  /**
   * V3 marker. Optional — legacy notes (pre-v3) leave this undefined and route
   * through the v2 STARK paths. New notes shielded into a `pool.version === 'v3'`
   * pool stamp this as `'v3'` and route through the V3 (Goldilocks) STARK paths.
   * See `v3-stark-migration-plan-2026-05-02.md`.
   */
  poolVersion?: 'v2' | 'v3';
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
  /**
   * Per-pool monotonic counter feeding deterministic note derivation. Persisted
   * so normal use keeps counters unique; if it is wiped (uninstall), seed-based
   * rescan can reconstruct any surviving notes by iterating 0..N.
   */
  shieldCounters: Record<string, number>;
  /**
   * Stealth withdrawals whose money is still sitting on the one-time recipient.
   *
   * PERSISTED, and it has to be: the recipient's private key is derived from a
   * RANDOM X25519 ephemeral generated at withdrawal time
   * (`utils/crypto/stealth.ts:generateStealthAddress`), and that ephemeral is
   * not published on chain. Before this list existed the only copy lived in a
   * local variable, so killing the app between the withdrawal landing and the
   * sweep confirming destroyed the key to the whole denomination. See
   * `services/privacy/stealthSweep.ts` for the measured case.
   */
  pendingStealthSweeps: PendingStealthSweep[];

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
  /** Lock a note — prevents withdrawal while in an active privacy route */
  lockNote: (noteId: string) => void;
  /**
   * Hide a local note from the UI by marking it `spent` even though it's
   * still live on-chain. Use only when a note is known-unrecoverable (e.g.
   * pre-hardening pool with gaps in the event history that make Merkle
   * rebuild impossible). The on-chain funds remain trapped in the pool —
   * this is a UI-only cleanup.
   */
  abandonNote: (noteId: string) => void;
  setSelectedToken: (token: TokenFilter) => void;
  setSelectedDenomination: (denom: number | null) => void;
  shieldNote: (pool: PoolConfig) => Promise<string>;
  /**
   * V3 (Goldilocks STARK) shield — accepts a pre-generated C6 (merkle_update)
   * proof from the StarkProver context. Caller (screen) is responsible for:
   *   1. Computing insertParams (commitment + new_root + new_subtrees) from
   *      on-chain pool state via `prepareShieldV3Insert` exported here.
   *   2. Generating the C6 STARK proof via `useStarkProver().generateMerkleUpdateProof`.
   *   3. Passing both into this action.
   *
   * Side-by-side with v2 `shieldNote` — pool routing is the screen's job
   * (`pool.version === 'v3'`). Stamps `poolVersion: 'v3'` on the StoredNote.
   */
  shieldNoteV3: (
    pool: PoolConfig,
    insertParams: {
      commitment: bigint;
      newRoot: bigint;
      newSubtrees: bigint[];
      secret: bigint;
      nullifierPreimage: bigint;
      depositEpoch: bigint;
      leafIndex: number;
      /** Counter chosen via findSafeShieldCounter — store advances
       * `shieldCounters[poolKey] = counter + 1` after successful shield to
       * avoid v3-counter nullifier collisions on the next shield. */
      counter: number;
    },
    c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  ) => Promise<string>;
  /**
   * Quantum-resistant STARK unshield. Pass `emergency=true` to bypass the
   * client-side maturity check. It changes no instruction byte: min_epoch is
   * always UNSHIELD_MIN_EPOCH (0) — see services/denominatedPool/index.ts. The
   * on-chain ix, account layout, and emitted event are identical for both
   * paths, so an observer cannot distinguish emergency from classic. Privacy
   * posture (ephemeral signer + ECDH stealth recipient + random sweep) is
   * uniform across both.
   */
  unshieldNoteStark: (
    noteId: string,
    recipient: string,
    starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    emergency?: boolean,
  ) => Promise<string>;
  /**
   * V3 STARK unshield — 3-tx orchestration (C1 + C3 + unshield_v3).
   * Caller (screen) generates BOTH C1 (pool_commitment) and C3 (merkle_path)
   * proofs sequentially via the StarkProver context (it's single-threaded —
   * never parallel) and passes them in. Stealth signer + recipient pattern
   * mirrors v2 `unshieldNoteStark`.
   *
   * Side-by-side with v2 — screen routes via `note.poolVersion === 'v3'`.
   * `emergency` flag is accepted for symmetry but currently unused: min_epoch
   * is always UNSHIELD_MIN_EPOCH (0) and the V3 handler ignores it
   * (unshield_denominated_stark_v3.rs:387), so maturity is a UX-only gate.
   */
  unshieldNoteStarkV3: (
    noteId: string,
    recipient: string,
    c1ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    c3ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    /**
     * [C3-D12] The Merkle levels ABOVE the depth-12 C3 circuit, plus the pool
     * root the screen's own tree walk produced.
     *
     * ⛔ REQUIRED. Since 2026-08-29 a C3 proof attests membership in a
     * twelve-level SUBTREE only; the instruction walks the rest on chain. And
     * `merkleRoot` is NOT `c3ProofData.publicInputs[1]` — that is the subtree
     * root now, and passing it as the pool root names a root no pool ever
     * published.
     */
    walk: { merkleRoot: bigint; siblings: bigint[]; directions: number[] },
    emergency?: boolean,
  ) => Promise<string>;
  /**
   * V4 (circuit 7) withdrawal, step 1 of 2: derive the ECDH stealth recipient
   * and generate the ONE spend proof bound to it. Nothing is funded and nothing
   * is uploaded; a `V4Unprovable` from here reaches the screen untouched so
   * `routeUnshieldSpend` can fall back to the C1 + C3 pair.
   *
   * Two actions rather than one because circuit 7 binds sha256(recipient) into
   * its transcript and the recipient on this surface is a stealth address the
   * STORE derives — so the store must derive first and prove second, and the
   * screen must be able to see the prepare fail before any lamport moves.
   *
   * `prove` is `generateSpendProof` from `useStarkProver()`; the hook cannot be
   * reached from here.
   */
  prepareUnshieldNoteV4: (
    noteId: string,
    prove: SpendProver,
    onProgress?: (step: string) => void,
  ) => Promise<PreparedNoteSpendV4>;
  /**
   * V4 (circuit 7) withdrawal, step 2 of 2: stealth signer, pre-fund, jitter,
   * persisted sweep claim, upload + `unshield_denominated_stark_v4`, mark spent,
   * delayed sweep, crash-sweep on error — the v3 action's flow with ONE proof
   * buffer instead of two and no `stark_commitment` on the wire.
   *
   * ⛔ MAY NOT FALL BACK. By the time this throws, a proof may be uploaded and
   * the nullifier PDA initialised; a v3 retry would pay rent twice and die on
   * the double-spend guard with the note already spent. `emergency` is not
   * taken: v4 has no min_epoch field.
   */
  unshieldNoteStarkV4: (
    noteId: string,
    recipient: string,
    spend: PreparedNoteSpendV4,
  ) => Promise<string>;
  /** Quantum-resistant STARK peer-to-peer transfer */
  transferNoteStark: (
    noteId: string,
    starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  ) => Promise<{ txSig: string; shareableNote: string }>;
  /**
   * V3 STARK transfer — 4-tx orchestration (C1 + C3 + C6 + transfer_v3).
   * Caller (screen) generates the three proofs sequentially via StarkProver
   * (single-threaded) and pre-computes the new note material + insertion
   * deltas. Stealth signer + per-note deterministic seed mirror the v2
   * `transferNoteStark` privacy posture.
   */
  transferNoteStarkV3: (
    noteId: string,
    c1ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    c3ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    c6ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    insertParams: {
      newCommitment: bigint;
      newRoot: bigint;
      newSubtrees: bigint[];     // depth entries (levels 1..=depth)
      newSecret: bigint;
      newNullifierPreimage: bigint;
      newDepositEpoch: bigint;
      newLeafIndex: number;
    },
    /**
     * [C3-D12] The Merkle levels ABOVE the depth-12 C3 circuit, plus the pool
     * root the screen's own tree walk produced.
     *
     * ⛔ REQUIRED. Since 2026-08-29 a C3 proof attests membership in a
     * twelve-level SUBTREE only; the instruction walks the rest on chain. And
     * `merkleRoot` is NOT `c3ProofData.publicInputs[1]` — that is the subtree
     * root now, and passing it as the pool root names a root no pool ever
     * published.
     */
    walk: { merkleRoot: bigint; siblings: bigint[]; directions: number[] },
  ) => Promise<{ txSig: string; shareableNote: string }>;
  /** Quantum-resistant STARK split across denominations (same token).
   * Requires TWO proofs: C1 (pool_commitment) + C3 (merkle_path) — the latter
   * is a hardening requirement added on-chain (split_note_stark now proves the
   * source note's membership, mirroring unshield/subscribe). */
  splitNoteStark: (
    noteId: string,
    targetPoolPDA: string,
    outputSecrets: bigint[],
    starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    c3ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    /**
     * [C3-D12] The Merkle levels ABOVE the depth-12 C3 circuit, plus the pool
     * root the screen's own tree walk produced.
     *
     * ⛔ REQUIRED. Since 2026-08-29 a C3 proof attests membership in a
     * twelve-level SUBTREE only; the instruction walks the rest on chain. And
     * `merkleRoot` is NOT `c3ProofData.publicInputs[1]` — that is the subtree
     * root now, and passing it as the pool root names a root no pool ever
     * published.
     */
    walk: { merkleRoot: bigint; siblings: bigint[]; directions: number[] },
  ) => Promise<{ txSignature: string; outputCommitments: bigint[] }>;
  /**
   * Import fresh notes re-shielded during subscription cancellation. Takes
   * already-computed receipts (secrets + nullifier preimages + commitments)
   * and the pool they landed in; constructs StoredNote entries matching the
   * same shape used by `splitNoteStark` so the UI surfaces them immediately.
   */
  addReshieldedNotes: (receipts: ShieldReceipt[], pool: PoolConfig) => void;
  importNote: (encodedNote: string, source?: NoteSource) => void;
  exportAllNotes: () => string[];
  exportNote: (noteId: string) => string;
  getFilteredPools: () => PoolConfig[];
  getNotesForPool: (poolPDA: string) => StoredNote[];
  getActiveNotes: () => StoredNote[];
  recoverTransferredNotes: () => number;
  /**
   * Reconstruct shielded notes for one pool (or every pool when `poolPDA` is
   * omitted) by deriving candidate (secret, nullifier) pairs from the wallet
   * seed and matching them against on-chain ShieldDenominatedEvents. Notes
   * that are already in the store are left untouched. Returns the number of
   * recovered notes.
   */
  rescanPool: (poolPDA?: string, opts?: { maxCounter?: number; epochsBack?: number; maxSignatures?: number }) => Promise<number>;
  /**
   * Move one stealth withdrawal's funds off the one-time recipient.
   *
   * `destinationOverride` exists because sweeping straight back to the wallet
   * that funded the deposit is the one destination that makes the hop
   * pointless. The store does not choose for the user; it defaults to whatever
   * address the withdrawal named and lets a caller pick another.
   *
   * Returns lamports moved (0 if the address was already empty). The record is
   * dropped only once the sweep settles, so a failure stays retryable instead
   * of losing the key.
   */
  sweepStealthRecipient: (noteId: string, destinationOverride?: string) => Promise<number>;
  /** Retry every unsettled stealth sweep. Safe to call on app resume. */
  retryPendingStealthSweeps: () => Promise<number>;
  /** Force-clear a stuck operation (isLoading/progress/isProving/_starkOpInFlight). Use when a shield/unshield promise was interrupted and the guard refuses new ops. */
  resetOperationState: () => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Encrypted storage adapter (H1 — note secrets must not sit in AsyncStorage plaintext)
// ---------------------------------------------------------------------------

let _noteEncryptionKey: Uint8Array | null = null;

let _starkOpInFlight = false;

async function getNoteEncryptionKey(): Promise<Uint8Array> {
  if (_noteEncryptionKey) return _noteEncryptionKey;
  const existing = await SecureStore.getItemAsync('p01_note_encryption_key');
  if (existing) {
    _noteEncryptionKey = new Uint8Array(Buffer.from(existing, 'base64'));
    return _noteEncryptionKey;
  }
  const key = nacl.randomBytes(32);
  await SecureStore.setItemAsync('p01_note_encryption_key', Buffer.from(key).toString('base64'));
  _noteEncryptionKey = key;
  return key;
}

function encryptData(data: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(new TextEncoder().encode(data), nonce, key);
  if (!encrypted) throw new Error('Encryption failed');
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return Buffer.from(combined).toString('base64');
}

function decryptData(encrypted: string, key: Uint8Array): string {
  const data = new Uint8Array(Buffer.from(encrypted, 'base64'));
  const nonce = data.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = data.slice(nacl.secretbox.nonceLength);
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) throw new Error('Decryption failed');
  return new TextDecoder().decode(decrypted);
}

/** AsyncStorage wrapper that encrypts values at rest using nacl.secretbox */
const encryptedStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const raw = await AsyncStorage.getItem(name);
    if (!raw) return null;
    try {
      const key = await getNoteEncryptionKey();
      return decryptData(raw, key);
    } catch (err) {
      // Migration path (v0 → v1): data may be plaintext JSON if produced
      // before the encryption layer existed. Sniff for a leading `{`.
      if (raw.startsWith('{')) return raw;
      // Encrypted blob but the key rotated (fresh install / SecureStore wipe) —
      // returning `raw` would hand zustand garbage bytes, silently parse as
      // empty, and wipe critical state (shieldCounters → nullifier collisions
      // on next shield). Return null so persist re-inits with defaults; the
      // user can recover notes from seed via rescanPool.
      console.warn(`[encryptedStorage] decrypt failed for ${name} — returning null to avoid corrupted state:`, (err as Error).message);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    const key = await getNoteEncryptionKey();
    const encrypted = encryptData(value, key);
    await AsyncStorage.setItem(name, encrypted);
  },
  removeItem: async (name: string): Promise<void> => {
    await AsyncStorage.removeItem(name);
  },
};

// ---------------------------------------------------------------------------
// Wallet-scoped note archival (prevents note loss on wallet switch)
// ---------------------------------------------------------------------------

const ARCHIVE_PREFIX = 'p01_notes_archive_';

/**
 * Archive current notes for a specific wallet address before switching.
 * Notes are encrypted and saved under a wallet-specific key.
 */
export async function archiveNotesForWallet(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  const { notes } = useDenominatedPoolStore.getState();
  if (notes.length === 0) return;
  try {
    const key = await getNoteEncryptionKey();
    const data = JSON.stringify(notes);
    const encrypted = encryptData(data, key);
    await AsyncStorage.setItem(`${ARCHIVE_PREFIX}${walletAddress}`, encrypted);
    console.log(`[DenomStore] Archived ${notes.length} notes for wallet ${walletAddress.slice(0, 8)}...`);
  } catch (err) {
    console.error('[DenomStore] Failed to archive notes:', (err as Error).message);
  }
}

/**
 * Restore archived notes for a wallet address after switching back.
 * Merges with any existing notes (deduplicates by id).
 */
export async function restoreNotesForWallet(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  try {
    const raw = await AsyncStorage.getItem(`${ARCHIVE_PREFIX}${walletAddress}`);
    if (!raw) return;
    const key = await getNoteEncryptionKey();
    let decrypted: string;
    try {
      decrypted = decryptData(raw, key);
    } catch {
      // May be unencrypted legacy data
      decrypted = raw;
    }
    const archived: StoredNote[] = JSON.parse(decrypted);
    if (!Array.isArray(archived) || archived.length === 0) return;

    const { notes: currentNotes } = useDenominatedPoolStore.getState();
    const existingIds = new Set(currentNotes.map(n => n.id));
    const newNotes = archived.filter(n => !existingIds.has(n.id));

    if (newNotes.length > 0) {
      useDenominatedPoolStore.setState({ notes: [...currentNotes, ...newNotes] });
      console.log(`[DenomStore] Restored ${newNotes.length} notes for wallet ${walletAddress.slice(0, 8)}...`);
    }
  } catch (err) {
    console.error('[DenomStore] Failed to restore notes:', (err as Error).message);
  }
}

const POOL_CACHE_TTL = 30_000; // 30s

// NOTE(Privy-removal, spec §3 Phase 1): `getWalletSignerIfPrivy()` is gone. There
// is no external/Privy signer path anymore — every wallet is a local Ed25519
// keypair. Former call sites now resolve `walletSigner` to `undefined`, so each
// `walletSigner ? <privy> : <keypair>` ternary deterministically takes the local
// keypair branch. The external (software-wallet) signer path returns in Phase 3.

function noteIdFromReceipt(receipt: ShieldReceipt): string {
  return receipt.commitment.toString(16).slice(0, 16);
}

/** Encrypt receipt before storing — adds vault layer if PIN is set. */
function secureReceipt(receipt: ShieldReceipt): string {
  const json = receiptToJSON(receipt);
  return isVaultUnlocked() ? vaultEncrypt(json) : json;
}

/** Decrypt receipt before using — unwraps vault layer if present. */
function readReceipt(storedReceipt: string): ShieldReceipt {
  const json = vaultDecrypt(storedReceipt); // no-op if not vault-encrypted
  return receiptFromJSON(json);
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
      shieldCounters: {},
      pendingStealthSweeps: [],
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
        // Both v2 and V3 pool generations participate in the cache: V3 pools
        // are real on-chain accounts whose `epoch_delay` + `dynamic_delay`
        // feed `refreshNoteStatuses` for V3 imported notes. Excluding V3 here
        // would force the maturity check to fall back to default delays.
        const allPoolsCombined = [...ALL_POOLS, ...ALL_POOLS_V3];
        const pools = poolPDA
          ? allPoolsCombined.filter(p => p.poolPDA.toBase58() === poolPDA)
          : allPoolsCombined;

        const cache = { ...get().poolCache };
        const now = Date.now();

        // Fire all pool fetches in parallel — a serial for/await with N≈9
        // pools over devnet (≈1s each, worse with 429s) blocked the JS thread
        // ~10s and made every tap on this screen unresponsive. Promise.all
        // keeps the screen interactive and the cache populates ~N× faster.
        const stale = pools.filter(pool => {
          const cached = cache[pool.poolPDA.toBase58()];
          return !cached || now - cached.fetchedAt >= POOL_CACHE_TTL;
        });

        const results = await Promise.allSettled(
          stale.map(pool => fetchPoolInfo(connection, pool)),
        );

        let changed = false;
        results.forEach((res, i) => {
          if (res.status === 'fulfilled' && res.value) {
            cache[stale[i]!.poolPDA.toBase58()] = {
              info: serializablePoolInfo(res.value),
              fetchedAt: Date.now(),
            };
            changed = true;
          }
        });

        if (changed) set({ poolCache: cache });
      },

      refreshAllPools: async () => {
        // CRITICAL: do NOT touch `isLoading` if a STARK op is currently in
        // flight. The unshield/transfer/subscribe flows raise `isLoading`
        // for the duration of their multi-batch proof submission, and our
        // own `set({ isLoading: false })` at the end of the refresh would
        // race with that flow and leave the UI without a loader for the
        // remainder of the proof upload — even though the actual STARK op
        // is still running. Skip toggling the flag in that case; the
        // refresh itself is fast enough that no spinner is needed.
        const starkInFlight = _starkOpInFlight;
        if (starkInFlight) {
          console.log(
            `[P01_UI] ${JSON.stringify({
              ts: new Date().toISOString(),
              event: 'refreshAllPools-during-stark',
              note: 'skipping isLoading toggle to preserve in-flight STARK loader',
            })}`,
          );
        } else {
          set({ isLoading: true, error: null });
        }
        try {
          await get().refreshPoolInfo();
          await get().refreshNoteStatuses();
          if (!starkInFlight) set({ isLoading: false });
        } catch (err) {
          console.error('[DenomPool] refreshAllPools error:', err);
          if (!starkInFlight) {
            set({ isLoading: false, error: (err as Error).message });
          } else {
            // STARK flow is still running and owns isLoading; just stash the
            // error without flipping the flag.
            set({ error: (err as Error).message });
          }
        }
      },

      // ------------------------------------------------------------------
      // Note status (mature / pending)
      // ------------------------------------------------------------------

      refreshNoteStatuses: async () => {
        const { notes } = get();
        if (__DEV__) {
          console.log(`[refreshNoteStatuses] entry — ${notes.length} notes in store:`,
            notes.slice(0, 5).map(n => ({
              id: n.id,
              status: n.status,
              denom: n.denomination,
              owner: n.ownerPubkey?.slice(0, 8) ?? 'none',
              cluster: n.cluster,
            })),
          );
        }
        if (notes.length === 0) return;

        try {
          const connection = getConnection();
          const slot = await connection.getSlot('confirmed');
          const currentEpoch = slotToEpoch(slot);

          // Check nullifier PDAs on-chain for non-terminal notes (current cluster only).
          // A note can be spent via two paths that write DIFFERENT PDAs:
          //   - Groth16 unshield / transfer: Poseidon(np, sec) → 32-byte BN254 → PDA
          //   - STARK unshield / subscribe:  Goldilocks Poseidon(np_u64, sec_u64) →
          //                                  8-byte LE + 24 zeros → PDA
          // The scanner MUST probe both — checking only the Groth16 PDA leaves
          // STARK-spent notes marked "mature", causing the next STARK spend to
          // fail with `already in use` after a 60s proof run.
          const cluster = getCluster();
          const activeNotes = notes.filter(n =>
            n.status !== 'spent' && n.status !== 'transferred' && n.status !== 'locked' &&
            (n.cluster ?? 'devnet') === cluster
          );
          const nullifierPDAs: { noteId: string; pda: PublicKey }[] = [];

          const nullifierMeta: { noteId: string; kind: 'g16' | 'stark'; pda: string }[] = [];
          for (const note of activeNotes) {
            try {
              const receipt = readReceipt(note.receiptJSON);
              const poolKey = new PublicKey(note.poolPDA);

              // Groth16 / Poseidon PDA (BN254 form)
              const g16Null = createNullifier(receipt.nullifierPreimage, receipt.secret);
              const [g16Pda] = deriveNullifierPDA(poolKey, bigintToLeBytes32(g16Null));
              nullifierPDAs.push({ noteId: note.id, pda: g16Pda });
              nullifierMeta.push({ noteId: note.id, kind: 'g16', pda: g16Pda.toBase58() });

              // STARK / Goldilocks PDA (u64 in bytes[0..8], zero tail)
              const starkNull = computeGoldilocksPoolNullifier(
                receipt.nullifierPreimage,
                receipt.secret,
              );
              const [starkPda] = deriveNullifierPDA(poolKey, goldilocksNullifierToBytes(starkNull));
              nullifierPDAs.push({ noteId: note.id, pda: starkPda });
              nullifierMeta.push({ noteId: note.id, kind: 'stark', pda: starkPda.toBase58() });
            } catch (err) {
              if (__DEV__) console.warn(`[refreshNoteStatuses] skip invalid receipt ${note.id}:`, (err as Error).message);
            }
          }

          if (__DEV__) console.log(`[refreshNoteStatuses] checking ${nullifierPDAs.length} nullifier PDAs for ${activeNotes.length} active notes`);

          // Batch fetch nullifier accounts
          const spentNoteIds = new Set<string>();
          if (nullifierPDAs.length > 0) {
            const accounts = await connection.getMultipleAccountsInfo(
              nullifierPDAs.map(n => n.pda)
            );
            for (let i = 0; i < accounts.length; i++) {
              if (accounts[i] !== null) {
                spentNoteIds.add(nullifierPDAs[i].noteId);
                if (__DEV__) {
                  const meta = nullifierMeta[i];
                  console.log(
                    `[refreshNoteStatuses] SPENT noteId=${meta.noteId} kind=${meta.kind} pda=${meta.pda} ` +
                      `owner=${accounts[i]?.owner.toBase58() ?? 'null'} lamports=${accounts[i]?.lamports ?? 0}`,
                  );
                }
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

            const receipt = readReceipt(note.receiptJSON);
            // Lookup must include V3 pools — without this, a V3 imported note
            // (e.g. received via transfer) returns early here and stays stuck
            // at status='imported' forever instead of transitioning to 'mature'.
            const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA)
              ?? ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
            if (!pool) return note;

            const cached = get().poolCache[note.poolPDA];
            const epochDelay = cached?.info.epochDelay ?? 1n;
            const dynamicDelay = BigInt(cached?.info.dynamicDelay ?? 2);
            const totalDelay = epochDelay + dynamicDelay;

            const minEpoch = currentEpoch - totalDelay;
            const isMature = receipt.depositEpoch <= minEpoch;

            // Preserve locked/spent/transferred — only update pending/mature/imported
            if ((note.status as string) === 'locked' || (note.status as string) === 'spent' || (note.status as string) === 'transferred') {
              return note;
            }
            const newStatus: NoteStatus = isMature ? 'mature' : (note.status === 'imported' ? 'imported' : 'pending');
            return { ...note, status: newStatus };
          });

          set({ notes: updated });
        } catch (err) {
          // refreshNoteStatuses error — non-fatal
        }
      },

      lockNote: (noteId: string) => {
        const notes = get().notes.map(n =>
          n.id === noteId ? { ...n, status: 'locked' as NoteStatus } : n
        );
        set({ notes });
        console.log(`[DenomPool] Note ${noteId.slice(0, 8)}... LOCKED`);
      },

      abandonNote: (noteId: string) => {
        const notes = get().notes.map(n =>
          n.id === noteId ? { ...n, status: 'spent' as NoteStatus } : n
        );
        set({ notes });
        console.log(`[DenomPool] Note ${noteId.slice(0, 8)}... ABANDONED (hidden from UI; still on-chain)`);
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
        const cluster = getCluster();
        return get().notes.filter(n =>
          n.status !== 'spent' && n.status !== 'transferred' &&
          // Only show notes from the current network (legacy notes without cluster default to devnet)
          (n.cluster ?? 'devnet') === cluster
        );
      },

      recoverTransferredNotes: () => {
        // Recover notes that were marked 'transferred' due to a failed NFC/BLE
        // transfer (the receiver never got the data, so the note is still ours).
        // Only recovers notes that have NO spentTxSig (not spent on-chain).
        const notes = get().notes;
        const recoverable = notes.filter(
          n => n.status === 'transferred' && !n.spentTxSig,
        );
        if (recoverable.length === 0) return 0;
        set({
          notes: notes.map(n =>
            n.status === 'transferred' && !n.spentTxSig
              ? { ...n, status: 'mature' as NoteStatus, transferredTo: undefined }
              : n
          ),
        });
        console.log(`[DenomStore] Recovered ${recoverable.length} transferred note(s)`);
        return recoverable.length;
      },

      // ------------------------------------------------------------------
      // Shield (deposit)
      // ------------------------------------------------------------------

      shieldNote: async (pool) => {
        if (get().isLoading) {
          console.warn('[DenomStore] shieldNote ignored — another operation in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        console.log('[DenomStore] shieldNote start:', pool.denomination, pool.token);
        set({ isLoading: true, error: null, progress: 'Preparing...' });

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const walletPubkey = walletSigner
            ? walletSigner.publicKey
            : (await getKeypair())?.publicKey;
          console.log('[DenomStore] walletSigner:', walletSigner ? `external(${walletSigner.publicKey.toBase58().slice(0,8)})` : 'local keypair');

          // ── Stealth intermediary: break wallet→pool on-chain link ──
          // Transfer SOL to an ephemeral stealth address first, then shield from there.
          // On-chain: wallet→stealth (normal transfer), stealth→pool (shield) — no direct link.
          let receipt: ShieldReceipt;
          set({ progress: 'Creating stealth intermediary...' });
          console.log('[DenomStore] Creating stealth intermediary to hide wallet origin...');
          try {
            const connection = getConnection();

            // Resolve source wallet (Privy signer OR local keypair)
            const localKp = walletSigner ? null : await getKeypair();
            const srcPubkey = walletSigner ? walletSigner.publicKey : localKp!.publicKey;
            const walletAddr = srcPubkey.toBase58();

            // ── Resolve the deterministic note counter FIRST ──
            // The counter is the stable per-shield identity. We derive the
            // stealth keypair from it (below), so it must be settled before
            // the stealth address exists. Mirrors the note-derivation block
            // that previously sat after the transfer.
            const poolKey = pool.poolPDA.toBase58();
            const storedCounter = get().shieldCounters[poolKey] ?? 0;
            let walletSeed: Uint8Array | null = null;
            if (localKp) {
              walletSeed = localKp.secretKey.slice(0, 32);
            }
            // If the counter was wiped (AsyncStorage decrypt failure, wallet
            // switch, fresh install) it could collide with a previously-spent
            // note's nullifier. Walk forward until we find a counter whose
            // nullifier PDAs are unused on-chain.
            let counter = storedCounter;
            if (walletSeed) {
              set({ progress: 'Verifying counter is free...' });
              counter = await findSafeShieldCounter(
                connection,
                walletSeed,
                pool.poolPDA,
                storedCounter,
              );
              if (counter !== storedCounter) {
                set(state => ({
                  shieldCounters: { ...state.shieldCounters, [poolKey]: counter },
                }));
              }
            }
            const deterministic = walletSeed ? { walletSeed, counter } : undefined;
            if (!deterministic) {
              console.warn('[DenomStore] No seed source available — note will NOT be seed-recoverable');
            }

            // ── Stealth intermediary keypair — DETERMINISTIC AND SECRET ──
            // Stable per-(pool, counter) so a crashed attempt re-derives the
            // SAME address and previously-funded SOL is recoverable rather than
            // stranded. Keyed on the wallet's SECRET seed, not its address —
            // see `services/privacy/ephemeralSigner.ts`. This site was the worst
            // of the six: the label is built from a public pool PDA and a
            // counter starting at 0, so an attacker needed no commitment at
            // all, just a wallet address and a loop — and this address receives
            // the FULL DENOMINATION before the shield executes.
            const stealthLabel = `stealth_shield_v1_${poolKey}_${counter}`;
            const { current: stealthKp, legacy: legacyStealthKp } =
              await deriveStealthSigners(stealthLabel, walletAddr);
            // A shield attempted before the derivation fix parked the FULL
            // denomination at the old, publicly-derivable address. Reclaim it
            // into the current one before funding anything new.
            await sweepLegacyStealth(connection, legacyStealthKp, stealthKp.publicKey);

            console.log(`[DenomStore] Stealth: ${stealthKp.publicKey.toBase58().slice(0, 12)}... (deterministic, counter=${counter})`);

            // Transfer denomination + rent + shield fee to stealth
            const lamports = pool.denomination === 0.1 ? 100_000_000 : pool.denomination === 0.5 ? 500_000_000 : pool.denomination * 1_000_000_000;
            const extra = 5_000_000; // 0.005 SOL for fees + rent
            const transferAmount = lamports + extra;

            // ── Idempotent recovery ──
            // If a prior attempt for this exact (pool, counter) crashed AFTER
            // funding the stealth address but BEFORE shielding, the SOL is
            // still sitting at this deterministic address. Re-derive, check the
            // balance, and only fund the shortfall (or skip funding entirely)
            // instead of double-funding from the main wallet.
            set({ progress: 'Checking stealth balance...' });
            let stealthBalance = 0;
            try {
              stealthBalance = await connection.getBalance(stealthKp.publicKey, 'confirmed');
            } catch {
              stealthBalance = 0; // RPC hiccup — treat as empty, fund full amount
            }
            if (stealthBalance >= transferAmount) {
              console.log(
                `[DenomStore] Stealth already funded (${(stealthBalance / 1e9).toFixed(4)} SOL >= ` +
                  `${(transferAmount / 1e9).toFixed(4)} SOL) — resuming, skipping transfer`,
              );
            } else {
              const fundShortfall = transferAmount - stealthBalance;
              if (stealthBalance > 0) {
                console.log(
                  `[DenomStore] Stealth partially funded (${(stealthBalance / 1e9).toFixed(4)} SOL) — ` +
                    `topping up shortfall ${(fundShortfall / 1e9).toFixed(4)} SOL`,
                );
              }
              set({ progress: 'Transferring to stealth address...' });
              const transferTx = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: srcPubkey,
                  toPubkey: stealthKp.publicKey,
                  lamports: fundShortfall,
                })
              );
              const { blockhash } = await connection.getLatestBlockhash();
              transferTx.recentBlockhash = blockhash;
              transferTx.feePayer = srcPubkey;
              let transferSig: string;
              if (walletSigner) {
                const signedTransfer = await walletSigner.signTransaction(transferTx);
                transferSig = await connection.sendRawTransaction(signedTransfer.serialize());
              } else {
                transferTx.sign(localKp!);
                transferSig = await connection.sendRawTransaction(transferTx.serialize());
              }
              await connection.confirmTransaction(transferSig, 'confirmed');
              console.log(`[DenomStore] Stealth transfer confirmed: ${transferSig.slice(0, 16)}...`);

              // Random delay 1-3s between transfer and shield (breaks timing correlation)
              const delay = 1000 + Math.floor(Math.random() * 2000);
              console.log(`[DenomStore] Timing jitter: ${delay}ms before shield`);
              set({ progress: 'Waiting (timing privacy)...' });
              await new Promise(r => setTimeout(r, delay));
            }

            // Now shield from the stealth keypair (not the user's wallet)
            set({ progress: 'Shielding from stealth address...' });
            console.log('[DenomStore] Shielding from stealth (wallet hidden on-chain)...');
            receipt = await shield(pool, (step) => {
              console.log('[DenomStore] progress:', step);
              set({ progress: step });
            }, undefined, stealthKp, deterministic); // Pass stealth keypair as the shielder

            if (deterministic) {
              set(state => ({
                shieldCounters: { ...state.shieldCounters, [poolKey]: counter + 1 },
              }));
            }

            console.log('[DenomStore] ✅ Shield via stealth — wallet NOT visible on-chain');
          } catch (stealthErr: any) {
            // Stealth failed — recover safely. Because the stealth keypair is
            // deterministic (seeded from walletAddr + poolKey + counter), the
            // failed attempt may have ALREADY moved SOL to the stealth address.
            // A blind direct shield from the main wallet would strand that SOL
            // forever AND double-spend. So: re-derive the stealth address, and
            // if it already holds the funds, RESUME the stealth shield from it
            // instead of paying again from the wallet.
            console.warn('[DenomStore] Stealth shield failed, recovering:', stealthErr.message);
            const connection = getConnection();
            const poolKey = pool.poolPDA.toBase58();
            const storedCounter = get().shieldCounters[poolKey] ?? 0;
            const directKp = walletSigner ? null : await getKeypair();
            const srcPubkey = walletSigner ? walletSigner.publicKey : directKp!.publicKey;
            const walletAddr = srcPubkey.toBase58();
            let walletSeed: Uint8Array | null = null;
            if (directKp) {
              walletSeed = directKp.secretKey.slice(0, 32);
            }
            let counter = storedCounter;
            if (walletSeed) {
              counter = await findSafeShieldCounter(
                connection,
                walletSeed,
                pool.poolPDA,
                storedCounter,
              );
              if (counter !== storedCounter) {
                set(state => ({
                  shieldCounters: { ...state.shieldCounters, [poolKey]: counter },
                }));
              }
            }
            const deterministic = walletSeed ? { walletSeed, counter } : undefined;

            // Re-derive the SAME deterministic stealth keypair for this
            // (pool, counter) and inspect its balance. Recovery path, so it
            // also carries the legacy address: an attempt started before the
            // derivation was fixed funded the OLD one, and that is exactly the
            // money this branch exists to find.
            const stealthLabel = `stealth_shield_v1_${poolKey}_${counter}`;
            const { current: stealthKp, legacy: legacyStealthKp } =
              await deriveStealthSigners(stealthLabel, walletAddr);
            await sweepLegacyStealth(connection, legacyStealthKp, stealthKp.publicKey);
            const lamports = pool.denomination === 0.1 ? 100_000_000 : pool.denomination === 0.5 ? 500_000_000 : pool.denomination * 1_000_000_000;
            const transferAmount = lamports + 5_000_000;
            let stealthBalance = 0;
            try {
              stealthBalance = await connection.getBalance(stealthKp.publicKey, 'confirmed');
            } catch {
              stealthBalance = 0;
            }

            if (stealthBalance >= transferAmount) {
              // Funds are stranded at the stealth address from the failed
              // attempt — resume the privacy-preserving shield from there.
              // No new transfer from the wallet ⇒ no double-spend, no loss.
              console.log(
                `[DenomStore] Recovering: stealth holds ${(stealthBalance / 1e9).toFixed(4)} SOL — ` +
                  `resuming shield from stealth (no re-funding)`,
              );
              set({ progress: 'Resuming shield from funded stealth...' });
              receipt = await shield(pool, (step) => {
                console.log('[DenomStore] progress:', step);
                set({ progress: step });
              }, undefined, stealthKp, deterministic);
            } else {
              // Stealth address is empty (failure happened before/at funding,
              // or funds were never moved) — safe to shield directly from the
              // wallet without risking a stranded-balance double-spend.
              console.log('[DenomStore] Stealth empty — direct shield from wallet is safe');
              receipt = await shield(pool, (step) => {
                console.log('[DenomStore] progress:', step);
                set({ progress: step });
              }, walletSigner, undefined, deterministic);
            }

            if (deterministic) {
              set(state => ({
                shieldCounters: { ...state.shieldCounters, [poolKey]: counter + 1 },
              }));
            }
          }

          const storedNote: StoredNote = {
            id: noteIdFromReceipt(receipt),
            receiptJSON: secureReceipt(receipt),
            token: pool.token,
            denomination: pool.denomination,
            poolPDA: pool.poolPDA.toBase58(),
            shieldedAt: receipt.shieldedAt,
            status: 'pending',
            source: 'shielded',
            cluster: getCluster(),
            ownerPubkey: walletPubkey?.toBase58(),
          };

          console.log('[DenomStore] Note stored:', storedNote.id, 'status:', storedNote.status);
          set(state => ({
            isLoading: false,
            progress: null,
            notes: [storedNote, ...state.notes],
          }));

          // Notify user of successful shield
          scheduleLocalNotification(
            'Shield Confirmed',
            `${pool.denomination} ${pool.token} shielded to privacy pool`,
            { category: 'transaction', token: pool.token, amount: String(pool.denomination), channelId: 'transactions' },
          ).catch(() => {}); // fire-and-forget, never block on notification failure

          return storedNote.id;
        } catch (err) {
          console.error('[DenomStore] Shield error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Shield Failed',
            `Failed to shield ${pool.denomination} ${pool.token}: ${(err as Error).message}`,
            { category: 'transaction', token: pool.token, amount: String(pool.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        }
      },

      // ------------------------------------------------------------------
      // V3 Shield (Goldilocks STARK — C6 merkle_update attestation)
      // ------------------------------------------------------------------
      //
      // V3 = full Goldilocks/STARK migration. Unlike v2, V3 requires the
      // depositor to pre-verify a C6 (merkle_update) STARK proof on-chain
      // BEFORE calling shield_denominated_v3, so the on-chain tree state
      // (root + filled_subtrees) is STARK-attested instead of trust-on-first-use.
      //
      // The screen drives the heavy lifting:
      //   1. Read pool tree state via parseFilledSubtrees(treePDA)
      //   2. Derive (secret, nullifierPreimage) deterministically from seed
      //   3. Compute commitment via createCommitmentV3
      //   4. Compute newRoot + updatedSubtrees via computeNewRootFromSubtreesV3
      //   5. Generate C6 proof via useStarkProver().generateMerkleUpdateProof
      //   6. Call this action with insertParams + c6ProofResult
      //
      // DEPOSITOR — MEASURED ON CHAIN 2026-08-04, then fixed here.
      //
      // This action used to hand the user's own keypair to `shieldV3`, so
      // `shield_denominated_v3` carried the wallet as `depositor: Signer`.
      // Devnet ShieldDenominatedV3 at slot 481,009,924 shows the user's wallet
      // 4vGBhCsonwAxMUHKFPGSz9x8R9R4NxJxMwHnyDz92ajo as fee payer AND only
      // signer, account index 0 — while the withdrawal from the SAME phone at
      // slot 481,027,681 shows only an ephemeral. The deposit was the leak.
      //
      // The relayer cannot fix it: `services/privacy/v3RelayerWrapper.ts:122-129`
      // signs the inner tx before encrypting it, and says so itself at :13-20.
      // So the inner signer has to change, and it does, below: a deterministic
      // ephemeral E derived from the wallet's SECRET seed
      // (`services/privacy/shieldEphemeral.ts`) is the C6 buffer authority AND
      // the depositor. The handler requires those to be the same account
      // (`shield_denominated_v3.rs:75-80`), which is why one keypair covers both.
      //
      // WHAT REMAINS PUBLIC, stated plainly: the wallet funds E with an
      // ordinary SystemProgram.transfer and E's residual is swept back to the
      // wallet. Both transfers are visible, and one hop from the deposit. This
      // makes the deposit's SHAPE match the withdrawal's and gives the relayer
      // something to hide; it does not make the deposit anonymous. A k-anonymous
      // feeder pool (Phase A.5) is what would.
      //
      // SOL only. A USDC deposit would need the denomination funded onto E's
      // ATA as well, which is not wired — routing it through E would fail the
      // shield AFTER the 145 KB proof upload, so USDC keeps the wallet as
      // depositor and logs that it is doing so.
      // ------------------------------------------------------------------
      shieldNoteV3: async (pool, insertParams, c6ProofResult) => {
        if (get().isLoading || _starkOpInFlight) {
          console.warn('[DenomStore] shieldNoteV3 ignored — another operation in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        if (pool.version !== 'v3') {
          throw new Error('shieldNoteV3 called with non-v3 pool — use shieldNote for v2');
        }
        console.log('[DenomStore] shieldNoteV3 start:', pool.denomination, pool.token);
        _starkOpInFlight = true;
        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing V3 shield...' });

        // Hoisted so the error path can sweep E even if the shield throws
        // mid-flight. E holds the FULL denomination between the pre-fund and
        // the shield, so this is the difference between a retryable failure and
        // a lost deposit.
        let shieldEphemeral: SolKeypair | null = null;
        let shieldFunder: SolKeypair | null = null;

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const walletPubkey = walletSigner
            ? walletSigner.publicKey
            : (await getKeypair())?.publicKey;

          const localKp = walletSigner ? null : await getKeypair();
          const connection = getConnection();

          // Only the native-SOL path can use an ephemeral depositor — see the
          // header. `walletSigner` is always undefined today (Privy removed);
          // the branch is kept so a future external signer degrades loudly
          // instead of silently signing the shield with the user's wallet.
          const useEphemeralDepositor = pool.token === 'SOL' && localKp !== null;

          let depositorKp: SolKeypair | null = localKp;
          if (useEphemeralDepositor) {
            const { noteSeed } = await deriveLocalNoteSeed();
            const ephemeral = deriveShieldEphemeral(
              noteSeed,
              pool.poolPDA,
              insertParams.counter,
            );
            shieldEphemeral = ephemeral;
            shieldFunder = localKp!;

            const { UNIFORM_PROOF_SIZE } = await import('../services/stark');
            const PROOF_DATA_OFFSET_LOCAL = 83;
            // Rent for the PADDED size, not the proof's actual size. The
            // uniform pipeline reallocs the buffer to UNIFORM_PROOF_SIZE, and
            // pricing the real size runs E out of lamports during the last
            // resize (ResultWithNegativeLamports) — the same trap the V3
            // unshield pre-fund documents.
            const bufferRent = await connection.getMinimumBalanceForRentExemption(
              PROOF_DATA_OFFSET_LOCAL + UNIFORM_PROOF_SIZE,
            );
            const relayerEnabled = (
              await import('./settingsStore').then(m => m.useSettingsStore.getState())
            ).relayerV3Enabled;
            const requiredLamports = computeShieldPrefundLamports({
              denominationAtomic: pool.denominationAtomic,
              bufferRent,
              relayerEnabled,
            });

            set({ progress: 'Funding the deposit signer...' });
            console.log(
              `[DenomStore/V3] shield depositor = ephemeral ${ephemeral.publicKey.toBase58().slice(0, 8)}… ` +
                `(counter=${insertParams.counter}); pre-fund ${(requiredLamports / 1e9).toFixed(6)} SOL ` +
                `(denom=${(Number(pool.denominationAtomic) / 1e9).toFixed(4)} bufferRent=${(bufferRent / 1e9).toFixed(4)} ` +
                `relayer=${relayerEnabled})`,
            );
            const prefund = await resumeShieldPrefund(
              connection,
              localKp!,
              ephemeral,
              requiredLamports,
            );
            console.log(
              `[DenomStore/V3] pre-fund ${prefund.signature ? 'sent ' + prefund.signature.slice(0, 16) + '…' : 'skipped (already funded)'}` +
                ` — E balance ${(prefund.balance / 1e9).toFixed(6)} SOL`,
            );

            // Timing jitter between the public wallet→E transfer and the shield.
            // Worth almost nothing on its own (the amounts still line up) but it
            // costs nothing and matches the unshield path.
            const jitter = 1000 + Math.floor(Math.random() * 2000);
            set({ progress: 'Waiting (timing privacy)...' });
            await new Promise(r => setTimeout(r, jitter));

            depositorKp = ephemeral;
          } else if (localKp) {
            console.warn(
              `[DenomStore/V3] shield depositor = USER WALLET ${localKp.publicKey.toBase58().slice(0, 8)}… ` +
                `— token=${pool.token} has no ephemeral path (ATA not funded). The wallet WILL appear ` +
                'as the signer of this deposit on chain.',
            );
          }

          const { txSig, receipt } = await shieldV3(
            pool,
            c6ProofResult,
            insertParams,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK') || step.includes('C6');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
            depositorKp || undefined,
          );

          // Return E's residual (recovered C6 buffer rent + unused fee budget).
          // Public, and one hop from the wallet — see the header. Deliberately
          // AFTER the shield landed so a sweep failure cannot cost the deposit.
          if (shieldEphemeral && shieldFunder) {
            set({ progress: 'Returning recovered rent...' });
            await sweepShieldEphemeral(connection, shieldEphemeral, shieldFunder.publicKey);
          }

          // The service shieldV3 already populates receipt.tokenMint via
          // pubkeyToField. We just stamp poolVersion onto the StoredNote so
          // unshield can route correctly.
          const storedNote: StoredNote = {
            id: noteIdFromReceipt(receipt),
            receiptJSON: secureReceipt(receipt),
            token: pool.token,
            denomination: pool.denomination,
            poolPDA: pool.poolPDA.toBase58(),
            shieldedAt: receipt.shieldedAt,
            status: 'pending',
            source: 'shielded',
            cluster: getCluster(),
            ownerPubkey: walletPubkey?.toBase58(),
            poolVersion: 'v3',
          };

          console.log('[DenomStore] V3 note stored:', storedNote.id, 'sig:', txSig.slice(0, 16));
          // Advance the per-pool counter so the NEXT V3 shield uses a fresh
          // (np, secret) and avoids the v3-counter nullifier collision bug.
          // findSafeShieldCounter chose `insertParams.counter`; the next safe
          // candidate is `counter + 1` (it'll re-walk on the next shield to
          // skip any cross-device shifts).
          const poolKey = pool.poolPDA.toBase58();
          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: [storedNote, ...state.notes],
            shieldCounters: {
              ...state.shieldCounters,
              [poolKey]: insertParams.counter + 1,
            },
          }));

          scheduleLocalNotification(
            'Shield Confirmed (V3)',
            `${pool.denomination} ${pool.token} shielded to V3 privacy pool`,
            { category: 'transaction', token: pool.token, amount: String(pool.denomination), channelId: 'transactions' },
          ).catch(() => {});

          return storedNote.id;
        } catch (err) {
          console.error('[DenomStore] V3 shield error:', err);

          // Crash-recovery for the deposit signer. E may be holding the FULL
          // denomination plus ~1 SOL of buffer rent at this point. Sweeping it
          // back is best-effort and never masks `err`: if the sweep also fails
          // the funds are still at a DETERMINISTIC address, re-derivable from
          // (seed, pool, counter) alone — retrying this exact shield picks the
          // same counter (no nullifier was written) and resumes from the money
          // already sitting there instead of paying twice.
          if (shieldEphemeral && shieldFunder) {
            const bal = await sweepShieldEphemeral(
              getConnection(),
              shieldEphemeral,
              shieldFunder.publicKey,
            );
            if (bal === 0) {
              console.warn(
                `[DenomStore/V3] deposit signer ${shieldEphemeral.publicKey.toBase58()} was not swept — ` +
                  `retry the same shield (pool=${pool.poolPDA.toBase58()}, counter=${insertParams.counter}) to resume from it.`,
              );
            }
          }

          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Shield Failed',
            `Failed to shield ${pool.denomination} ${pool.token}: ${(err as Error).message}`,
            { category: 'transaction', token: pool.token, amount: String(pool.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        } finally {
          _starkOpInFlight = false;
        }
      },

      // ------------------------------------------------------------------
      // STARK Unshield (quantum-resistant — no Groth16 proof)
      // ------------------------------------------------------------------

      unshieldNoteStark: async (noteId, recipientAddress, starkProofData, emergency) => {
        if (_starkOpInFlight || get().isLoading) {
          console.warn('[DenomStore] unshieldNoteStark ignored — another STARK op in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status === 'locked') throw new Error('Note is locked in an active privacy route');

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        // Pre-flight: abort before stealth setup if the note's STARK PDA is
        // already on-chain. Saves a few seconds of wasted work and — more
        // importantly — flips the local status to 'spent' so the UI reflects
        // reality. The proof was generated from starkProofData.publicInputs[0]
        // which IS the Goldilocks nullifier; probe its PDA directly.
        try {
          const preStarkNull = starkProofData.publicInputs?.[0] ?? 0n;
          if (preStarkNull !== 0n) {
            const [prePda] = deriveNullifierPDA(
              pool.poolPDA,
              goldilocksNullifierToBytes(preStarkNull),
            );
            const preConn = getConnection();
            const preAcct = await preConn.getAccountInfo(prePda);
            if (preAcct !== null) {
              set(state => ({
                notes: state.notes.map(n =>
                  n.id === noteId ? { ...n, status: 'spent' as NoteStatus } : n,
                ),
              }));
              throw new Error('Note already spent on-chain');
            }
          }
        } catch (e) {
          if ((e as Error).message === 'Note already spent on-chain') throw e;
          // Network glitch — fall through; the on-chain `init` constraint is
          // still the authoritative double-spend guard.
        }

        _starkOpInFlight = true;
        console.log(
          `[P01_UI] ${JSON.stringify({
            ts: new Date().toISOString(),
            event: 'unshieldStark-flow-begin',
            noteId,
            emergency: !!emergency,
          })}`,
        );
        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing STARK unshield...' });

        // Hoisted so the catch handler can sweep the ephemeral signer back
        // to the user's wallet if the unshield crashes after funding. See
        // the catch block at the bottom of this try/catch for the recovery path.
        let stealthKp: SolKeypair | null = null;
        // Pre-fix address for the same operation. Held so the crash-sweep can
        // recover an attempt that was funded before the derivation was fixed.
        let legacyStealthKp: SolKeypair | null = null;

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const PK = PublicKey;

          // Full stealth unshield: BOTH signer AND recipient are ephemeral.
          //
          // On-chain, an observer sees:
          //   Fee Payer / Signer: stealth_signer (ephemeral, one-time)
          //   Recipient: stealth_recipient (ECDH-derived one-time address)
          //   Pool: sends denomination to stealth_recipient
          //
          // The user's real wallet does not appear IN THIS INSTRUCTION. It is
          // not hidden overall, and the old comment here ("the user's real
          // wallet NEVER appears... until the user scans and sweeps") was wrong
          // twice over:
          //   - the wallet publicly funds the signer a few seconds earlier, and
          //   - the sweep back to the wallet is AUTOMATIC and happens ~8 s
          //     later for the same amount (measured: slot 481,027,703).
          // Above all, the withdrawal publishes the note commitment the deposit
          // published, so the wallet↔note link is public from the algebra alone.
          //
          // Flow:
          //   1. Derive the deterministic ephemeral signer (secret-seeded)
          //   2. Derive stealth recipient from user's meta-address (ECDH)
          //   3. Wallet funds signer with SOL for STARK buffer + tx fees (PUBLIC)
          //   4. Signer submits STARK proof + unshield → pool pays stealth recipient
          //   5. Persisted claim, then a sweep that can be retried or redirected

          // Derive stealth recipient from user's own meta-address
          set({ progress: 'Generating stealth recipient...' });
          const metaAddr = await getMetaAddress();
          const parsed = parseMetaAddress(metaAddr);
          const stealthResult = genStealth(parsed.spendingPubKey, parsed.viewingPubKey, parsed.kemPubKey);
          const stealthRecipient = new PK(stealthResult.address);
          console.log(`[DenomStore] Stealth recipient: ${stealthRecipient.toBase58().slice(0, 12)}... (wallet hidden)`);

          // Generate ephemeral signer (for fees — NOT linked to wallet on-chain).
          // Deterministic in (secret note seed, noteId) so a crashed attempt is
          // resumable/sweepable across app launches, and unpredictable to an
          // observer because the key material is secret. The old derivation
          // keyed on `walletAddr`, which is public — see
          // `services/privacy/ephemeralSigner.ts`. "each noteId is used at most
          // once" was a collision argument, not a secrecy argument.
          const walletAddr = walletSigner?.publicKey.toBase58() || recipientAddress;
          const unshieldSigners = await deriveStealthSigners(`stealth_unshield_${noteId}`, walletAddr);
          stealthKp = unshieldSigners.current;
          legacyStealthKp = unshieldSigners.legacy;
          console.log(`[DenomStore] Stealth signer: ${stealthKp.publicKey.toBase58().slice(0, 12)}...`);

          // Fund signer for STARK buffer rent + tx fees (dynamic from actual proof size).
          // Buffer rent (~0.07-0.21 SOL by circuit) is recovered on close_proof_buffer.
          // Leftover swept back to wallet. Net real cost: ~0.002 SOL + platform fees.
          set({ progress: 'Funding ephemeral signer...' });
          const connection = getConnection();
          const PROOF_DATA_OFFSET_LOCAL = 83;
          const bufferRent = await connection.getMinimumBalanceForRentExemption(PROOF_DATA_OFFSET_LOCAL + starkProofData.proofSize);
          const FEE_FUND = bufferRent + 10_000_000; // + 0.01 SOL for tx fees + nullifier PDA + margin
          console.log(`[DenomStore] Pre-fund: ${(FEE_FUND / 1e9).toFixed(4)} SOL (rent=${(bufferRent / 1e9).toFixed(4)} for ${starkProofData.proofSize}B proof)`);
          if (walletSigner) {
            const fundTx = new Transaction().add(
              SystemProgram.transfer({ fromPubkey: walletSigner.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND })
            );
            const { blockhash } = await connection.getLatestBlockhash();
            fundTx.recentBlockhash = blockhash;
            fundTx.feePayer = walletSigner.publicKey;
            const signedFund = await walletSigner.signTransaction(fundTx);
            await connection.sendRawTransaction(signedFund.serialize()).then(s => connection.confirmTransaction(s, 'confirmed'));
          } else {
            const kp = await getKeypair();
            if (kp) {
              const fundTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND })
              );
              const { blockhash } = await connection.getLatestBlockhash();
              fundTx.recentBlockhash = blockhash;
              fundTx.feePayer = kp.publicKey;
              fundTx.sign(kp);
              await connection.sendRawTransaction(fundTx.serialize()).then(s => connection.confirmTransaction(s, 'confirmed'));
            }
          }

          // Random timing jitter (1-3s) to decorrelate funding from unshield
          const jitter = 1000 + Math.floor(Math.random() * 2000);
          set({ progress: 'Waiting (timing privacy)...' });
          await new Promise(r => setTimeout(r, jitter));

          // Persist the sender-side stealth material BEFORE submitting. The
          // recipient's private key is rebuilt from these three values plus the
          // SecureStore viewing/KEM keys, and the ephemeral inside them is
          // random and never published on chain — so until this record exists,
          // a process death after the withdrawal lands loses the denomination.
          // See `services/privacy/stealthSweep.ts`.
          {
            const rec = buildPendingStealthSweep({
              noteId,
              poolPDA: pool.poolPDA.toBase58(),
              destination: recipientAddress,
              stealth: stealthResult,
            });
            set(state => ({
              pendingStealthSweeps: [
                ...state.pendingStealthSweeps.filter(r => r.noteId !== noteId),
                rec,
              ],
            }));
          }

          // Unshield: stealth signer pays fees, pool sends to stealth recipient
          const sig = await unshieldStark(
            receipt, pool, stealthRecipient, starkProofData,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK');
              const cur = get();
              console.log(
                `[P01_UI] ${JSON.stringify({
                  ts: new Date().toISOString(),
                  event: 'unshieldStark-progress',
                  step,
                  isProvingNext: proving,
                  isProvingPrev: cur.isProving,
                  isLoading: cur.isLoading,
                  starkOpInFlight: _starkOpInFlight,
                })}`,
              );
              set({ progress: step, isProving: proving });
            },
            undefined, // stealth keypair signs, not wallet
            emergency,
            stealthKp, // overrideKeypair — stealth signer is fee payer
          );

          // Mark note as spent IMMEDIATELY after unshield succeeds
          // (before sweep — if app backgrounds during sweep, note is already spent)
          set(state => ({
            isProving: false,
            progress: 'Sweeping to wallet...',
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          // Sweep the stealth recipient back to `recipientAddress`.
          //
          // MEASURED, and NOT fixed by the delay below: on the V3 pair from
          // 2026-08-04 this forward landed EIGHT SECONDS after the withdrawal
          // for a matching amount, which makes the stealth address a rename of
          // the wallet rather than a hop. The delay is kept honest-sized rather
          // than grown, because growing it would not help: the withdrawal
          // publishes the same note commitment the deposit published, so the
          // link an analyst uses is algebraic, not temporal.
          //
          // What DID change is that this is no longer the only chance. The
          // record persisted above survives a failure here, so `settled: false`
          // leaves a retryable claim instead of a dead key, and
          // `sweepStealthRecipient(noteId, otherAddress)` can later send the
          // money somewhere that is not the wallet — the only version of this
          // hop that is worth anything.
          try {
            const sweepDelay = 3000 + Math.floor(Math.random() * 4000); // 3-7s
            set({ progress: 'Sweeping to wallet (delayed)...' });
            await new Promise(r => setTimeout(r, sweepDelay));

            await get().sweepStealthRecipient(noteId);

            // Also drain leftover fees from signer
            const signerBal = await connection.getBalance(stealthKp.publicKey);
            if (signerBal > 5000) {
              const drainTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: stealthKp.publicKey, toPubkey: new PK(recipientAddress), lamports: signerBal - 5000 })
              );
              const { blockhash } = await connection.getLatestBlockhash();
              drainTx.recentBlockhash = blockhash;
              drainTx.feePayer = stealthKp.publicKey;
              drainTx.sign(stealthKp);
              await connection.sendRawTransaction(drainTx.serialize()).then(s => connection.confirmTransaction(s, 'confirmed'));
            }
          } catch (sweepErr: any) {
            // The recipient sweep no longer throws (it records instead), so
            // this only catches the signer drain. Either way the stealth claim
            // is persisted and retryable via `retryPendingStealthSweeps`.
            console.error('[DenomStore] signer drain failed (claim persisted):', sweepErr.message, sweepErr.stack?.slice(0, 200));
          }

          // Final state cleanup (note already marked spent above)
          set({ isLoading: false, isProving: false, progress: null });

          // Refresh wallet balance immediately, delay transaction fetch
          // to let RPC rate-limit window reset after STARK chunk uploads
          useWalletStore.getState().refreshBalance();
          setTimeout(() => {
            useWalletStore.getState().refreshTransactions();
          }, 5000);

          scheduleLocalNotification(
            'Unshield Confirmed',
            `${note.denomination} ${note.token} withdrawn from privacy pool`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          return sig;
        } catch (err) {
          console.error('[DenomPool] STARK unshield error:', err);

          // Recovery sweep: if the ephemeral signer was funded but the
          // flow crashed before (or during) proof submission, any leftover
          // SOL is trapped on an ephemeral pubkey. With the deterministic
          // seed above the keypair is still in memory here, so sweep the
          // balance back to the user's wallet before surfacing the error.
          // A close_proof_buffer call inside unshieldStark already reclaims
          // the buffer rent on clean paths; this covers the crash case.
          if (stealthKp) {
            try {
              const connection = getConnection();
              // An attempt started before the derivation fix funded the OLD,
              // publicly-derivable address. Pull it back first so the sweep
              // below carries it too, instead of leaving it for whoever else
              // derived the same key.
              await sweepLegacyStealth(connection, legacyStealthKp, stealthKp.publicKey);
              const stealthBal = await connection.getBalance(stealthKp.publicKey);
              const FEE_RESERVE = 5000;
              if (stealthBal > FEE_RESERVE) {
                const sweepAmount = stealthBal - FEE_RESERVE;
                const sweepTx = new Transaction().add(
                  SystemProgram.transfer({
                    fromPubkey: stealthKp.publicKey,
                    toPubkey: new PublicKey(recipientAddress),
                    lamports: sweepAmount,
                  }),
                );
                const { blockhash } = await connection.getLatestBlockhash();
                sweepTx.recentBlockhash = blockhash;
                sweepTx.feePayer = stealthKp.publicKey;
                sweepTx.sign(stealthKp);
                const sweepSig = await connection.sendRawTransaction(sweepTx.serialize());
                await connection.confirmTransaction(sweepSig, 'confirmed');
                console.log(`[DenomStore] 🛟 crash-sweep: ${(sweepAmount / 1e9).toFixed(4)} SOL recovered → ${recipientAddress.slice(0, 12)}… sig=${sweepSig.slice(0, 16)}…`);
              }
            } catch (sweepErr: any) {
              console.error(
                `[DenomStore] ❌ crash-sweep FAILED — funds stuck at ${stealthKp.publicKey.toBase58()}:`,
                sweepErr.message,
              );
            }
          }

          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Unshield Failed',
            `Failed to withdraw ${note.denomination} ${note.token}: ${(err as Error).message}`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        } finally {
          _starkOpInFlight = false;
        }
      },

      // ------------------------------------------------------------------
      // V3 STARK Unshield (Goldilocks — 3-tx orchestration: C1 + C3 + ix)
      // ------------------------------------------------------------------
      //
      // Mirrors `unshieldNoteStark` (v2) but consumes TWO pre-generated proofs
      // (C1 pool_commitment + C3 merkle_path) instead of one. The screen
      // generates them sequentially via the StarkProver (single-threaded
      // WebView — never use Promise.all) and passes both into this action.
      //
      // Stealth signer + ECDH stealth recipient + auto-sweep is identical
      // to v2. The only differences:
      //   - Pre-fund covers TWO proof buffers (C1 + C3 ≈ 2× v2 buffer rent)
      //   - 3 tx round-trips instead of 2 (~+6s on devnet)
      //   - Service helper closes BOTH buffers in `finally` for rent recovery
      // ------------------------------------------------------------------
      unshieldNoteStarkV3: async (noteId, recipientAddress, c1ProofData, c3ProofData, walk, _emergency) => {
        if (_starkOpInFlight || get().isLoading) {
          console.warn('[DenomStore] unshieldNoteStarkV3 ignored — another STARK op in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status === 'locked') throw new Error('Note is locked in an active privacy route');
        if (note.poolVersion !== 'v3') {
          throw new Error('unshieldNoteStarkV3 called with non-v3 note — use unshieldNoteStark for v2');
        }

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('V3 pool config not found for this note');

        // Pre-flight: STARK PDA already on-chain → already spent.
        try {
          const preStarkNull = c1ProofData.publicInputs?.[0] ?? 0n;
          if (preStarkNull !== 0n) {
            const [prePda] = deriveNullifierPDA(
              pool.poolPDA,
              goldilocksNullifierToBytes(preStarkNull),
            );
            const preConn = getConnection();
            const preAcct = await preConn.getAccountInfo(prePda);
            if (preAcct !== null) {
              set(state => ({
                notes: state.notes.map(n =>
                  n.id === noteId ? { ...n, status: 'spent' as NoteStatus } : n,
                ),
              }));
              throw new Error('Note already spent on-chain');
            }
          }
        } catch (e) {
          if ((e as Error).message === 'Note already spent on-chain') throw e;
          // Network glitch — fall through; the on-chain `init` constraint is
          // still the authoritative double-spend guard.
        }

        _starkOpInFlight = true;
        console.log(
          `[P01_UI] ${JSON.stringify({
            ts: new Date().toISOString(),
            event: 'unshieldStarkV3-flow-begin',
            noteId,
          })}`,
        );
        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing V3 STARK unshield...' });

        let stealthKp: SolKeypair | null = null;
        // Pre-fix address for the same operation. Held so the crash-sweep can
        // recover an attempt that was funded before the derivation was fixed.
        let legacyStealthKp: SolKeypair | null = null;

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const PK = PublicKey;

          // Derive ECDH stealth recipient from user's meta-address
          set({ progress: 'Generating stealth recipient...' });
          const metaAddr = await getMetaAddress();
          const parsed = parseMetaAddress(metaAddr);
          const stealthResult = genStealth(parsed.spendingPubKey, parsed.viewingPubKey, parsed.kemPubKey);
          const stealthRecipient = new PK(stealthResult.address);

          // Deterministic per-note ephemeral signer (resumable on crash), keyed
          // on the wallet's SECRET seed. The old derivation was
          // hmac(sha256, key = utf8(walletAddr), msg = utf8('stealth_unshield_v3_' + noteId))
          // — both inputs public, so the private key of the signer that paid
          // for the MEASURED devnet withdrawal at slot 481,027,681 was
          // recomputable by anyone. See `services/privacy/ephemeralSigner.ts`.
          const walletAddr = walletSigner?.publicKey.toBase58() || recipientAddress;
          const unshieldV3Signers = await deriveStealthSigners(`stealth_unshield_v3_${noteId}`, walletAddr);
          stealthKp = unshieldV3Signers.current;
          legacyStealthKp = unshieldV3Signers.legacy;

          // V3 = TWO proof buffers. Pre-fund covers both rents + tx fees.
          // Phase C v1: BOTH buffers are padded to UNIFORM_PROOF_SIZE so the
          // verifier sees identical envelope sizes regardless of circuit.
          // Pre-fund the rent for the PADDED size, not the proof's actual
          // size — otherwise the ephemeral runs out of lamports during the
          // last few resize calls and the realloc CPI fails with
          // ResultWithNegativeLamports (Custom error 1).
          set({ progress: 'Funding ephemeral signer (V3)...' });
          const connection = getConnection();
          const PROOF_DATA_OFFSET_LOCAL = 83;
          const { UNIFORM_PROOF_SIZE } = await import('../services/stark');
          const c1Rent = await connection.getMinimumBalanceForRentExemption(PROOF_DATA_OFFSET_LOCAL + UNIFORM_PROOF_SIZE);
          const c3Rent = c1Rent; // same uniform size
          // 0.015 SOL margin — covers 4 confirmable txs + nullifier PDA rent + slippage.
          // When the V3 relayer wrapper is enabled the stealth signer must
          // also cover the relay-job pre-fund (jobFee + jobRent + N*chunkRent
          // + txFees + ephemeralRentMin) since the wrapper transfers FROM
          // the stealth signer to the relayer ephemeral. We top up by 40M
          // (~0.04 SOL) to cover up to 4 chunks (v2 ML-KEM-768 hybrid envelope
          // can push chunk count to 3 for non-trivial inner txs). Excess is
          // recovered via the crash-sweep on error.
          const settings = await import('./settingsStore').then(m => m.useSettingsStore.getState());
          const RELAYER_TOPUP = settings.relayerV3Enabled ? 40_000_000 : 0;
          const FEE_FUND = c1Rent + c3Rent + 15_000_000 + RELAYER_TOPUP;
          console.log(
            `[Unshield/V3] step1 pre-fund: ${(FEE_FUND / 1e9).toFixed(4)} SOL ` +
            `(c1Rent=${(c1Rent / 1e9).toFixed(4)} c3Rent=${(c3Rent / 1e9).toFixed(4)} ` +
            `margin=0.0150 relayerTopup=${(RELAYER_TOPUP / 1e9).toFixed(3)} v3Relayer=${settings.relayerV3Enabled})`,
          );

          const fundSourcePubkey = walletSigner?.publicKey ?? (await getKeypair())?.publicKey;
          if (fundSourcePubkey) {
            const sourceBal = await connection.getBalance(fundSourcePubkey);
            console.log(`[Unshield/V3] step1 source ${fundSourcePubkey.toBase58().slice(0, 8)}… bal=${(sourceBal / 1e9).toFixed(6)} SOL (need ${(FEE_FUND / 1e9).toFixed(6)})`);
            if (sourceBal < FEE_FUND) {
              console.error(`[Unshield/V3] step1 INSUFFICIENT BALANCE — short ${((FEE_FUND - sourceBal) / 1e9).toFixed(6)} SOL`);
            }
          }

          if (walletSigner) {
            const fundTx = new Transaction().add(
              SystemProgram.transfer({ fromPubkey: walletSigner.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND }),
            );
            const { blockhash } = await connection.getLatestBlockhash();
            fundTx.recentBlockhash = blockhash;
            fundTx.feePayer = walletSigner.publicKey;
            const signedFund = await walletSigner.signTransaction(fundTx);
            const fundSig = await connection.sendRawTransaction(signedFund.serialize());
            await connection.confirmTransaction(fundSig, 'confirmed');
            console.log(`[Unshield/V3] step1 fundTx confirmed: ${fundSig.slice(0, 16)}…`);
          } else {
            const kp = await getKeypair();
            if (kp) {
              const fundTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND }),
              );
              const { blockhash } = await connection.getLatestBlockhash();
              fundTx.recentBlockhash = blockhash;
              fundTx.feePayer = kp.publicKey;
              fundTx.sign(kp);
              const fundSig = await connection.sendRawTransaction(fundTx.serialize());
              await connection.confirmTransaction(fundSig, 'confirmed');
              console.log(`[Unshield/V3] step1 fundTx confirmed: ${fundSig.slice(0, 16)}…`);
            }
          }
          const stealthBalAfterFund = await connection.getBalance(stealthKp.publicKey);
          console.log(`[Unshield/V3] step1 stealth ${stealthKp.publicKey.toBase58().slice(0, 8)}… funded bal=${(stealthBalAfterFund / 1e9).toFixed(6)} SOL`);

          // Timing jitter
          const jitter = 1000 + Math.floor(Math.random() * 2000);
          set({ progress: 'Waiting (timing privacy)...' });
          await new Promise(r => setTimeout(r, jitter));

          // Persist the sender-side stealth material BEFORE submitting — same
          // reason as the v2 path. `stealthResult.ephemeralPublicKey` comes
          // from a `nacl.box.keyPair()` generated seconds ago and appears in no
          // instruction, so this record is the only thing standing between a
          // process death and a lost denomination.
          {
            const rec = buildPendingStealthSweep({
              noteId,
              poolPDA: pool.poolPDA.toBase58(),
              destination: recipientAddress,
              stealth: stealthResult,
            });
            set(state => ({
              pendingStealthSweeps: [
                ...state.pendingStealthSweeps.filter(r => r.noteId !== noteId),
                rec,
              ],
            }));
          }

          // V3 unshield — service handles 3-tx flow + buffer cleanup.
          const sig = await unshieldDenominatedStarkV3(
            receipt, pool, stealthRecipient,
            c1ProofData, c3ProofData,
            walk,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK') || step.includes('C1') || step.includes('C3');
              set({ progress: step, isProving: proving });
            },
            undefined,
            stealthKp,
          );

          // Mark spent immediately so background sweep can't re-trigger
          set(state => ({
            isProving: false,
            progress: 'Sweeping to wallet...',
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          // Sweep the stealth recipient. THIS IS THE 8-SECOND FORWARD MEASURED
          // ON DEVNET (slot 481,027,703, sig 36AA328ZmYqy…, 0.994995 SOL out
          // against 1.000 in, 22 slots after the withdrawal at 481,027,681).
          //
          // It is not lengthened here, and the reason is evidence rather than
          // taste: the withdrawal already publishes the note commitment the
          // deposit published (leaf 16 = 8901821612542787864 in both), so the
          // wallet↔note link is public regardless of when this forward happens.
          // A longer timer would buy nothing measurable and would extend the
          // window in which the app is holding money it has not yet moved.
          //
          // The change that DOES matter is above: the claim is persisted, so a
          // failure here keeps a retryable record instead of destroying the
          // key, and `sweepStealthRecipient(noteId, elsewhere)` can send the
          // funds to an address other than the depositing wallet later.
          try {
            const sweepDelay = 3000 + Math.floor(Math.random() * 4000);
            set({ progress: 'Sweeping to wallet (delayed)...' });
            await new Promise(r => setTimeout(r, sweepDelay));

            await get().sweepStealthRecipient(noteId);

            // Drain leftover from signer back to wallet
            const signerBal = await connection.getBalance(stealthKp.publicKey);
            if (signerBal > 5000) {
              const drainTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: stealthKp.publicKey, toPubkey: new PK(recipientAddress), lamports: signerBal - 5000 }),
              );
              const { blockhash } = await connection.getLatestBlockhash();
              drainTx.recentBlockhash = blockhash;
              drainTx.feePayer = stealthKp.publicKey;
              drainTx.sign(stealthKp);
              await connection.sendRawTransaction(drainTx.serialize()).then(s => connection.confirmTransaction(s, 'confirmed'));
            }
          } catch (sweepErr: any) {
            // Only the signer drain can throw now; the recipient sweep records
            // its failure and keeps the claim.
            console.error('[DenomStore/V3] signer drain failed (claim persisted):', sweepErr.message);
          }

          set({ isLoading: false, isProving: false, progress: null });

          useWalletStore.getState().refreshBalance();
          setTimeout(() => useWalletStore.getState().refreshTransactions(), 5000);

          scheduleLocalNotification(
            'Unshield Confirmed (V3)',
            `${note.denomination} ${note.token} withdrawn from V3 privacy pool`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          return sig;
        } catch (err) {
          console.error('[DenomPool/V3] STARK unshield error:', err);

          // Crash-sweep — recover ephemeral signer balance.
          // Retry with a FRESH balance each attempt: in-flight upload TXs keep
          // draining the ephemeral after a mid-batch failure, so a one-shot
          // sweep computed from a stale getBalance overshoots and fails with
          // "insufficient lamports" (the funds then strand). Re-reading the
          // balance after a short delay lets the pending TXs settle so the
          // amount matches; this also rides the RPC retry in resilientFetch.
          if (stealthKp) {
            const connection = getConnection();
            // Same reason as the v2 path: recover a pre-fix attempt's funds
            // into the current address before sweeping.
            await sweepLegacyStealth(connection, legacyStealthKp, stealthKp.publicKey);
            const FEE_RESERVE = 5000;
            const SWEEP_ATTEMPTS = 5;
            let swept = false;
            for (let a = 0; a < SWEEP_ATTEMPTS && !swept; a++) {
              try {
                if (a > 0) await new Promise(r => setTimeout(r, 2000));
                const stealthBal = await connection.getBalance(stealthKp.publicKey);
                if (stealthBal <= FEE_RESERVE) { swept = true; break; } // nothing to recover
                const sweepAmount = stealthBal - FEE_RESERVE;
                const sweepTx = new Transaction().add(
                  SystemProgram.transfer({
                    fromPubkey: stealthKp.publicKey,
                    toPubkey: new PublicKey(recipientAddress),
                    lamports: sweepAmount,
                  }),
                );
                const { blockhash } = await connection.getLatestBlockhash();
                sweepTx.recentBlockhash = blockhash;
                sweepTx.feePayer = stealthKp.publicKey;
                sweepTx.sign(stealthKp);
                const sweepSig = await connection.sendRawTransaction(sweepTx.serialize());
                await connection.confirmTransaction(sweepSig, 'confirmed');
                console.log(`[DenomStore/V3] 🛟 crash-sweep: ${(sweepAmount / 1e9).toFixed(4)} SOL recovered (attempt ${a + 1})`);
                swept = true;
              } catch (sweepErr: any) {
                if (a === SWEEP_ATTEMPTS - 1) {
                  console.error(
                    `[DenomStore/V3] ❌ crash-sweep FAILED after ${SWEEP_ATTEMPTS} attempts — funds at ${stealthKp.publicKey.toBase58()} (re-run this note's unshield to recover; ephemeral is deterministically derived):`,
                    sweepErr.message,
                  );
                }
              }
            }
          }

          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Unshield Failed',
            `Failed to withdraw ${note.denomination} ${note.token}: ${(err as Error).message}`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        } finally {
          _starkOpInFlight = false;
        }
      },

      // ------------------------------------------------------------------
      // V4 STARK Unshield (circuit 7 — ONE proof, no commitment on the wire)
      // ------------------------------------------------------------------
      //
      // Two actions. `prepareUnshieldNoteV4` derives the stealth recipient and
      // proves; `unshieldNoteStarkV4` funds, uploads, spends, sweeps. The split
      // is what lets `routeUnshieldSpend` (services/denominatedPool/spendRouting.ts)
      // fall back to the C1 + C3 pair on a `V4Unprovable` from the prepare
      // step while nothing after it can ever fall back.
      //
      // Stealth signer + ECDH stealth recipient + auto-sweep + crash-sweep are
      // the v3 action's, byte for byte. The differences:
      //   - Pre-fund covers ONE proof buffer (non-uniform: the circuit-7 proof's
      //     own size, ~79 KB — see `unshieldDenominatedStarkV4` for why the
      //     uniform pipeline cannot verify circuit 7)
      //   - 78 upload chunks instead of the pair's 148
      //   - No `emergency` flag: v4 has no min_epoch field
      // ------------------------------------------------------------------
      prepareUnshieldNoteV4: async (noteId, prove, onProgress) => {
        if (_starkOpInFlight || get().isLoading) {
          console.warn('[DenomStore] prepareUnshieldNoteV4 ignored — another STARK op in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status === 'locked') throw new Error('Note is locked in an active privacy route');
        if (note.poolVersion !== 'v3') {
          throw new Error('prepareUnshieldNoteV4 called with non-v3 note — circuit 7 spends v3-pool notes only');
        }

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('V3 pool config not found for this note');

        // Defence in depth. The router asks this synchronously BEFORE calling
        // here, so on the routed path this never fires; a caller that skips the
        // router must still not prove a pre-blinding note on circuit 7.
        const refusal = whyCircuit7Cannot(receipt);
        if (refusal !== null) throw new V4Unprovable(refusal);

        const report = (step: string) => {
          onProgress?.(step);
          set({ progress: step });
        };

        set({ isProving: true, error: null, progress: 'Generating stealth recipient...' });
        try {
          // Derive the ECDH stealth recipient FIRST: circuit 7 binds
          // sha256(recipient) into its transcript, so the proof cannot exist
          // before the payee does. Same derivation as the v3 action.
          const metaAddr = await getMetaAddress();
          const parsed = parseMetaAddress(metaAddr);
          const stealthResult = genStealth(parsed.spendingPubKey, parsed.viewingPubKey, parsed.kemPubKey);
          const stealthRecipient = new PublicKey(stealthResult.address);
          console.log(`[DenomStore/V4] Stealth recipient: ${stealthRecipient.toBase58().slice(0, 12)}... (wallet hidden)`);

          const connection = getConnection();
          const prepared = await prepareUnshieldV4(receipt, stealthRecipient, pool, connection, prove, report);
          return {
            noteId,
            prepared,
            stealth: stealthResult,
            stealthRecipient: stealthRecipient.toBase58(),
          };
        } finally {
          set({ isProving: false, progress: null });
        }
      },

      unshieldNoteStarkV4: async (noteId, recipientAddress, spend) => {
        if (_starkOpInFlight || get().isLoading) {
          console.warn('[DenomStore] unshieldNoteStarkV4 ignored — another STARK op in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        if (spend.noteId !== noteId) {
          throw new Error(
            `unshieldNoteStarkV4: this proof was prepared for note ${spend.noteId}, not ${noteId}.`,
          );
        }
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status === 'locked') throw new Error('Note is locked in an active privacy route');
        if (note.poolVersion !== 'v3') {
          throw new Error('unshieldNoteStarkV4 called with non-v3 note — circuit 7 spends v3-pool notes only');
        }

        const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('V3 pool config not found for this note');

        // Pre-flight: STARK PDA already on-chain → already spent. The nullifier
        // is the proof's first public input, exactly as on the pair.
        try {
          const preStarkNull = spend.prepared.nullifierGoldilocks;
          if (preStarkNull !== 0n) {
            const [prePda] = deriveNullifierPDA(
              pool.poolPDA,
              goldilocksNullifierToBytes(preStarkNull),
            );
            const preConn = getConnection();
            const preAcct = await preConn.getAccountInfo(prePda);
            if (preAcct !== null) {
              set(state => ({
                notes: state.notes.map(n =>
                  n.id === noteId ? { ...n, status: 'spent' as NoteStatus } : n,
                ),
              }));
              throw new Error('Note already spent on-chain');
            }
          }
        } catch (e) {
          if ((e as Error).message === 'Note already spent on-chain') throw e;
          // Network glitch — fall through; the on-chain `init` constraint is
          // still the authoritative double-spend guard.
        }

        _starkOpInFlight = true;
        console.log(
          `[P01_UI] ${JSON.stringify({
            ts: new Date().toISOString(),
            event: 'unshieldStarkV4-flow-begin',
            noteId,
          })}`,
        );
        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing V4 STARK unshield...' });

        let stealthKp: SolKeypair | null = null;
        // Pre-fix address for the same operation. Held so the crash-sweep can
        // recover an attempt that was funded before the derivation was fixed.
        let legacyStealthKp: SolKeypair | null = null;

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const PK = PublicKey;

          // The recipient the proof is bound to. Derived in `prepareUnshieldNoteV4`;
          // `unshieldDenominatedStarkV4` re-checks it against the proof.
          const stealthRecipient = new PK(spend.stealthRecipient);

          // Deterministic per-note ephemeral signer (resumable on crash), keyed
          // on the wallet's SECRET seed — see `services/privacy/ephemeralSigner.ts`.
          const walletAddr = walletSigner?.publicKey.toBase58() || recipientAddress;
          const unshieldV4Signers = await deriveStealthSigners(`stealth_unshield_v4_${noteId}`, walletAddr);
          stealthKp = unshieldV4Signers.current;
          legacyStealthKp = unshieldV4Signers.legacy;

          // V4 = ONE proof buffer. Non-uniform upload, so the rent is for the
          // proof's own size (+ the 83-byte header), not UNIFORM_PROOF_SIZE.
          set({ progress: 'Funding ephemeral signer (V4)...' });
          const connection = getConnection();
          const PROOF_DATA_OFFSET_LOCAL = 83;
          const c7Rent = await connection.getMinimumBalanceForRentExemption(
            PROOF_DATA_OFFSET_LOCAL + spend.prepared.c7ProofResult.proofSize,
          );
          // 0.015 SOL margin — covers the confirmable txs + nullifier PDA rent +
          // slippage. Relayer top-up mirrors the v3 action: the wrapper transfers
          // FROM the stealth signer to the relayer ephemeral.
          const settings = await import('./settingsStore').then(m => m.useSettingsStore.getState());
          const RELAYER_TOPUP = settings.relayerV3Enabled ? 40_000_000 : 0;
          const FEE_FUND = c7Rent + 15_000_000 + RELAYER_TOPUP;
          console.log(
            `[Unshield/V4] step1 pre-fund: ${(FEE_FUND / 1e9).toFixed(4)} SOL ` +
            `(c7Rent=${(c7Rent / 1e9).toFixed(4)} for ${spend.prepared.c7ProofResult.proofSize}B proof ` +
            `margin=0.0150 relayerTopup=${(RELAYER_TOPUP / 1e9).toFixed(3)} v3Relayer=${settings.relayerV3Enabled})`,
          );

          const fundSourcePubkey = walletSigner?.publicKey ?? (await getKeypair())?.publicKey;
          if (fundSourcePubkey) {
            const sourceBal = await connection.getBalance(fundSourcePubkey);
            console.log(`[Unshield/V4] step1 source ${fundSourcePubkey.toBase58().slice(0, 8)}… bal=${(sourceBal / 1e9).toFixed(6)} SOL (need ${(FEE_FUND / 1e9).toFixed(6)})`);
            if (sourceBal < FEE_FUND) {
              console.error(`[Unshield/V4] step1 INSUFFICIENT BALANCE — short ${((FEE_FUND - sourceBal) / 1e9).toFixed(6)} SOL`);
            }
          }

          if (walletSigner) {
            const fundTx = new Transaction().add(
              SystemProgram.transfer({ fromPubkey: walletSigner.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND }),
            );
            const { blockhash } = await connection.getLatestBlockhash();
            fundTx.recentBlockhash = blockhash;
            fundTx.feePayer = walletSigner.publicKey;
            const signedFund = await walletSigner.signTransaction(fundTx);
            const fundSig = await connection.sendRawTransaction(signedFund.serialize());
            await connection.confirmTransaction(fundSig, 'confirmed');
            console.log(`[Unshield/V4] step1 fundTx confirmed: ${fundSig.slice(0, 16)}…`);
          } else {
            const kp = await getKeypair();
            if (kp) {
              const fundTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND }),
              );
              const { blockhash } = await connection.getLatestBlockhash();
              fundTx.recentBlockhash = blockhash;
              fundTx.feePayer = kp.publicKey;
              fundTx.sign(kp);
              const fundSig = await connection.sendRawTransaction(fundTx.serialize());
              await connection.confirmTransaction(fundSig, 'confirmed');
              console.log(`[Unshield/V4] step1 fundTx confirmed: ${fundSig.slice(0, 16)}…`);
            }
          }
          const stealthBalAfterFund = await connection.getBalance(stealthKp.publicKey);
          console.log(`[Unshield/V4] step1 stealth ${stealthKp.publicKey.toBase58().slice(0, 8)}… funded bal=${(stealthBalAfterFund / 1e9).toFixed(6)} SOL`);

          // Timing jitter
          const jitter = 1000 + Math.floor(Math.random() * 2000);
          set({ progress: 'Waiting (timing privacy)...' });
          await new Promise(r => setTimeout(r, jitter));

          // Persist the sender-side stealth material BEFORE submitting — same
          // reason as the v3 path: the ephemeral inside it appears in no
          // instruction, so this record is the only thing standing between a
          // process death and a lost denomination.
          {
            const rec = buildPendingStealthSweep({
              noteId,
              poolPDA: pool.poolPDA.toBase58(),
              destination: recipientAddress,
              stealth: spend.stealth,
            });
            set(state => ({
              pendingStealthSweeps: [
                ...state.pendingStealthSweeps.filter(r => r.noteId !== noteId),
                rec,
              ],
            }));
          }

          // V4 unshield — service handles upload + verify + ix + buffer close.
          // ⛔ NOTHING FROM HERE ON MAY FALL BACK TO THE PAIR.
          const sig = await unshieldDenominatedStarkV4(
            pool, stealthRecipient, spend.prepared,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK') || step.includes('circuit-7');
              set({ progress: step, isProving: proving });
            },
            undefined,
            stealthKp,
          );

          // Mark spent immediately so background sweep can't re-trigger
          set(state => ({
            isProving: false,
            progress: 'Sweeping to wallet...',
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          // Sweep the stealth recipient. Same delay as the v3 action, for the
          // same reason: the claim is persisted, so a failure here keeps a
          // retryable record, and `sweepStealthRecipient(noteId, elsewhere)`
          // can send the funds somewhere other than the depositing wallet.
          try {
            const sweepDelay = 3000 + Math.floor(Math.random() * 4000);
            set({ progress: 'Sweeping to wallet (delayed)...' });
            await new Promise(r => setTimeout(r, sweepDelay));

            await get().sweepStealthRecipient(noteId);

            // Drain leftover from signer back to wallet
            const signerBal = await connection.getBalance(stealthKp.publicKey);
            if (signerBal > 5000) {
              const drainTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: stealthKp.publicKey, toPubkey: new PK(recipientAddress), lamports: signerBal - 5000 }),
              );
              const { blockhash } = await connection.getLatestBlockhash();
              drainTx.recentBlockhash = blockhash;
              drainTx.feePayer = stealthKp.publicKey;
              drainTx.sign(stealthKp);
              await connection.sendRawTransaction(drainTx.serialize()).then(s => connection.confirmTransaction(s, 'confirmed'));
            }
          } catch (sweepErr: any) {
            // Only the signer drain can throw now; the recipient sweep records
            // its failure and keeps the claim.
            console.error('[DenomStore/V4] signer drain failed (claim persisted):', sweepErr.message);
          }

          set({ isLoading: false, isProving: false, progress: null });

          useWalletStore.getState().refreshBalance();
          setTimeout(() => useWalletStore.getState().refreshTransactions(), 5000);

          scheduleLocalNotification(
            'Unshield Confirmed',
            `${note.denomination} ${note.token} withdrawn from privacy pool`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          return sig;
        } catch (err) {
          console.error('[DenomPool/V4] STARK unshield error:', err);

          // Crash-sweep — recover ephemeral signer balance. Same retry loop as
          // the v3 action: in-flight upload TXs keep draining the ephemeral
          // after a mid-batch failure, so re-read the balance each attempt.
          if (stealthKp) {
            const connection = getConnection();
            await sweepLegacyStealth(connection, legacyStealthKp, stealthKp.publicKey);
            const FEE_RESERVE = 5000;
            const SWEEP_ATTEMPTS = 5;
            let swept = false;
            for (let a = 0; a < SWEEP_ATTEMPTS && !swept; a++) {
              try {
                if (a > 0) await new Promise(r => setTimeout(r, 2000));
                const stealthBal = await connection.getBalance(stealthKp.publicKey);
                if (stealthBal <= FEE_RESERVE) { swept = true; break; } // nothing to recover
                const sweepAmount = stealthBal - FEE_RESERVE;
                const sweepTx = new Transaction().add(
                  SystemProgram.transfer({
                    fromPubkey: stealthKp.publicKey,
                    toPubkey: new PublicKey(recipientAddress),
                    lamports: sweepAmount,
                  }),
                );
                const { blockhash } = await connection.getLatestBlockhash();
                sweepTx.recentBlockhash = blockhash;
                sweepTx.feePayer = stealthKp.publicKey;
                sweepTx.sign(stealthKp);
                const sweepSig = await connection.sendRawTransaction(sweepTx.serialize());
                await connection.confirmTransaction(sweepSig, 'confirmed');
                console.log(`[DenomStore/V4] 🛟 crash-sweep: ${(sweepAmount / 1e9).toFixed(4)} SOL recovered (attempt ${a + 1})`);
                swept = true;
              } catch (sweepErr: any) {
                if (a === SWEEP_ATTEMPTS - 1) {
                  console.error(
                    `[DenomStore/V4] ❌ crash-sweep FAILED after ${SWEEP_ATTEMPTS} attempts — funds at ${stealthKp.publicKey.toBase58()} (re-run this note's unshield to recover; ephemeral is deterministically derived):`,
                    sweepErr.message,
                  );
                }
              }
            }
          }

          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Unshield Failed',
            `Failed to withdraw ${note.denomination} ${note.token}: ${(err as Error).message}`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        } finally {
          _starkOpInFlight = false;
        }
      },

      // ------------------------------------------------------------------
      // STARK Transfer Note (quantum-resistant, peer-to-peer)
      // ------------------------------------------------------------------

      transferNoteStark: async (noteId, starkProofData) => {
        if (get().isLoading) {
          console.warn('[DenomStore] transferNoteStark ignored — another operation in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status === 'locked') throw new Error('Note is locked in an active privacy route');
        if (note.status !== 'mature') throw new Error('Note must be mature for transfer');

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing STARK transfer...' });

        // Hoisted for crash-sweep (see catch block).
        let stealthKp: SolKeypair | null = null;
        // Pre-fix address for the same operation. Held so the crash-sweep can
        // recover an attempt that was funded before the derivation was fixed.
        let legacyStealthKp: SolKeypair | null = null;

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const walletAddr = walletSigner?.publicKey.toBase58()
            || useWalletStore.getState().publicKey || '';

          // Deterministic per-note ephemeral signer, keyed on the wallet's
          // SECRET seed — reproducible after a crash, unpredictable to an
          // observer. See `services/privacy/ephemeralSigner.ts`.
          const transferSigners = await deriveStealthSigners(`stealth_transfer_stark_${noteId}`, walletAddr);
          stealthKp = transferSigners.current;
          legacyStealthKp = transferSigners.legacy;

          // Fund stealth for STARK buffer rent + tx fees (dynamic from proof size).
          // Buffer rent refunded on close_proof_buffer; leftover swept back. Net ~0.002 SOL.
          set({ progress: 'Funding stealth signer...' });
          const connection = getConnection();
          const PROOF_DATA_OFFSET_LOCAL = 83;
          const bufferRent = await connection.getMinimumBalanceForRentExemption(PROOF_DATA_OFFSET_LOCAL + starkProofData.proofSize);
          const FEE_FUND = bufferRent + 10_000_000; // + 0.01 SOL for tx fees + nullifier PDA + margin
          console.log(`[DenomStore] Transfer pre-fund: ${(FEE_FUND / 1e9).toFixed(4)} SOL (rent=${(bufferRent / 1e9).toFixed(4)} for ${starkProofData.proofSize}B proof)`);
          if (walletSigner) {
            const fundTx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: walletSigner.publicKey,
                toPubkey: stealthKp.publicKey,
                lamports: FEE_FUND,
              })
            );
            const { blockhash } = await connection.getLatestBlockhash();
            fundTx.recentBlockhash = blockhash;
            fundTx.feePayer = walletSigner.publicKey;
            const signedFund = await walletSigner.signTransaction(fundTx);
            const fundSig = await connection.sendRawTransaction(signedFund.serialize());
            await connection.confirmTransaction(fundSig, 'confirmed');
          } else {
            const keypair = await getKeypair();
            if (keypair) {
              const fundTx = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: keypair.publicKey,
                  toPubkey: stealthKp.publicKey,
                  lamports: FEE_FUND,
                })
              );
              await sendAndConfirmTransaction(connection, fundTx, [keypair], { commitment: 'confirmed' });
            }
          }

          // Timing jitter (1-3s)
          const jitter = 1000 + Math.floor(Math.random() * 2000);
          set({ progress: 'Waiting (timing privacy)...' });
          await new Promise(r => setTimeout(r, jitter));

          const { txSig, recipientNote } = await serviceTransferNoteStark(
            receipt,
            pool,
            starkProofData,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK');
              set({ progress: step, isProving: proving });
            },
            undefined,
            stealthKp,
          );

          const encoded = encodeShareableNote(recipientNote);

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
          console.error('[DenomPool] STARK transfer error:', err);

          // Crash-sweep — same rationale as the unshield path.
          const walletAddrForSweep = useWalletStore.getState().publicKey; // Privy removed — local keypair only
          if (stealthKp && walletAddrForSweep) {
            try {
              const connection = getConnection();
              // Pull back a pre-derivation-fix attempt's funds first.
              await sweepLegacyStealth(connection, legacyStealthKp, stealthKp.publicKey);
              const stealthBal = await connection.getBalance(stealthKp.publicKey);
              const FEE_RESERVE = 5000;
              if (stealthBal > FEE_RESERVE) {
                const sweepAmount = stealthBal - FEE_RESERVE;
                const sweepTx = new Transaction().add(
                  SystemProgram.transfer({
                    fromPubkey: stealthKp.publicKey,
                    toPubkey: new PublicKey(walletAddrForSweep),
                    lamports: sweepAmount,
                  }),
                );
                const { blockhash } = await connection.getLatestBlockhash();
                sweepTx.recentBlockhash = blockhash;
                sweepTx.feePayer = stealthKp.publicKey;
                sweepTx.sign(stealthKp);
                const sweepSig = await connection.sendRawTransaction(sweepTx.serialize());
                await connection.confirmTransaction(sweepSig, 'confirmed');
                console.log(`[DenomStore] 🛟 crash-sweep (transfer): ${(sweepAmount / 1e9).toFixed(4)} SOL recovered → ${walletAddrForSweep.slice(0, 12)}… sig=${sweepSig.slice(0, 16)}…`);
              }
            } catch (sweepErr: any) {
              console.error(
                `[DenomStore] ❌ transfer crash-sweep FAILED — funds stuck at ${stealthKp.publicKey.toBase58()}:`,
                sweepErr.message,
              );
            }
          }

          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // STARK Transfer Note V3 (4-tx: C1 + C3 + C6 + transfer_v3)
      // ------------------------------------------------------------------

      transferNoteStarkV3: async (noteId, c1ProofData, c3ProofData, c6ProofData, insertParams, walk) => {
        if (get().isLoading) {
          console.warn('[DenomStore] transferNoteStarkV3 ignored — another operation in progress');
          throw new Error('Another shield/unshield is already in progress. Please wait.');
        }
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status === 'locked') throw new Error('Note is locked in an active privacy route');
        if (note.status !== 'mature') throw new Error('Note must be mature for transfer');
        if (note.poolVersion !== 'v3') {
          throw new Error('transferNoteStarkV3 called with non-v3 note — use transferNoteStark for v2');
        }

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('V3 pool config not found for this note');

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing V3 STARK transfer...' });

        // Hoisted for crash-sweep (mirrors v2 transferNoteStark).
        let stealthKp: SolKeypair | null = null;
        // Pre-fix address for the same operation. Held so the crash-sweep can
        // recover an attempt that was funded before the derivation was fixed.
        let legacyStealthKp: SolKeypair | null = null;

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const walletAddr = walletSigner?.publicKey.toBase58()
            || useWalletStore.getState().publicKey || '';

          // Deterministic per-note stealth signer — namespace differs from v2
          // so a v2/v3 collision on the same noteId can't happen. Keyed on the
          // wallet's SECRET seed; see `services/privacy/ephemeralSigner.ts`.
          const transferV3Signers = await deriveStealthSigners(`stealth_transfer_v3_${noteId}`, walletAddr);
          stealthKp = transferV3Signers.current;
          legacyStealthKp = transferV3Signers.legacy;

          // V3 transfer = THREE proof buffers (C1 + C3 + C6). Pre-fund covers
          // all three rents + nullifier PDA + tx fees. Buffers are closed in
          // the service `finally` so net cost ≈ 0.003 SOL.
          // Add an extra 40M lamports when the V3 relayer wrapper is enabled
          // (mirrors unshieldNoteStarkV3) so the stealth signer can fund the
          // relay-job ephemeral (jobFee + jobRent + N*chunkRent + txFees +
          // ephemeralRentMin — up to 4 chunks for v2 hybrid envelope) without
          // adding a new main-wallet → ephemeral direct link.
          set({ progress: 'Funding stealth signer (V3)...' });
          const connection = getConnection();
          const PROOF_DATA_OFFSET_LOCAL = 83;
          const { UNIFORM_PROOF_SIZE } = await import('../services/stark');
          // Phase C v1: 3 proof buffers all padded to UNIFORM_PROOF_SIZE.
          const cRent = await connection.getMinimumBalanceForRentExemption(PROOF_DATA_OFFSET_LOCAL + UNIFORM_PROOF_SIZE);
          const c1Rent = cRent;
          const c3Rent = cRent;
          const c6Rent = cRent;
          const settings = await import('./settingsStore').then(m => m.useSettingsStore.getState());
          const RELAYER_TOPUP = settings.relayerV3Enabled ? 40_000_000 : 0;
          // 0.02 SOL margin — covers 5 confirmable txs (init+upload×3 + transfer + close×3),
          // nullifier PDA rent, and rate-limit retries.
          const FEE_FUND = c1Rent + c3Rent + c6Rent + 20_000_000 + RELAYER_TOPUP;
          console.log(
            `[DenomStore/V3] Transfer pre-fund: ${(FEE_FUND / 1e9).toFixed(4)} SOL ` +
            `(c1=${(c1Rent / 1e9).toFixed(4)} c3=${(c3Rent / 1e9).toFixed(4)} c6=${(c6Rent / 1e9).toFixed(4)} ` +
            `relayerTopup=${(RELAYER_TOPUP / 1e9).toFixed(3)})`,
          );

          if (walletSigner) {
            const fundTx = new Transaction().add(
              SystemProgram.transfer({ fromPubkey: walletSigner.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND }),
            );
            const { blockhash } = await connection.getLatestBlockhash();
            fundTx.recentBlockhash = blockhash;
            fundTx.feePayer = walletSigner.publicKey;
            const signedFund = await walletSigner.signTransaction(fundTx);
            await connection.sendRawTransaction(signedFund.serialize()).then(s => connection.confirmTransaction(s, 'confirmed'));
          } else {
            const kp = await getKeypair();
            if (kp) {
              const fundTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: stealthKp.publicKey, lamports: FEE_FUND }),
              );
              await sendAndConfirmTransaction(connection, fundTx, [kp], { commitment: 'confirmed' });
            }
          }

          // Timing jitter (1-3s)
          const jitter = 1000 + Math.floor(Math.random() * 2000);
          set({ progress: 'Waiting (timing privacy)...' });
          await new Promise(r => setTimeout(r, jitter));

          const { txSig, recipientNote } = await serviceTransferDenominatedStarkV3(
            receipt,
            pool,
            c1ProofData,
            c3ProofData,
            c6ProofData,
            insertParams,
            walk,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK') || step.includes('C1') || step.includes('C3') || step.includes('C6');
              set({ progress: step, isProving: proving });
            },
            undefined,
            stealthKp,
          );

          const encoded = encodeShareableNote(recipientNote);

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
          console.error('[DenomPool/V3] STARK transfer error:', err);

          // Crash-sweep stranded stealth balance back to the user wallet.
          const walletAddrForSweep = useWalletStore.getState().publicKey; // Privy removed — local keypair only
          if (stealthKp && walletAddrForSweep) {
            try {
              const connection = getConnection();
              // Pull back a pre-derivation-fix attempt's funds first.
              await sweepLegacyStealth(connection, legacyStealthKp, stealthKp.publicKey);
              const stealthBal = await connection.getBalance(stealthKp.publicKey);
              const FEE_RESERVE = 5000;
              if (stealthBal > FEE_RESERVE) {
                const sweepAmount = stealthBal - FEE_RESERVE;
                const sweepTx = new Transaction().add(
                  SystemProgram.transfer({
                    fromPubkey: stealthKp.publicKey,
                    toPubkey: new PublicKey(walletAddrForSweep),
                    lamports: sweepAmount,
                  }),
                );
                const { blockhash } = await connection.getLatestBlockhash();
                sweepTx.recentBlockhash = blockhash;
                sweepTx.feePayer = stealthKp.publicKey;
                sweepTx.sign(stealthKp);
                const sweepSig = await connection.sendRawTransaction(sweepTx.serialize());
                await connection.confirmTransaction(sweepSig, 'confirmed');
                console.log(`[DenomStore/V3] 🛟 crash-sweep (transfer V3): ${(sweepAmount / 1e9).toFixed(4)} SOL recovered → ${walletAddrForSweep.slice(0, 12)}… sig=${sweepSig.slice(0, 16)}…`);
              }
            } catch (sweepErr: any) {
              console.error(
                `[DenomStore/V3] ❌ transfer V3 crash-sweep FAILED — funds stuck at ${stealthKp.publicKey.toBase58()}:`,
                sweepErr.message,
              );
            }
          }

          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // STARK Split Note (quantum-resistant, cross-denomination)
      // ------------------------------------------------------------------

      splitNoteStark: async (noteId, targetPoolPDA, outputSecrets, starkProofData, c3ProofData, walk) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status === 'locked') throw new Error('Note is locked in an active privacy route');
        if (note.status !== 'mature') throw new Error('Note must be mature for split');

        const receipt = readReceipt(note.receiptJSON);
        // split_note_stark's C3 (merkle_path) proof binds the SOURCE note's
        // Goldilocks commitment to a root in source_pool.historical_roots, so
        // a V3 source note must resolve to its V3 pool (not just V2). Check
        // both generations; V3 first (the future default).
        const findAnyPool = (pda: string) =>
          ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === pda)
            ?? ALL_POOLS.find(p => p.poolPDA.toBase58() === pda);
        const sourcePool = findAnyPool(note.poolPDA);
        const targetPool = findAnyPool(targetPoolPDA);
        if (!sourcePool) throw new Error('Source pool config not found');
        if (!targetPool) throw new Error('Target pool config not found');
        if (!sourcePool.tokenMint.equals(targetPool.tokenMint)) {
          throw new Error('Source and target pools must use the same token');
        }

        const numOutputs = Number(sourcePool.denominationAtomic / targetPool.denominationAtomic);
        if (outputSecrets.length !== numOutputs) {
          throw new Error(`Expected ${numOutputs} output secrets, got ${outputSecrets.length}`);
        }

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing STARK split...' });

        try {
          const walletSigner: WalletSigner | undefined = undefined; // Privy removed — local keypair only
          const { txSignature, outputCommitments, outputNullifierPreimages } = await serviceSplitNoteStark(
            sourcePool,
            targetPool,
            receipt,
            numOutputs,
            outputSecrets,
            starkProofData,
            c3ProofData,
            walk,
            walletSigner,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK');
              set({ progress: step, isProving: proving });
            },
          );

          // Import the output notes into the wallet as fresh 'pending' notes.
          // The user owns all of them — this is a denomination conversion.
          const slot = await getConnection().getSlot('confirmed');
          const depositEpoch = slotToEpoch(slot);
          const newNotes: StoredNote[] = outputCommitments.map((commitment, i) => {
            const outputReceipt: ShieldReceipt = {
              secret: outputSecrets[i],
              nullifierPreimage: outputNullifierPreimages[i],
              depositEpoch,
              tokenMint: receipt.tokenMint,
              commitment,
              leafIndex: -1,
              denomination: targetPool.denominationAtomic,
              pool: targetPool.poolPDA.toBase58(),
              token: targetPool.token,
              denominationHuman: targetPool.denomination,
              shieldedAt: Date.now(),
            };
            return {
              id: noteIdFromReceipt(outputReceipt),
              receiptJSON: secureReceipt(outputReceipt),
              token: targetPool.token,
              denomination: targetPool.denomination,
              poolPDA: targetPool.poolPDA.toBase58(),
              shieldedAt: Date.now(),
              status: 'pending' as NoteStatus,
              source: 'shielded' as NoteSource,
              cluster: getCluster(),
            };
          });

          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: [
              ...newNotes,
              ...state.notes.map(n =>
                n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: txSignature } : n
              ),
            ],
          }));

          return { txSignature, outputCommitments };
        } catch (err) {
          console.error('[DenomPool] STARK split error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Re-shielded notes (from subscription cancel)
      // ------------------------------------------------------------------

      addReshieldedNotes: (receipts, pool) => {
        if (receipts.length === 0) return;
        const newNotes: StoredNote[] = receipts.map(receipt => ({
          id: noteIdFromReceipt(receipt),
          receiptJSON: secureReceipt(receipt),
          token: pool.token,
          denomination: pool.denomination,
          poolPDA: pool.poolPDA.toBase58(),
          shieldedAt: receipt.shieldedAt || Date.now(),
          status: 'pending' as NoteStatus,
          source: 'shielded' as NoteSource,
          cluster: getCluster(),
        }));
        set(state => ({ notes: [...newNotes, ...state.notes], error: null }));
      },

      // ------------------------------------------------------------------
      // Note import/export (backup & sharing)
      // ------------------------------------------------------------------

      importNote: (encodedNote, source: NoteSource = 'received') => {
        console.log('[DenomStore] importNote called, source:', source, 'dataLen:', encodedNote.length);
        try {
          const noteData = decodeShareableNote(encodedNote);
          const receipt = serviceImportNote(noteData);
          // V3 first — peer-to-peer V3 transfers (and any future V3 share)
          // land in this branch. Falling back to v2 keeps the legacy receive
          // flow working until v2 deprecation.
          const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === noteData.pool)
            ?? ALL_POOLS.find(p => p.poolPDA.toBase58() === noteData.pool);
          if (!pool) throw new Error('Unknown pool');

          const storedNote: StoredNote = {
            id: noteIdFromReceipt(receipt),
            receiptJSON: secureReceipt(receipt),
            token: noteData.token,
            denomination: noteData.denominationHuman,
            poolPDA: noteData.pool,
            // Stamp pool generation so the unshield/transfer screens route to
            // the right ix variant. Without this, a V3-imported note would
            // attempt v2 unshield → on-chain reject (wrong pool seed).
            poolVersion: pool.version === 'v3' ? 'v3' : 'v2',
            shieldedAt: receipt.shieldedAt || Date.now(),
            status: 'imported',
            source,
            cluster: getCluster(),
          };

          // Check if note already exists
          const existing = get().notes.find(n => n.id === storedNote.id);
          if (existing) {
            // If the existing note was transferred out, replace it with the incoming one
            if (existing.status === 'transferred') {
              set(state => ({
                notes: state.notes.map(n =>
                  n.id === storedNote.id ? storedNote : n
                ),
                error: null,
              }));
            } else {
              throw new Error('This note already exists in your wallet');
            }
          } else {
            set(state => ({
              notes: [storedNote, ...state.notes],
              error: null,
            }));
          }
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
            const receipt = readReceipt(n.receiptJSON);
            const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === n.poolPDA)
              ?? ALL_POOLS.find(p => p.poolPDA.toBase58() === n.poolPDA);
            if (!pool) return '';
            return encodeShareableNote(serviceExportNote(receipt, pool));
          })
          .filter(Boolean);
      },

      exportNote: (noteId) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA)
          ?? ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found');
        return encodeShareableNote(serviceExportNote(receipt, pool));
      },

      rescanPool: async (poolPDA, opts) => {
        const cluster = getCluster();
        // Scan BOTH v2 and v3 pools. The two have different commitment hash
        // functions (BN254 vs Goldilocks) so each pool is dispatched to its
        // own rescanPoolFromSeed* helper below.
        const allPoolsCombined = [...ALL_POOLS, ...ALL_POOLS_V3];
        const targetPools = poolPDA
          ? allPoolsCombined.filter(p => p.poolPDA.toBase58() === poolPDA)
          : allPoolsCombined;
        if (targetPools.length === 0) {
          throw new Error('No pool to rescan');
        }

        // Resolve seed from the local keypair (offline, gold path). The former
        // Privy fallbacks (persisted note seed + signMessage derivation) were
        // removed with Privy (spec §3 Phase 1) — every wallet is a local keypair.
        let walletSeed: Uint8Array | null = null;
        try {
          ({ noteSeed: walletSeed } = await deriveLocalNoteSeed());
        } catch {
          walletSeed = null;
        }
        if (!walletSeed) {
          throw new Error('No wallet seed available — cannot rescan');
        }

        const connection = getConnection();
        const slot = await connection.getSlot('confirmed');
        const currentEpoch = slotToEpoch(slot);
        const epochsBack = BigInt(opts?.epochsBack ?? 50);
        const epochs: bigint[] = [];
        for (let e = 0n; e <= epochsBack; e++) {
          const ep = currentEpoch - e;
          if (ep >= 0n) epochs.push(ep);
        }
        const maxCounter = opts?.maxCounter ?? 256;
        const maxSignatures = opts?.maxSignatures ?? 1000;

        let totalRecovered = 0;

        console.log(`[Rescan] start — pools=${targetPools.length} epochs=${epochs.length} maxCounter=${maxCounter} maxSignatures=${maxSignatures}`);

        for (const pool of targetPools) {
          const label = `${pool.token} ${pool.denomination}`;
          try {
            set({ progress: `Scanning ${label} pool...` });
            console.log(`[Rescan] ${label} — fetching on-chain commitments`);
            const onChain = await fetchPoolCommitments(connection, pool.poolPDA, {
              maxSignatures,
              onProgress: (scanned, total) => {
                set({ progress: `Scanning ${label}: ${scanned}/${total} txs` });
              },
            });
            console.log(`[Rescan] ${label} — ${onChain.size} commitments on-chain`);
            if (onChain.size === 0) continue;

            const isV3 = pool.version === 'v3';
            const rescanFn = isV3 ? rescanPoolFromSeedV3 : rescanPoolFromSeed;
            const matches = rescanFn({
              walletSeed,
              poolPDA: pool.poolPDA,
              tokenMints: [pool.tokenMint],
              epochs,
              maxCounter,
              knownCommitments: new Set(onChain.keys()),
            });
            console.log(`[Rescan] ${label} — ${matches.length} seed matches`);
            if (matches.length === 0) continue;

          const tokenMintField = (() => {
            const bytes = pool.tokenMint.toBytes();
            let n = 0n;
            for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
            return n;
          })();

          const existingIds = new Set(get().notes.map(n => n.id));
          const newNotes: StoredNote[] = [];
          let highestCounter = get().shieldCounters[pool.poolPDA.toBase58()] ?? 0;

          for (const m of matches) {
            const onChainEntry = onChain.get(m.commitment.toString());
            if (!onChainEntry) continue;
            const receipt: ShieldReceipt = {
              secret: m.secret,
              nullifierPreimage: m.nullifierPreimage,
              depositEpoch: m.depositEpoch,
              tokenMint: tokenMintField,
              commitment: m.commitment,
              leafIndex: onChainEntry.leafIndex,
              denomination: pool.denominationAtomic,
              pool: pool.poolPDA.toBase58(),
              token: pool.token,
              denominationHuman: pool.denomination,
              shieldedAt: Date.now(),
            };
            const id = noteIdFromReceipt(receipt);
            if (existingIds.has(id)) continue;
            newNotes.push({
              id,
              receiptJSON: secureReceipt(receipt),
              token: pool.token,
              denomination: pool.denomination,
              poolPDA: pool.poolPDA.toBase58(),
              shieldedAt: Date.now(),
              status: 'pending' as NoteStatus,
              source: 'shielded' as NoteSource,
              cluster,
              recoveredAt: Date.now(),
              // Stamp the pool version so the unshield path routes to the
              // correct (v2 or v3) STARK ix at spend time.
              poolVersion: pool.version === 'v3' ? 'v3' : 'v2',
            });
            if (m.counter + 1 > highestCounter) highestCounter = m.counter + 1;
          }

          if (newNotes.length > 0) {
            set(state => ({
              notes: [...newNotes, ...state.notes],
              shieldCounters: {
                ...state.shieldCounters,
                [pool.poolPDA.toBase58()]: highestCounter,
              },
            }));
            totalRecovered += newNotes.length;
            console.log(`[Rescan] ${label} — recovered ${newNotes.length} note(s)`);
          }
          } catch (err: any) {
            console.warn(`[Rescan] ${label} — FAILED:`, err?.message ?? String(err));
          }
        }

        console.log(`[Rescan] done — totalRecovered=${totalRecovered}`);
        set({ progress: null });
        // Promote any rescued notes that are already past maturity
        try { await get().refreshNoteStatuses(); } catch {}
        return totalRecovered;
      },

      sweepStealthRecipient: async (noteId, destinationOverride) => {
        const record = get().pendingStealthSweeps.find(r => r.noteId === noteId);
        if (!record) return 0;
        const outcome = await executeStealthSweep(getConnection(), record, destinationOverride);
        set(state => ({
          pendingStealthSweeps: outcome.settled
            ? state.pendingStealthSweeps.filter(r => r.noteId !== noteId)
            : state.pendingStealthSweeps.map(r =>
                r.noteId === noteId ? { ...r, lastError: outcome.error } : r,
              ),
        }));
        if (outcome.settled) {
          console.log(
            `[DenomStore] stealth sweep settled for ${noteId}: ${(outcome.swept / 1e9).toFixed(6)} SOL` +
              (outcome.signature ? ` sig=${outcome.signature.slice(0, 16)}…` : ' (already empty)'),
          );
        } else {
          console.warn(
            `[DenomStore] stealth sweep NOT settled for ${noteId} — record kept, funds remain at ` +
              `${record.stealthAddress}: ${outcome.error}`,
          );
        }
        return outcome.swept;
      },

      retryPendingStealthSweeps: async () => {
        const pending = [...get().pendingStealthSweeps];
        let total = 0;
        for (const rec of pending) {
          total += await get().sweepStealthRecipient(rec.noteId);
        }
        return total;
      },

      resetOperationState: () => {
        const wasInFlight = _starkOpInFlight;
        const prev = get();
        const stack = (new Error().stack || '').split('\n').slice(2, 8).join(' | ');
        console.log(
          `[P01_UI] ${JSON.stringify({
            ts: new Date().toISOString(),
            event: 'resetOperationState-called',
            wasStarkOpInFlight: wasInFlight,
            prevIsLoading: prev.isLoading,
            prevIsProving: prev.isProving,
            prevProgress: prev.progress,
            stack,
          })}`,
        );
        _starkOpInFlight = false;
        set({ isLoading: false, isProving: false, progress: null, error: null });
      },

      reset: () => {
        const wasInFlight = _starkOpInFlight;
        const prev = get();
        const stack = (new Error().stack || '').split('\n').slice(2, 8).join(' | ');
        console.log(
          `[P01_UI] ${JSON.stringify({
            ts: new Date().toISOString(),
            event: 'reset-called',
            wasStarkOpInFlight: wasInFlight,
            prevIsLoading: prev.isLoading,
            prevIsProving: prev.isProving,
            prevProgress: prev.progress,
            prevNotesCount: prev.notes.length,
            stack,
          })}`,
        );
        _starkOpInFlight = false;
        set({
          notes: [],
          selectedToken: 'SOL',
          selectedDenomination: null,
          shieldCounters: {},
          // pendingStealthSweeps is deliberately NOT cleared. Notes survive a
          // reset because `rescanPool` re-derives them from the wallet seed; a
          // stealth recipient's key CANNOT be re-derived from anything — the
          // sender-side ephemeral was random and is not on chain — so dropping
          // these records destroys the only route to money already withdrawn.
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
      version: 4,
      storage: createJSONStorage(() => encryptedStorage),
      partialize: (state) => ({
        notes: state.notes,
        selectedToken: state.selectedToken,
        shieldCounters: state.shieldCounters,
        // MUST be persisted. It is the only copy of the sender-side material
        // that reconstructs a stealth recipient's private key; dropping it here
        // would restore the fund-loss window described in
        // `services/privacy/stealthSweep.ts`.
        pendingStealthSweeps: state.pendingStealthSweeps,
      }),
      migrate: (persistedState: any, version: number) => {
        const state = persistedState as any;
        if (version < 4 && state.notes) {
          // v3 → v4: fix incorrectly locked notes from old auto-lock bug
          console.log('[DenomPool] Migration v4: unlocking', state.notes.filter((n: any) => n.status === 'locked').length, 'notes');
          state.notes = state.notes.map((n: any) =>
            n.status === 'locked' ? { ...n, status: 'pending' } : n
          );
        }
        return state;
      },
    },
  ),
);

/**
 * Notes filtered to the currently-connected wallet. Notes belonging to a
 * different identity (ownerPubkey mismatch) stay on disk but are hidden from
 * the UI — they would be unspendable anyway (secrets are derived from the
 * owner's seed), and showing them would leak the existence of prior users to
 * whoever is logged in now. Legacy notes with no ownerPubkey are still shown
 * to everyone (backward-compat for pre-isolation shields).
 */
export function useActiveNotes(): StoredNote[] {
  const notes = useDenominatedPoolStore(s => s.notes);
  const publicKey = useWalletStore(s => s.publicKey);
  const filtered = !publicKey
    ? notes.filter(n => !n.ownerPubkey)
    : notes.filter(n => !n.ownerPubkey || n.ownerPubkey === publicKey);
  if (__DEV__ && notes.length > 0 && filtered.length === 0) {
    console.warn(
      `[useActiveNotes] store has ${notes.length} notes but 0 visible — publicKey=${publicKey?.slice(0, 8) ?? 'none'}, note owners:`,
      notes.map(n => n.ownerPubkey?.slice(0, 8) ?? 'none'),
    );
  }
  return filtered;
}
