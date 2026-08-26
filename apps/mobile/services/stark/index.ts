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
// High-Level API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transaction signing helper (supports a raw Keypair or a WalletSigner)
// ---------------------------------------------------------------------------

async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
  opts?: { skipPreflight?: boolean },
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
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

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: opts?.skipPreflight ?? false,
  });
  const result = await conn.confirmTransaction(sig, 'confirmed');
  if (result.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  }
  return sig;
}

/**
 * Resize the proof buffer from MAX_INIT_SIZE up to targetSize.
 *
 * Anchor's realloc grows by MAX_REALLOC_STEP (10 KB) per call, so large proofs
 * require multiple iterations. All resize TXs are signed with one blockhash,
 * fired without awaiting confirmations, then confirmed in parallel at the end.
 * Solana serializes writes to the same account, so each TX sees the previous
 * TX's size and advances by STEP (capped at target).
 */
/**
 * Send pre-signed TXs in staggered waves. Tuned for Helius free tier (~10 RPS)
 * with resilientFetch handling residual 429s transparently. Within a wave, sends
 * are parallel via Promise.allSettled so one 429 (post-retry-exhaustion) doesn't
 * take down the whole batch — failed sends bubble up as thrown errors with the
 * failed index so the caller can decide whether to abort or retry.
 */
async function sendTxsInWaves(
  conn: Connection,
  signedTxs: Transaction[],
  waveSize = 3,
  waveDelayMs = 700,
): Promise<string[]> {
  const sigs: string[] = new Array(signedTxs.length);
  for (let w = 0; w < signedTxs.length; w += waveSize) {
    const waveEnd = Math.min(w + waveSize, signedTxs.length);
    const results = await Promise.allSettled(
      signedTxs.slice(w, waveEnd).map(tx =>
        conn.sendRawTransaction(tx.serialize(), { skipPreflight: true })
      )
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        sigs[w + i] = r.value;
      } else {
        throw new Error(`sendRawTransaction failed for tx[${w + i}]: ${r.reason?.message ?? String(r.reason)}`);
      }
    }
    if (waveEnd < signedTxs.length) {
      await new Promise(r => setTimeout(r, waveDelayMs));
    }
  }
  return sigs;
}

/**
 * Poll getSignatureStatuses in a single batch call for all signatures, instead
 * of N parallel confirmTransaction polls. One RPC call per poll interval keeps
 * us well under rate limits. Errors out on first on-chain tx error or timeout.
 */
async function confirmAllBatched(
  conn: Connection,
  sigs: string[],
  label: string,
  timeoutMs = 180_000,
  pollMs = 1500,
): Promise<void> {
  if (sigs.length === 0) return;
  const start = Date.now();
  const confirmed = new Set<number>();
  while (confirmed.size < sigs.length) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `${label} confirmation timeout: ${confirmed.size}/${sigs.length} confirmed after ${timeoutMs}ms`
      );
    }
    const { value: statuses } = await conn.getSignatureStatuses(sigs);
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      if (!s) continue;
      if (s.err) {
        throw new Error(`${label} failed: ${JSON.stringify(s.err)} (sig=${sigs[i]})`);
      }
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
        confirmed.add(i);
      }
    }
    if (confirmed.size < sigs.length) {
      await new Promise(r => setTimeout(r, pollMs));
    }
  }
}

/**
 * Poll signature statuses and return which indices are unconfirmed on timeout,
 * instead of throwing. Lets the caller resend dropped TXs with a fresh blockhash.
 *
 * Rejects only on on-chain tx error (deterministic failure — resending won't help).
 */
async function confirmAllBatchedSoft(
  conn: Connection,
  sigs: string[],
  label: string,
  timeoutMs = 60_000,
  pollMs = 1500,
): Promise<number[]> {
  if (sigs.length === 0) return [];
  const start = Date.now();
  const confirmed = new Set<number>();
  while (confirmed.size < sigs.length) {
    if (Date.now() - start > timeoutMs) {
      const unconfirmed: number[] = [];
      for (let i = 0; i < sigs.length; i++) if (!confirmed.has(i)) unconfirmed.push(i);
      console.warn(`[STARK] ${label} soft timeout: ${confirmed.size}/${sigs.length} confirmed, ${unconfirmed.length} will retry`);
      return unconfirmed;
    }
    const { value: statuses } = await conn.getSignatureStatuses(sigs);
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      if (!s) continue;
      if (s.err) {
        throw new Error(`${label} failed: ${JSON.stringify(s.err)} (sig=${sigs[i]})`);
      }
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
        confirmed.add(i);
      }
    }
    if (confirmed.size < sigs.length) {
      await new Promise(r => setTimeout(r, pollMs));
    }
  }
  return [];
}

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
  const resizesNeeded = Math.ceil((targetSize - MAX_INIT_SIZE) / MAX_REALLOC_STEP);
  console.log(`[STARK] Resizing proof buffer 10KB → ${targetSize}B in ${resizesNeeded} steps`);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  // Phase C v1.1: each tx is made byte-unique via a SPL Memo ix carrying a
  // 4-byte LE counter (NOT a priority-fee counter — kills the L18 fingerprint).
  // The Memo program is generic enough that its presence doesn't tag P01.
  // CU price is uniform = UNIFORM_CU_PRICE_MICROLAMPORTS for all resize tx.
  const signedTxs = await Promise.all(
    Array.from({ length: resizesNeeded }, async (_, i) => {
      onProgress?.(`Resizing proof buffer (${i + 1}/${resizesNeeded})...`);
      let tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: UNIFORM_CU_PRICE_MICROLAMPORTS }))
        .add(buildMemoCounterIx(i))
        .add(buildResizeProofBufferIx(proofBuffer, authority));
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
      return tx;
    })
  );
  const sigs = await sendTxsInWaves(conn, signedTxs);
  console.log(`[STARK] All ${resizesNeeded} resize TXs sent, awaiting batch confirm`);
  await confirmAllBatched(conn, sigs, 'Resize');
  console.log(`[STARK] Resize complete`);
}

/**
 * Build + sign + send + batch-confirm all chunk upload TXs. Chunks are
 * naturally unique (different offset/data) so no dedup hack needed.
 *
 * Chunks are processed in BATCHES so each batch uses a fresh blockhash. A single
 * blockhash only stays valid ~60-90s on Solana, and rate-limited sends + 121
 * chunks can easily exceed that window — the late-arriving TXs would get
 * silently dropped, causing the whole flow to time out.
 *
 * PIPELINED: batch N+1 prepares + sends WHILE batch N is still confirming. Cuts
 * the per-batch confirm wait (~2s) out of the critical path for all batches
 * except the last one. Chunks are order-independent writes so interleaving is safe.
 */
async function uploadChunksParallel(
  conn: Connection,
  proofBytes: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
  onProgress?: (step: string) => void,
): Promise<void> {
  const totalChunks = Math.ceil(proofBytes.length / MAX_CHUNK_SIZE);
  const BATCH_SIZE = 20; // chunks per blockhash window — smaller batch survives heavy 429 retries
  const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);
  console.log(`[STARK] Uploading ${proofBytes.length}B in ${totalChunks} chunks (${totalBatches} batches, pipelined)`);

  const MAX_BATCH_RETRIES = 4;

  for (let batchStart = 0; batchStart < totalChunks; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalChunks);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;

    // Chunks to send in this batch. After each retry round, trimmed to
    // only the chunks whose signatures didn't confirm in time (phone-sleep,
    // blockhash expired, RPC dropped the TX, etc).
    let remaining = Array.from({ length: batchEnd - batchStart }, (_, j) => {
      const i = batchStart + j;
      const offset = i * MAX_CHUNK_SIZE;
      const end = Math.min(offset + MAX_CHUNK_SIZE, proofBytes.length);
      return { offset, data: proofBytes.slice(offset, end) };
    });

    for (let attempt = 0; attempt < MAX_BATCH_RETRIES; attempt++) {
      onProgress?.(
        attempt === 0
          ? `Uploading proof batch ${batchNum}/${totalBatches}...`
          : `Retrying batch ${batchNum}/${totalBatches} (${remaining.length} chunks, attempt ${attempt + 1}/${MAX_BATCH_RETRIES})...`,
      );

      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const signedTxs = await Promise.all(
        remaining.map(async ({ offset, data }) => {
          let tx = new Transaction().add(
            buildWriteProofChunkIx(offset, data, proofBuffer, authority)
          );
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
          return tx;
        })
      );
      const sigs = await sendTxsInWaves(conn, signedTxs);
      console.log(
        `[STARK] Batch ${batchNum}/${totalBatches} attempt ${attempt + 1}: ${sigs.length} TXs sent`
      );

      const unconfirmed = await confirmAllBatchedSoft(
        conn,
        sigs,
        `Chunk batch ${batchNum} attempt ${attempt + 1}`,
      );
      if (unconfirmed.length === 0) {
        console.log(`[STARK] Batch ${batchNum}/${totalBatches} confirmed`);
        break;
      }
      remaining = unconfirmed.map(i => remaining[i]);
      if (attempt === MAX_BATCH_RETRIES - 1) {
        throw new Error(
          `Chunk batch ${batchNum} failed after ${MAX_BATCH_RETRIES} attempts: ${remaining.length} chunks still unconfirmed`
        );
      }
    }
  }

  console.log(`[STARK] All ${totalChunks} chunks confirmed`);
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

  const authority = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const [proofBuffer] = getProofBufferPDA(authority, proof.circuitId);

  // Clean up stale proof buffer if it exists
  const existing = await conn.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing stale proof buffer...');
    try {
      const closeTx = new Transaction().add(
        buildCloseProofBufferIx(proofBuffer, authority)
      );
      await signSendConfirm(conn, closeTx, keypair, walletSigner);
    } catch (closeErr) {
      // Buffer exists but can't be closed (bad state / zeroed discriminator).
      await new Promise(r => setTimeout(r, 2000));
      const recheck = await conn.getAccountInfo(proofBuffer);
      if (recheck) {
        throw new Error(
          'Stale STARK proof buffer exists and cannot be closed. ' +
          'Please wait a few seconds and try again, or use a different wallet.'
        );
      }
    }
  }

  // Step 1: Init proof buffer
  onProgress?.('Initializing proof buffer...');
  const initTx = new Transaction().add(
    buildInitProofBufferIx(proof.proofSize, proof.circuitId, proofBuffer, authority)
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

  // Step 3a: Phase 1 verification — circuit_id-aware dispatch.
  //
  // Circuit 0 (subscriber_ownership) uses the LEGACY proof format
  // (`CompactStarkProof`). The on-chain verifier exposes two ix:
  //   - `verify_stark_proof`     → for C0 ONLY: parses CompactStarkProof and
  //                                runs `verify_subscriber_ownership`.
  //   - `verify_stark_proof_v2`  → for C1..C6: parses GenericCompactProof and
  //                                runs `verify_generic`.
  //
  // The two formats are byte-compatible enough to parse through either
  // entry point (FRI / Merkle / OOD all pass), but `verify_generic`'s
  // trace-aligned constraint reader interprets columns differently than
  // the C0 trace layout, so step 4 (transition constraints) silently
  // fails with InvalidProof. Without this branch, pause / resume /
  // cancel of V3 vaults all simulate-fail with custom error 0x1773.
  // (See programs/p01_stark_verifier/src/lib.rs:108-114 for the legacy
  // dispatch, vs lib.rs:149-178 which always goes generic.)
  onProgress?.('Verifying STARK proof phase 1...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  if (proof.circuitId === 0) {
    // Legacy ix takes a single u64 commitment, not a vec of public_inputs.
    verifyTx.add(buildVerifyStarkProofIx(proof.publicInputs[0], proofBuffer, authority));
  } else {
    verifyTx.add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  }
  const txSig = await signSendConfirm(conn, verifyTx, keypair, walletSigner);

  // Step 3b: Phase 2 — DEEP-ALI at OOD. Mandatory for circuits 1-6 (C0 runs
  // DEEP-ALI inline in phase 1). Combined phase 1+2 exceeds 1.4M CU per-ix,
  // so split across two transactions.
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
