/**
 * STARK Proof Service for Mobile
 *
 * Quantum-resistant STARK proof generation and on-chain verification.
 * Uses the p01_stark_verifier Solana program for subscriber ownership proofs.
 *
 * Proof generation: Rust WASM module in WebView (Goldilocks field, Blake3 Merkle)
 * On-chain verification: ~900K CU, hash-based (no ECC, PQ-safe)
 *
 * Program ID: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 */

import {
  Connection,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
} from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import { getKeypair } from '../solana/wallet';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STARK_VERIFIER_PROGRAM_ID = new PublicKey(
  'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs'
);

const CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;
const CIRCUIT_POOL_COMMITMENT = 1;
const CIRCUIT_BALANCE_PROOF = 2;
const CIRCUIT_MERKLE_PATH = 3;
const CIRCUIT_CONFIDENTIAL_BALANCE = 4;
const CIRCUIT_TRANSFER = 5;
const CIRCUIT_MERKLE_UPDATE = 6;
const MAX_CHUNK_SIZE = 1000; // ~1000 bytes per chunk (fits in 1232-byte tx limit)

// Instruction discriminators (from Anchor IDL)
const DISCRIMINATORS = {
  initProofBuffer: Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  resizeProofBuffer: Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]),
  writeProofChunk: Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]),
  verifyStarkProof: Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]),
  verifyStarkProofV2: Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]),
  verifyDeepAliPhase2: Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]),
  closeProofBuffer: Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]),
  // Phase C v1 (deployed 2026-05-07) — uniform STARK upload pipeline.
  initProofBufferV2: Buffer.from([195, 42, 231, 101, 125, 247, 122, 16]),
  verifyUniform: Buffer.from([132, 164, 86, 87, 3, 165, 212, 103]),
};

const PROOF_DATA_OFFSET = 83; // 8 disc + 32 pubkey + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified
const MAX_INIT_SIZE = 10_240; // Solana create_account limit
const MAX_REALLOC_STEP = 10_240; // Solana MAX_PERMITTED_DATA_INCREASE per realloc call

/** Phase C v1 — uniform proof size target. Padded zero bytes are tolerated by
 * the verifier's `from_bytes` (lower-bound length checks only).
 *
 * Sized to fit the largest active circuit (C3/C5/C6 ~ 138-140KB) plus headroom.
 * Closes leaks L13 (circuit_id at init) + L14 (proof_size variable).
 *
 * Cost: ~1.01 SOL transient rent per flow (refunded on close). 14 resize tx
 * @ ~5000 lamports each = ~0.07 SOL net.
 *
 * Exported so V3 store pre-fund logic uses the SAME size for rent calculation
 * (the buffer is reallocated to UNIFORM_PROOF_SIZE regardless of the actual
 * proof bytes — pre-funding for the actual size leaves the ephemeral
 * underfunded by the padding's rent). */
export const UNIFORM_PROOF_SIZE = 145_000;

/** SPL Memo program v2 — used to disambiguate resize tx (Phase C v1.1).
 * Each resize tx prepends a memo ix with a 4-byte LE counter, making the tx
 * envelopes byte-different WITHOUT using the leaky `microLamports: i+1`
 * priority fingerprint. The Memo program ID `MemoSq4...` appears in millions
 * of unrelated tx (NFT mints, DAO votes, etc.) so it doesn't fingerprint P01.
 */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Build a memo ix with a 4-byte LE counter as payload. Keeps tx serialized
 * bytes unique across the resize loop without needing the microLamports
 * priority counter. */
function buildMemoCounterIx(counter: number): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(counter, 0);
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data,
  });
}

/** Phase C v1.1 — fixed CU price for ALL stark verifier tx. Replaces the
 * leaky `microLamports: i+1` priority counter with a constant. */
const UNIFORM_CU_PRICE_MICROLAMPORTS = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactStarkProof {
  proofBytes: Uint8Array;
  commitment: bigint;
  proofSize: number;
}

/** Generic proof for new circuits (pool, balance, merkle path) */
export interface GenericStarkProof {
  proofBytes: Uint8Array;
  circuitId: number;
  publicInputs: bigint[];
  proofSize: number;
}

export interface StarkVerificationResult {
  verified: boolean;
  txSignature: string;
  commitment: bigint;
  proofSize: number;
  computeUnits?: number;
}

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

/**
 * Adapt a Keypair into the WalletSigner interface so an ephemeral keypair can
 * drive the STARK upload pipeline without a user wallet prompt per tx. Used
 * for the relay/stealth flows where we fund an ephemeral once, then have it
 * author every tx in the multi-step STARK pipeline (init + chunks + verify
 * phase1/phase2 + close).
 */
export function keypairToWalletSigner(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
  };
}

// ---------------------------------------------------------------------------
// PDA Derivation
// ---------------------------------------------------------------------------

function getProofBufferPDA(
  authority: PublicKey,
  circuitId: number = CIRCUIT_SUBSCRIBER_OWNERSHIP
): [PublicKey, number] {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('stark_proof'), authority.toBuffer(), Buffer.from([circuitId])],
    STARK_VERIFIER_PROGRAM_ID
  );
  return [pda, bump];
}

/** Phase C v1 — uniform proof buffer PDA (no circuit_id in seed). */
function getProofBufferV2PDA(
  authority: PublicKey,
  nonce: Uint8Array,
): [PublicKey, number] {
  if (nonce.length !== 16) throw new Error('Phase C v1 nonce must be 16 bytes');
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stark_proof_v2'), authority.toBuffer(), Buffer.from(nonce)],
    STARK_VERIFIER_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Instruction Builders
// ---------------------------------------------------------------------------

function buildInitProofBufferIx(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 1);
  DISCRIMINATORS.initProofBuffer.copy(data, 0);
  data.writeUInt32LE(proofSize, 8);
  data.writeUInt8(circuitId, 12);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWriteProofChunkIx(
  offset: number,
  chunk: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  // offset (u32) + borsh Vec<u8>: 4 bytes length prefix + data
  const data = Buffer.alloc(8 + 4 + 4 + chunk.length);
  DISCRIMINATORS.writeProofChunk.copy(data, 0);
  data.writeUInt32LE(offset, 8);
  data.writeUInt32LE(chunk.length, 12);
  Buffer.from(chunk).copy(data, 16);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildVerifyStarkProofIx(
  commitment: bigint,
  proofBuffer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.verifyStarkProof.copy(data, 0);
  // u64 commitment in little-endian
  const commitBuf = Buffer.alloc(8);
  commitBuf.writeBigUInt64LE(commitment);
  commitBuf.copy(data, 8);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildResizeProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.resizeProofBuffer,
  });
}

function buildVerifyStarkProofV2Ix(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  // Borsh Vec<u64>: 4-byte length prefix + N * 8 bytes
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(v => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const data = Buffer.concat([DISCRIMINATORS.verifyStarkProofV2, vecLen, ...inputBufs]);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Phase C v1 — `init_proof_buffer_v2(proof_size, nonce[16])`.
 * Drops `circuit_id` from ix data + PDA seed → no L13 leak at init time. */
function buildInitProofBufferV2Ix(
  proofSize: number,
  nonce: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  if (nonce.length !== 16) throw new Error('init_proof_buffer_v2 nonce must be 16 bytes');
  // disc(8) + proof_size(u32, 4) + nonce(16) = 28 bytes
  const data = Buffer.alloc(8 + 4 + 16);
  DISCRIMINATORS.initProofBufferV2.copy(data, 0);
  data.writeUInt32LE(proofSize, 8);
  Buffer.from(nonce).copy(data, 12);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Phase C v1 — `verify_uniform(public_inputs)`.
 * Probes V3 active circuits [1, 3, 5, 6] in fixed order; first parse-success
 * wins. circuit_id is discovered post-hoc and stored in buffer for
 * downstream `verify_deep_ali_phase2`. */
function buildVerifyUniformIx(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(v => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const data = Buffer.concat([DISCRIMINATORS.verifyUniform, vecLen, ...inputBufs]);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Phase C v1 — pad a STARK proof to UNIFORM_PROOF_SIZE bytes with trailing
 * zeros. The verifier's `from_bytes` parser uses lower-bound length checks
 * (data.len() < cursor + N) so trailing zeros are silently tolerated.
 *
 * Closes L14 (proof_size variable) — every uploaded proof now writes exactly
 * UNIFORM_PROOF_SIZE bytes regardless of the underlying circuit. */
export function padProofToUniform(bytes: Uint8Array): Uint8Array {
  if (bytes.length > UNIFORM_PROOF_SIZE) {
    throw new Error(`proof too large: ${bytes.length} > ${UNIFORM_PROOF_SIZE}`);
  }
  const padded = new Uint8Array(UNIFORM_PROOF_SIZE);
  padded.set(bytes, 0);
  return padded;
}

/**
 * [P2.2g] Phase-2 DEEP-ALI dispatcher for circuits 1-6. Must run AFTER
 * `verify_stark_proof_v2` (phase 1) succeeds on the same buffer. Public inputs
 * must match phase 1 byte-for-byte — the on-chain instruction re-hashes them
 * and compares against the phase-1 stored hash.
 */
function buildVerifyDeepAliPhase2Ix(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(v => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const data = Buffer.concat([DISCRIMINATORS.verifyDeepAliPhase2, vecLen, ...inputBufs]);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildCloseProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(8);
  DISCRIMINATORS.closeProofBuffer.copy(data, 0);

  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Send pacing — the ONLY place the pipeline decides how fast to talk to an RPC
// ---------------------------------------------------------------------------
//
// [PERF 2026-09-06] docs/MOBILE_PROVER_LATENCY.md measured ~61 s of pure
// `setTimeout` per uploaded proof on this surface: waves of 3 tx / 700 ms
// (30.1 s for 145 chunks), 30-120 ms of jitter before EVERY RPC call, and a
// 1,500 ms confirmation poll. None of that was chain time. The wave stagger
// was "tuned for Helius free tier (~10 RPS)"; the project runs on a paid
// Helius key (`EXPO_PUBLIC_HELIUS_API_KEY`, services/solana/connection.ts).
//
// The rule now: an endpoint we pay for gets the transactions as fast as the
// phone can sign them; the public `api.*.solana.com` endpoints, which answer
// 429 at full speed, keep a SMALL batch pacing. `resilientFetch` still
// retries 429 / -32429 transparently underneath, so a mis-classified endpoint
// degrades to slow, not to broken.

export interface SendPacing {
  /** Transactions sent per burst. `Infinity` = everything at once. */
  batch: number;
  /** Sleep between bursts. */
  delayMs: number;
  /** Signature-status poll interval while waiting for confirmations. */
  pollMs: number;
}

/** Paid / private endpoints (Helius, a relay, localhost): no throttle. */
export const FAST_PACING: SendPacing = { batch: Infinity, delayMs: 0, pollMs: 400 };
/** Public cluster endpoints: ~30 tx/s, which they tolerate without 429 storms. */
export const PUBLIC_RPC_PACING: SendPacing = { batch: 8, delayMs: 250, pollMs: 400 };

const PUBLIC_RPC_HOSTS = ['api.devnet.solana.com', 'api.mainnet-beta.solana.com', 'api.testnet.solana.com'];

/** Pure: which pacing an RPC URL gets. Exported for the tests. */
export function pacingForEndpoint(rpcEndpoint: string | undefined | null): SendPacing {
  if (!rpcEndpoint) return PUBLIC_RPC_PACING;
  const lower = rpcEndpoint.toLowerCase();
  for (const host of PUBLIC_RPC_HOSTS) {
    if (lower.includes(host)) return PUBLIC_RPC_PACING;
  }
  return FAST_PACING;
}

function pacingFor(conn: Connection): SendPacing {
  return pacingForEndpoint((conn as { rpcEndpoint?: string }).rpcEndpoint);
}

const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Let the JS thread breathe between CPU bursts (ed25519 signing runs on the
 * RN JS thread; 20 back-to-back signatures with no yield were the measured
 * input-lag source in docs/MOBILE_PROVER_LATENCY.md). */
const yieldToEventLoop = () => new Promise<void>(r => setTimeout(r, 0));

/**
 * Keep a long `await` AUDIBLE. Mirrors web `stark.ts`: emit `${label} (Ns)`
 * every `everyMs` so a slow confirmation never looks like a hang.
 */
export async function audible<T>(
  label: string,
  onProgress: ((step: string) => void) | undefined,
  run: () => Promise<T>,
  everyMs = 5_000,
): Promise<T> {
  if (!onProgress) return run();
  const startedAt = Date.now();
  onProgress(label);
  const beat = setInterval(() => {
    onProgress(`${label} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }, everyMs);
  try {
    return await run();
  } finally {
    clearInterval(beat);
  }
}

// ---------------------------------------------------------------------------
// High-Level API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transaction signing helper (supports a raw Keypair or a WalletSigner)
// ---------------------------------------------------------------------------

/**
 * Poll one signature to `confirmed` over HTTP. Replaces
 * `conn.confirmTransaction(sig, 'confirmed')`, which is WebSocket-driven with a
 * fixed 60 s timeout and, on this surface, was observed not to fire at all
 * (docs/MOBILE_PROVER_LATENCY.md §5). 400 ms polling puts the floor per
 * sequential transaction at one slot, not one timeout.
 */
export async function confirmSignatureFast(
  conn: Connection,
  sig: string,
  opts?: { pollMs?: number; timeoutMs?: number; lastValidBlockHeight?: number },
): Promise<void> {
  const pollMs = opts?.pollMs ?? 400;
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const start = Date.now();
  let polls = 0;
  for (;;) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value[0];
    if (st) {
      if (st.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
    }
    polls += 1;
    if (opts?.lastValidBlockHeight !== undefined && polls % 10 === 0) {
      const height = await conn.getBlockHeight('confirmed');
      if (height > opts.lastValidBlockHeight) {
        throw new Error(`Transaction ${sig.slice(0, 12)}… expired (blockhash no longer valid)`);
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Transaction ${sig.slice(0, 12)}… not confirmed after ${timeoutMs}ms`);
    }
    await sleepMs(pollMs);
  }
}

async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
  opts?: { skipPreflight?: boolean },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  if (keypair) {
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);
  } else if (walletSigner) {
    tx.feePayer = walletSigner.publicKey;
    tx = await walletSigner.signTransaction(tx);
  } else {
    throw new Error('No wallet available for signing');
  }

  const sig = await conn.sendRawTransaction(tx.serialize({ verifySignatures: false }), {
    skipPreflight: opts?.skipPreflight ?? false,
  });
  await confirmSignatureFast(conn, sig, { pollMs: pacingFor(conn).pollMs, lastValidBlockHeight });
  return sig;
}

/**
 * Sign a list of transactions with the local keypair or the wallet signer,
 * yielding to the event loop every `SIGN_BATCH` signatures.
 */
const SIGN_BATCH = 20;
async function signTxs(
  txs: Transaction[],
  feePayer: PublicKey,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
): Promise<Transaction[]> {
  const out: Transaction[] = new Array(txs.length);
  for (let i = 0; i < txs.length; i++) {
    let tx = txs[i];
    tx.feePayer = feePayer;
    if (keypair) {
      tx.sign(keypair);
    } else if (walletSigner) {
      tx = await walletSigner.signTransaction(tx);
    } else {
      throw new Error('No wallet available for signing');
    }
    out[i] = tx;
    if ((i + 1) % SIGN_BATCH === 0) await yieldToEventLoop();
  }
  return out;
}

/**
 * Send pre-signed transactions as fast as the endpoint's pacing allows.
 * `skipPreflight: true` (a chunk write has nothing a simulation would catch
 * that the confirmation poll would not), `verifySignatures: false` (we just
 * signed them; the on-chain check is the one that counts). Within a burst,
 * sends are parallel via Promise.allSettled; a failed SEND (not a dropped tx)
 * throws with its index.
 */
async function sendTxsFast(
  conn: Connection,
  signedTxs: Transaction[],
  pacing: SendPacing = pacingFor(conn),
): Promise<string[]> {
  const sigs: string[] = new Array(signedTxs.length);
  const batch = Number.isFinite(pacing.batch) ? Math.max(1, pacing.batch) : signedTxs.length || 1;
  for (let w = 0; w < signedTxs.length; w += batch) {
    const waveEnd = Math.min(w + batch, signedTxs.length);
    const results = await Promise.allSettled(
      signedTxs.slice(w, waveEnd).map(tx =>
        conn.sendRawTransaction(tx.serialize({ verifySignatures: false }), { skipPreflight: true }),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        sigs[w + i] = r.value;
      } else {
        throw new Error(`sendRawTransaction failed for tx[${w + i}]: ${r.reason?.message ?? String(r.reason)}`);
      }
    }
    if (waveEnd < signedTxs.length && pacing.delayMs > 0) {
      await sleepMs(pacing.delayMs);
    }
  }
  return sigs;
}

/**
 * Poll signature statuses (one RPC call per 256 signatures per poll) and
 * return which indices are still unconfirmed when `timeoutMs` elapses,
 * instead of throwing. Rejects only on an on-chain error (deterministic —
 * resending would not help).
 */
export async function confirmSignaturesSoft(
  conn: Connection,
  sigs: string[],
  label: string,
  timeoutMs = 60_000,
  pollMs = 400,
): Promise<number[]> {
  if (sigs.length === 0) return [];
  const start = Date.now();
  const confirmed = new Set<number>();
  for (;;) {
    for (let i = 0; i < sigs.length; i += 256) {
      const slice = sigs.slice(i, i + 256);
      const { value: statuses } = await conn.getSignatureStatuses(slice);
      for (let k = 0; k < statuses.length; k++) {
        const s = statuses[k];
        if (!s) continue;
        if (s.err) {
          throw new Error(`${label} failed: ${JSON.stringify(s.err)} (sig=${slice[k]})`);
        }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          confirmed.add(i + k);
        }
      }
    }
    if (confirmed.size >= sigs.length) return [];
    if (Date.now() - start > timeoutMs) {
      const unconfirmed: number[] = [];
      for (let i = 0; i < sigs.length; i++) if (!confirmed.has(i)) unconfirmed.push(i);
      console.warn(`[STARK] ${label} soft timeout: ${confirmed.size}/${sigs.length} confirmed, ${unconfirmed.length} will retry`);
      return unconfirmed;
    }
    await sleepMs(pollMs);
  }
}

// Kept under its old name so nothing else in this module has to move.
async function confirmAllBatchedSoft(
  conn: Connection,
  sigs: string[],
  label: string,
  timeoutMs = 60_000,
  pollMs = pacingFor(conn).pollMs,
): Promise<number[]> {
  return confirmSignaturesSoft(conn, sigs, label, timeoutMs, pollMs);
}

/** One upload unit. Chunk writes are offset-addressed on-chain. */
export interface ProofChunk {
  index: number;
  offset: number;
  bytes: Uint8Array;
}

/** Split proof bytes into MAX_CHUNK_SIZE upload units. Pure. */
export function splitProofIntoChunks(proofBytes: Uint8Array): ProofChunk[] {
  const chunks: ProofChunk[] = [];
  for (let index = 0, offset = 0; offset < proofBytes.length; index++, offset += MAX_CHUNK_SIZE) {
    const end = Math.min(offset + MAX_CHUNK_SIZE, proofBytes.length);
    chunks.push({ index, offset, bytes: proofBytes.slice(offset, end) });
  }
  return chunks;
}

/**
 * Compare local proof bytes against the RAW proof-buffer account data (header
 * included, exactly as getAccountInfo returns it) and return the indices of
 * chunks whose on-chain bytes differ. Null or truncated data marks the
 * unreadable chunks as holes. Pure — mirrors web `findBufferHoles`.
 *
 * On-chain `bytes_written` is a HIGH-WATER MARK, not a count: lose chunk 5
 * while 6..80 land and the program's own completeness check passes over a
 * hole of zeros, and verification fails later, unreadably, after the CU is
 * spent. The client is the sole source of truth on which chunks arrived.
 */
export function findBufferHoles(
  proofBytes: Uint8Array,
  accountData: Uint8Array | null,
): number[] {
  const holes: number[] = [];
  for (const { index, offset, bytes } of splitProofIntoChunks(proofBytes)) {
    const start = PROOF_DATA_OFFSET + offset;
    if (accountData === null || accountData.length < start + bytes.length) {
      holes.push(index);
      continue;
    }
    for (let i = 0; i < bytes.length; i++) {
      if (accountData[start + i] !== bytes[i]) {
        holes.push(index);
        break;
      }
    }
  }
  return holes;
}

const MAX_RESEND_ROUNDS = 3;

/**
 * Grow the proof buffer from MAX_INIT_SIZE up to `targetSize`.
 *
 * Anchor's realloc grows by MAX_REALLOC_STEP (10 KB) per TRANSACTION, so a
 * ~80 KB proof needs 7 to 8 of them. They are all signed with one blockhash,
 * fired at once (the runtime serialises writes to one account, and each step
 * is `min(len + STEP, target)`, so ordering is irrelevant), confirmed in one
 * barrier, and the account length is READ BACK: a dropped realloc is resent,
 * up to MAX_RESEND_ROUNDS.
 */
async function resizeToTarget(
  conn: Connection,
  targetSize: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
  onProgress?: (step: string) => void,
): Promise<void> {
  if (targetSize <= MAX_INIT_SIZE) return;
  let currentLen = MAX_INIT_SIZE;
  for (let round = 0; ; round++) {
    const resizesNeeded = Math.ceil((targetSize - currentLen) / MAX_REALLOC_STEP);
    if (resizesNeeded <= 0) return;
    if (round >= MAX_RESEND_ROUNDS) {
      throw new Error(
        `Proof buffer resize incomplete: ${currentLen}/${targetSize} bytes after ${MAX_RESEND_ROUNDS} rounds.`,
      );
    }
    console.log(`[STARK] Resizing proof buffer ${currentLen}B → ${targetSize}B in ${resizesNeeded} steps (round ${round + 1})`);
    onProgress?.(`Sizing the proof buffer (${resizesNeeded} steps)...`);
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    // Phase C v1.1: each tx is made byte-unique via a SPL Memo ix carrying a
    // 4-byte LE counter (NOT a priority-fee counter — kills the L18 fingerprint).
    const txs = Array.from({ length: resizesNeeded }, (_, i) => {
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: UNIFORM_CU_PRICE_MICROLAMPORTS }))
        .add(buildMemoCounterIx(round * 64 + i))
        .add(buildResizeProofBufferIx(proofBuffer, authority));
      tx.recentBlockhash = blockhash;
      return tx;
    });
    const signed = await signTxs(txs, authority, keypair, walletSigner);
    const sigs = await sendTxsFast(conn, signed);
    await audible('Confirming buffer size...', onProgress, () =>
      confirmAllBatchedSoft(conn, sigs, 'Resize'),
    );
    const info = await conn.getAccountInfo(proofBuffer);
    currentLen = info?.data?.length ?? currentLen;
    if (currentLen >= targetSize) {
      console.log('[STARK] Resize complete');
      return;
    }
  }
}

/**
 * Upload every chunk AT ONCE under one blockhash, confirm in one barrier,
 * resend only what did not confirm (fresh blockhash), then prove
 * completeness by reading the buffer back byte for byte and repairing any
 * torn chunk. See `findBufferHoles` for why the readback is not optional.
 *
 * Before 2026-09-06 this was 8 sequential batches of 20 with a 700 ms wave
 * stagger inside each: 30 s of sleep for a 145-chunk proof. The chain absorbs
 * 80 chunk writes in one or two slots.
 */
export async function uploadProofChunks(
  conn: Connection,
  proofBytes: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
  onProgress?: (step: string) => void,
  opts?: { confirmWindowMs?: number; pollMs?: number },
): Promise<void> {
  const chunks = splitProofIntoChunks(proofBytes);
  const confirmWindowMs = opts?.confirmWindowMs ?? 60_000;
  const pollMs = opts?.pollMs ?? pacingFor(conn).pollMs;
  console.log(`[STARK] Uploading ${proofBytes.length}B in ${chunks.length} chunks (single barrier)`);

  const sendChunks = async (toSend: ProofChunk[], label: string): Promise<string[]> => {
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    onProgress?.(`${label} (${toSend.length} chunks)...`);
    const txs = toSend.map(chunk => {
      const tx = new Transaction().add(
        buildWriteProofChunkIx(chunk.offset, chunk.bytes, proofBuffer, authority),
      );
      tx.recentBlockhash = blockhash;
      return tx;
    });
    const signed = await signTxs(txs, authority, keypair, walletSigner);
    return sendTxsFast(conn, signed);
  };

  let pending = chunks;
  for (let round = 0; ; round++) {
    const label = round === 0 ? 'Uploading the proof' : `Resending chunks (round ${round}/${MAX_RESEND_ROUNDS})`;
    const sigs = await sendChunks(pending, label);
    const unconfirmed = await audible('Confirming the upload...', onProgress, () =>
      confirmAllBatchedSoft(conn, sigs, `Chunk round ${round}`, confirmWindowMs, pollMs),
    );
    if (unconfirmed.length === 0) break;
    if (round >= MAX_RESEND_ROUNDS) {
      throw new Error(
        `Chunk upload failed: ${unconfirmed.length} chunk(s) unconfirmed after ${MAX_RESEND_ROUNDS} resend round(s).`,
      );
    }
    pending = unconfirmed.map(i => pending[i]);
    onProgress?.(`${pending.length} chunk(s) lost, resending...`);
  }

  // Authoritative completeness gate.
  onProgress?.('Checking the uploaded proof against the local bytes...');
  for (let attempt = 0; ; attempt++) {
    const info = await conn.getAccountInfo(proofBuffer);
    const holes = findBufferHoles(proofBytes, info?.data ? new Uint8Array(info.data) : null);
    if (holes.length === 0) {
      console.log(`[STARK] All ${chunks.length} chunks confirmed and read back`);
      return;
    }
    if (attempt >= 1) {
      throw new Error(
        `Proof buffer is torn on-chain: chunk(s) [${holes.join(', ')}] still differ ` +
          'from the local proof after a repair pass. Aborting before spending verify CU.',
      );
    }
    onProgress?.(`Readback found ${holes.length} torn chunk(s), repairing...`);
    const repairSigs = await sendChunks(holes.map(i => chunks[i]), 'Re-uploading torn chunks');
    await confirmAllBatchedSoft(conn, repairSigs, 'Chunk repair', confirmWindowMs, pollMs);
  }
}

/** Legacy name, same fast path. */
async function uploadChunksParallel(
  conn: Connection,
  proofBytes: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
  onProgress?: (step: string) => void,
): Promise<void> {
  return uploadProofChunks(conn, proofBytes, proofBuffer, authority, keypair, walletSigner, onProgress);
}

// ---------------------------------------------------------------------------
// Composed verify + consume — L3 of docs/PERF-AND-CAPACITY-PLAN-2026-09-06.md
// ---------------------------------------------------------------------------
//
// Instructions of one transaction see the writes of the ones before them, and
// nothing in the verifier requires a slot boundary between phase 1, phase 2
// and the consuming instruction. Measured 2026-09-02 (docs/BENCHMARK):
//
//   circuit 7  phase 1 878,756 + phase 2 192,715 + spend 176,404 = 1,247,875 CU
//              -> ONE transaction under the 1,400,000 per-tx cap (11 % headroom)
//   circuit 6  phase 1 1,316,491 alone -> TWO transactions:
//              [phase 1] then [phase 2 + shield + close]
//
// Every other circuit takes the split plan until its phase-1 cost is pinned.

export type ComposePlan = 'single' | 'split';

/** Measured 2026-09-02, devnet, read back from the transactions. */
export const C7_PHASE1_CU = 878_756;
export const C7_PHASE2_CU = 192_715;
export const C6_PHASE1_CU = 1_316_491;
export const MAX_TX_CU = 1_400_000;

export function planForCircuit(circuitId: number): ComposePlan {
  return circuitId === 7 ? 'single' : 'split';
}

export interface ConsumeSpec {
  /** Instructions that read the verified buffer (e.g. `unshield_denominated_stark_v4`). */
  ixs: TransactionInstruction[];
  /** CU limit of the composed transaction. */
  cuLimit: number;
  cuPriceMicroLamports?: number;
  /** Sends the composed, UNSIGNED transaction. The relayer toggle lives with the caller. */
  send: (tx: Transaction) => Promise<string>;
  /** Override the per-circuit default. */
  plan?: ComposePlan;
  /** Append `close_proof_buffer` after the consuming instructions (default true). */
  closeInline?: boolean;
}

/**
 * Pure: build the composed transaction. Order is FROZEN and pinned by the
 * tests: [cu limit, cu price?, phase 1?, phase 2?, ...consume, close?].
 * Phase 1 is included only under the 'single' plan; phase 2 only for the
 * circuits that have one (1..7); circuit 0 verifies inline in phase 1.
 */
export function composeConsumeTransaction(params: {
  proof: GenericStarkProof;
  proofBuffer: PublicKey;
  authority: PublicKey;
  consume: Pick<ConsumeSpec, 'ixs' | 'cuLimit' | 'cuPriceMicroLamports' | 'closeInline'>;
  includePhase1: boolean;
}): Transaction {
  const { proof, proofBuffer, authority, consume, includePhase1 } = params;
  if (consume.cuLimit > MAX_TX_CU) {
    throw new Error(`composeConsumeTransaction: cuLimit ${consume.cuLimit} exceeds the ${MAX_TX_CU} per-transaction cap`);
  }
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: consume.cuLimit }));
  if (consume.cuPriceMicroLamports !== undefined) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: consume.cuPriceMicroLamports }));
  }
  if (includePhase1) {
    if (proof.circuitId === 0) {
      tx.add(buildVerifyStarkProofIx(proof.publicInputs[0], proofBuffer, authority));
    } else {
      tx.add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
    }
  }
  if (proof.circuitId >= 1 && proof.circuitId <= 7) {
    tx.add(buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority));
  }
  for (const ix of consume.ixs) tx.add(ix);
  if (consume.closeInline !== false) {
    tx.add(buildCloseProofBufferIx(proofBuffer, authority));
  }
  return tx;
}

/**
 * Shared front half of every submit: stale-buffer cleanup, init, resize,
 * upload with readback. Returns the buffer and the authority.
 */
async function prepareProofBuffer(
  conn: Connection,
  proof: GenericStarkProof,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
  onProgress?: (step: string) => void,
): Promise<{ proofBuffer: PublicKey; authority: PublicKey }> {
  const authority = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const [proofBuffer] = getProofBufferPDA(authority, proof.circuitId);

  const existing = await conn.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing a stale proof buffer...');
    try {
      const closeTx = new Transaction().add(buildCloseProofBufferIx(proofBuffer, authority));
      await signSendConfirm(conn, closeTx, keypair, walletSigner);
    } catch {
      await sleepMs(2000);
      const recheck = await conn.getAccountInfo(proofBuffer);
      if (recheck) {
        throw new Error(
          'Stale STARK proof buffer exists and cannot be closed. ' +
          'Please wait a few seconds and try again, or use a different wallet.'
        );
      }
    }
  }

  await audible('Opening the proof buffer...', onProgress, () =>
    signSendConfirm(
      conn,
      new Transaction().add(buildInitProofBufferIx(proof.proofSize, proof.circuitId, proofBuffer, authority)),
      keypair,
      walletSigner,
    ),
  );

  await resizeToTarget(conn, proof.proofSize + PROOF_DATA_OFFSET, proofBuffer, authority, keypair, walletSigner, onProgress);
  await uploadProofChunks(conn, proof.proofBytes, proofBuffer, authority, keypair, walletSigner, onProgress);
  return { proofBuffer, authority };
}

/**
 * Upload the proof, then verify AND consume it in as few transactions as the
 * CU cap allows. The consuming instruction(s) and the close ride in the same
 * transaction as the last verify phase, so a rejected proof reverts
 * everything (the buffer survives for the caller's `finally` to close) and an
 * accepted one leaves nothing behind (`closed: true`).
 *
 * Sequential confirmations per proof, before → after:
 *   circuit 7: init + 8 resize + 1 chunk barrier + verify1 + verify2 + spend + close = 13
 *              → init + 1 resize barrier + 1 chunk barrier + 1 composed tx = 4
 *   circuit 6: 14 → 5 (phase 1 stays alone: 1,316,491 CU)
 */
export async function submitAndConsumeStarkProof(
  proof: GenericStarkProof,
  consume: ConsumeSpec,
  walletSigner?: WalletSigner,
  onProgress?: (step: string) => void,
  connection?: Connection,
): Promise<{ proofBuffer: PublicKey; authority: PublicKey; txSignature: string; verifySignature?: string; closed: boolean }> {
  const conn = connection ?? getConnection();
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const { proofBuffer, authority } = await prepareProofBuffer(conn, proof, keypair, walletSigner, onProgress);
  const plan = consume.plan ?? planForCircuit(proof.circuitId);

  let verifySignature: string | undefined;
  if (plan === 'split') {
    const verifyTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_TX_CU }));
    if (proof.circuitId === 0) {
      verifyTx.add(buildVerifyStarkProofIx(proof.publicInputs[0], proofBuffer, authority));
    } else {
      verifyTx.add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
    }
    verifySignature = await audible('Verifying the proof on-chain (phase 1)...', onProgress, () =>
      signSendConfirm(conn, verifyTx, keypair, walletSigner),
    );
  }

  const composed = composeConsumeTransaction({
    proof,
    proofBuffer,
    authority,
    consume,
    includePhase1: plan === 'single',
  });
  const txSignature = await audible(
    plan === 'single'
      ? 'Verifying the proof and finishing on-chain (one transaction)...'
      : 'Finishing on-chain (phase 2 + your transaction)...',
    onProgress,
    () => consume.send(composed),
  );
  return { proofBuffer, authority, txSignature, verifySignature, closed: consume.closeInline !== false };
}

/**
 * Submit and verify a STARK proof on-chain.
 *
 * Flow:
 * 1. Init proof buffer PDA (or clean up stale one)
 * 2. Upload proof in chunks (900 bytes per tx)
 * 3. Call verify_stark_proof with commitment (~900K CU)
 * 4. Close buffer and recover rent
 *
 * Supports a raw local Keypair or a WalletSigner.
 * If neither is provided, reads the keypair from SecureStore.
 */
export async function submitStarkProof(
  proof: CompactStarkProof,
  walletSigner?: WalletSigner,
  onProgress?: (step: string) => void,
  connection?: Connection,
): Promise<StarkVerificationResult> {
  const conn = connection ?? getConnection();
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const authority = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const [proofBuffer] = getProofBufferPDA(authority);

  // Clean up stale proof buffer if it exists
  const existing = await conn.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing stale proof buffer...');
    const closeTx = new Transaction().add(
      buildCloseProofBufferIx(proofBuffer, authority)
    );
    await signSendConfirm(conn, closeTx, keypair, walletSigner);
  }

  // Step 1: Init proof buffer
  onProgress?.('Initializing proof buffer...');
  const initTx = new Transaction().add(
    buildInitProofBufferIx(
      proof.proofSize,
      CIRCUIT_SUBSCRIBER_OWNERSHIP,
      proofBuffer,
      authority,
    )
  );
  await signSendConfirm(conn, initTx, keypair, walletSigner);

  // Step 1b: Resize iteratively — Anchor realloc grows 10 KB per call
  await resizeToTarget(
    conn,
    proof.proofSize + PROOF_DATA_OFFSET,
    proofBuffer,
    authority,
    keypair,
    walletSigner,
    onProgress,
  );

  // Step 2: Upload proof chunks in parallel
  await uploadChunksParallel(conn, proof.proofBytes, proofBuffer, authority, keypair, walletSigner, onProgress);

  // Step 3: Verify (requires ~900K CU for STARK verification)
  onProgress?.('Verifying STARK proof on-chain...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofIx(proof.commitment, proofBuffer, authority));
  const txSig = await signSendConfirm(conn, verifyTx, keypair, walletSigner);

  // Step 4: Close buffer and recover rent
  onProgress?.('Closing proof buffer...');
  const closeTx = new Transaction().add(
    buildCloseProofBufferIx(proofBuffer, authority)
  );
  await signSendConfirm(conn, closeTx, keypair, walletSigner).catch(() => {
    // Non-critical — rent will be recovered later
    console.warn('[STARK] Failed to close proof buffer, rent not recovered');
  });

  onProgress?.('STARK proof verified!');
  return {
    verified: true,
    txSignature: txSig,
    commitment: proof.commitment,
    proofSize: proof.proofSize,
  };
}

/**
 * Check if a proof buffer exists and its verification status.
 */
export async function getProofBufferStatus(
  authority: PublicKey,
  connection?: Connection
): Promise<{ exists: boolean; verified: boolean } | null> {
  const conn = connection ?? getConnection();
  const [proofBuffer] = getProofBufferPDA(authority);

  const info = await conn.getAccountInfo(proofBuffer);
  if (!info) return { exists: false, verified: false };

  // Parse: 8 discriminator + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified
  const verified = info.data[8 + 32 + 1 + 4 + 4] === 1;
  return { exists: true, verified };
}

/**
 * Submit and verify a generic STARK proof on-chain.
 * Supports pool_commitment (1), balance_proof (2), merkle_path (3).
 *
 * Uses verify_stark_proof with first public input as commitment param
 * (backward-compatible with the existing instruction).
 */
export async function submitGenericStarkProof(
  proof: GenericStarkProof,
  walletSigner?: WalletSigner,
  onProgress?: (step: string) => void,
  connection?: Connection,
): Promise<StarkVerificationResult> {
  const conn = connection ?? getConnection();
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const authority = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const [proofBuffer] = getProofBufferPDA(authority, proof.circuitId);

  // Clean up stale proof buffer if it exists
  const existing = await conn.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing stale proof buffer...');
    const closeTx = new Transaction().add(
      buildCloseProofBufferIx(proofBuffer, authority)
    );
    await signSendConfirm(conn, closeTx, keypair, walletSigner);
  }

  // Step 1: Init proof buffer
  onProgress?.('Initializing proof buffer...');
  const initTx = new Transaction().add(
    buildInitProofBufferIx(
      proof.proofSize,
      proof.circuitId,
      proofBuffer,
      authority,
    )
  );
  await signSendConfirm(conn, initTx, keypair, walletSigner);

  // Step 1b: Resize iteratively — Anchor realloc grows 10 KB per call
  await resizeToTarget(
    conn,
    proof.proofSize + PROOF_DATA_OFFSET,
    proofBuffer,
    authority,
    keypair,
    walletSigner,
    onProgress,
  );

  // Step 2: Upload proof chunks in parallel
  await uploadChunksParallel(conn, proof.proofBytes, proofBuffer, authority, keypair, walletSigner, onProgress);

  // Step 3a: Phase 1 — verify_stark_proof_v2 (FRI + trace-aligned + boundary)
  onProgress?.('Verifying STARK proof phase 1...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  const txSig = await signSendConfirm(conn, verifyTx, keypair, walletSigner);

  // Step 3b: Phase 2 — DEEP-ALI at OOD. Mandatory for circuits 1-7.
  // [C7 2026-08-24] <= 7. Circuit 7 (spend) splits phase 1 / phase 2 like
  // 1..6, and phase 2 is where ALL of its binding lives -- its per-query
  // arm is vacuous and step 5 is gone. Left at <= 6 this branch skips
  // phase 2 silently and the client reports SUCCESS on a proof whose six
  // boundary assertions were never checked against the trace.
  if (proof.circuitId >= 1 && proof.circuitId <= 7) {
    onProgress?.('Verifying STARK proof phase 2 (DEEP-ALI)...');
    const deepAliTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority));
    await signSendConfirm(conn, deepAliTx, keypair, walletSigner);
  }

  // Step 4: Close buffer and recover rent
  onProgress?.('Closing proof buffer...');
  const closeTx = new Transaction().add(
    buildCloseProofBufferIx(proofBuffer, authority)
  );
  await signSendConfirm(conn, closeTx, keypair, walletSigner).catch(() => {
    console.warn('[STARK] Failed to close proof buffer, rent not recovered');
  });

  onProgress?.('STARK proof verified!');
  return {
    verified: true,
    txSignature: txSig,
    commitment: proof.publicInputs[0] ?? 0n,
    proofSize: proof.proofSize,
  };
}

/**
 * Submit and verify a STARK proof on-chain WITHOUT closing the buffer.
 * Returns the proof buffer PDA so the caller can reference it in a subsequent
 * instruction (e.g. unshield_denominated_stark) and close it afterwards.
 */
export async function submitAndVerifyStarkProof(
  proof: GenericStarkProof,
  walletSigner?: WalletSigner,
  onProgress?: (step: string) => void,
  connection?: Connection,
): Promise<{ proofBuffer: PublicKey; authority: PublicKey; txSignature: string }> {
  const conn = connection ?? getConnection();
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  // Steps 1-2: stale cleanup, init, resize, upload + readback.
  const { proofBuffer, authority } = await prepareProofBuffer(conn, proof, keypair, walletSigner, onProgress);

  // Step 3a: Phase 1 verification — circuit_id-aware dispatch.
  //
  // Circuit 0 (subscriber_ownership) uses the LEGACY proof format
  // (`CompactStarkProof`). The on-chain verifier exposes two ix:
  //   - `verify_stark_proof`     → for C0 ONLY: parses CompactStarkProof and
  //                                runs `verify_subscriber_ownership`.
  //   - `verify_stark_proof_v2`  → for C1..C7: parses GenericCompactProof and
  //                                runs `verify_generic`.
  //
  // The two formats are byte-compatible enough to parse through either
  // entry point (FRI / Merkle / OOD all pass), but `verify_generic`'s
  // trace-aligned constraint reader interprets columns differently than
  // the C0 trace layout, so step 4 (transition constraints) silently
  // fails with InvalidProof. Without this branch, pause / resume /
  // cancel of V3 vaults all simulate-fail with custom error 0x1773.
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_TX_CU }));
  if (proof.circuitId === 0) {
    // Legacy ix takes a single u64 commitment, not a vec of public_inputs.
    verifyTx.add(buildVerifyStarkProofIx(proof.publicInputs[0], proofBuffer, authority));
  } else {
    verifyTx.add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  }
  const txSig = await audible('Verifying the proof on-chain (phase 1)...', onProgress, () =>
    signSendConfirm(conn, verifyTx, keypair, walletSigner),
  );

  // Step 3b: Phase 2 — DEEP-ALI at OOD. Mandatory for circuits 1-7 (C0 runs
  // DEEP-ALI inline in phase 1).
  // [C7 2026-08-24] <= 7. Circuit 7 (spend) splits phase 1 / phase 2 like
  // 1..6, and phase 2 is where ALL of its binding lives -- its per-query
  // arm is vacuous and step 5 is gone. Left at <= 6 this branch skips
  // phase 2 silently and the client reports SUCCESS on a proof whose six
  // boundary assertions were never checked against the trace.
  //
  // Callers that can put their consuming instruction in the same transaction
  // as phase 2 should use `submitAndConsumeStarkProof` instead: it saves the
  // separate phase-2, consume and close confirmations.
  if (proof.circuitId >= 1 && proof.circuitId <= 7) {
    const deepAliTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_TX_CU }))
      .add(buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority));
    await audible('Verifying the proof on-chain (phase 2, DEEP-ALI)...', onProgress, () =>
      signSendConfirm(conn, deepAliTx, keypair, walletSigner),
    );
  }

  onProgress?.('STARK proof verified (buffer retained for cross-program read)');
  return { proofBuffer, authority, txSignature: txSig };
}

/**
 * Phase C v1 (deployed 2026-05-07) — uniform STARK upload pipeline.
 *
 * Drop-in replacement for `submitAndVerifyStarkProof` for V3 callers. Returns
 * the same shape so call-sites swap with one line.
 *
 * Differences vs legacy:
 * - PDA seed: `[b"stark_proof_v2", authority, nonce[16]]` (no circuit_id leak)
 * - Init ix: `init_proof_buffer_v2(proof_size, nonce[16])` — proof_size is
 *   ALWAYS `UNIFORM_PROOF_SIZE` (=145000) regardless of underlying circuit
 * - Verify ix: `verify_uniform(public_inputs)` — verifier probes V3 circuits
 *   [1, 3, 5, 6] in fixed order, first parse-success wins. circuit_id stored
 *   in buffer post-hoc for downstream `verify_deep_ali_phase2`.
 * - Proof bytes: padded to UNIFORM_PROOF_SIZE with trailing zeros (tolerated
 *   by from_bytes lower-bound length checks).
 *
 * Closes leaks L13 (circuit_id at init) + L14 (proof_size variable). L15/L18
 * (CU consumed + CU price fingerprint) are partial — Phase C v1.1 will
 * uniformize CU ceiling and migrate from microLamports:i+1 to Memo nonce.
 */
export async function submitAndVerifyStarkProofUniform(
  proof: GenericStarkProof,
  walletSigner?: WalletSigner,
  onProgress?: (step: string) => void,
  connection?: Connection,
): Promise<{ proofBuffer: PublicKey; authority: PublicKey; txSignature: string }> {
  const conn = connection ?? getConnection();
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const authority = keypair ? keypair.publicKey : walletSigner!.publicKey;

  // Random 16-byte nonce per upload — defeats PDA collision and keeps the
  // init ix data different across uploads of the same circuit.
  const nonce = new Uint8Array(16);
  // crypto.getRandomValues works in React Native via expo-crypto polyfill.
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(nonce);
  } else {
    // Fallback (Node test contexts) — Math.random is fine for nonce uniqueness.
    for (let i = 0; i < 16; i++) nonce[i] = Math.floor(Math.random() * 256);
  }

  const [proofBuffer] = getProofBufferV2PDA(authority, nonce);

  // Stale buffer cleanup is per-PDA; new nonce = new PDA, so no stale to
  // worry about. Skip the legacy stale-cleanup branch.

  // Pad raw proof bytes to uniform size (closes L14).
  const paddedBytes = padProofToUniform(proof.proofBytes);
  const uniformSize = UNIFORM_PROOF_SIZE;

  // Step 1: Init buffer with uniform size + nonce (no circuit_id leak).
  onProgress?.('Initializing proof buffer (uniform pipeline)...');
  const initTx = new Transaction().add(
    buildInitProofBufferV2Ix(uniformSize, nonce, proofBuffer, authority),
  );
  await signSendConfirm(conn, initTx, keypair, walletSigner);

  // Step 1b: Resize to uniform target (~14 resize tx of 10KB each).
  await resizeToTarget(
    conn,
    uniformSize + PROOF_DATA_OFFSET,
    proofBuffer,
    authority,
    keypair,
    walletSigner,
    onProgress,
  );

  // Step 2: Upload all UNIFORM_PROOF_SIZE bytes (real proof + zero padding).
  await uploadChunksParallel(
    conn,
    paddedBytes,
    proofBuffer,
    authority,
    keypair,
    walletSigner,
    onProgress,
  );

  // Step 3a: Phase 1 — verify_uniform (probes V3 active circuits, sets
  // circuit_id in buffer post-success).
  onProgress?.('Verifying STARK proof (uniform probe)...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyUniformIx(proof.publicInputs, proofBuffer, authority));
  const txSig = await signSendConfirm(conn, verifyTx, keypair, walletSigner);

  // Step 3b: Phase 2 — DEEP-ALI at OOD. The buffer's circuit_id is now set by
  // verify_uniform; verify_deep_ali_phase2 reads it. C0 (subscriber_ownership,
  // not in V3 probe set) inlines DEEP-ALI in phase 1; Phase C v1 only handles
  // V3 active circuits [1,3,5,6] which all need phase-2.
  onProgress?.('Verifying STARK proof phase 2 (DEEP-ALI)...');
  const deepAliTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority));
  await signSendConfirm(conn, deepAliTx, keypair, walletSigner);

  onProgress?.('STARK proof verified (uniform pipeline, buffer retained)');
  return { proofBuffer, authority, txSignature: txSig };
}

/**
 * Close a proof buffer and recover rent. Call after the consuming instruction
 * (e.g. unshield_denominated_stark) has read the buffer.
 */
export async function closeStarkProofBuffer(
  proofBuffer: PublicKey,
  walletSigner?: WalletSigner,
  connection?: Connection,
): Promise<void> {
  const conn = connection ?? getConnection();
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');
  const authority = keypair ? keypair.publicKey : walletSigner!.publicKey;

  const closeTx = new Transaction().add(
    buildCloseProofBufferIx(proofBuffer, authority)
  );
  await signSendConfirm(conn, closeTx, keypair, walletSigner).catch(() => {
    console.warn('[STARK] Failed to close proof buffer, rent not recovered');
  });
}

export {
  getProofBufferPDA,
  buildCloseProofBufferIx,
  STARK_VERIFIER_PROGRAM_ID,
  CIRCUIT_SUBSCRIBER_OWNERSHIP,
  CIRCUIT_POOL_COMMITMENT,
  CIRCUIT_BALANCE_PROOF,
  CIRCUIT_MERKLE_PATH,
  CIRCUIT_CONFIDENTIAL_BALANCE,
  CIRCUIT_TRANSFER,
  CIRCUIT_MERKLE_UPDATE,
};
