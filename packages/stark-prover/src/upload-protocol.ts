/**
 * Chunked upload + two-phase DEEP-ALI verify protocol for the
 * `p01_stark_verifier` Solana program.
 *
 * Extracted from `apps/mobile/services/stark/index.ts` and generalized:
 * the mobile copy is tightly coupled to its `getKeypair()` / Privy
 * `WalletSigner` plumbing, while this version takes both as explicit
 * parameters so the same protocol works in Node tests, a browser extension
 * service worker, and React Native.
 *
 * Protocol summary (a.k.a. "STARK proof submission flow"):
 *   1. Init the per-(authority, circuit_id) PDA proof buffer with the
 *      proof size baked in.
 *   2. Resize iteratively to fit the full proof (~50 KB) — Anchor realloc
 *      grows by 10 KB per call, so we send N parallel resize TXs with
 *      distinct compute-unit prices to keep their signatures unique.
 *   3. Upload proof bytes in 1000-byte chunks, batched per blockhash, with
 *      retries on dropped TXs.
 *   4. Phase 1 verify (`verify_stark_proof_v2`) — FRI + trace-aligned
 *      constraints + boundary. ~1.4M CU.
 *   5. Phase 2 verify (`verify_deep_ali_phase2`) — DEEP-ALI at OOD.
 *      Mandatory for circuits 1-6, inline for circuit 0. Another ~1.4M CU.
 *   6. Optionally close the buffer to recover rent. By default we KEEP it
 *      so a follow-on instruction (e.g. `zk_shielded`) can read the
 *      verified flag and public-inputs hash.
 *
 * Discriminators are pinned to the IDL emitted by the Anchor build of
 * `programs/p01_stark_verifier`. If that program is rebuilt with a
 * non-default discriminator config, regenerate these bytes from the new
 * IDL.
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

import {
  DEFAULT_STARK_VERIFIER_PROGRAM_ID,
  type WalletSigner,
} from './types';

// ---------------------------------------------------------------------------
// Constants — DO NOT CHANGE without rebuilding p01_stark_verifier
// ---------------------------------------------------------------------------

/** Max bytes per chunk — fits comfortably under Solana's 1232-byte tx limit. */
export const MAX_CHUNK_SIZE = 1000;

/** Anchor account header offset = 8 disc + 32 pubkey + 1 + 4 + 4 + 1 + 32 + 1. */
export const PROOF_DATA_OFFSET = 83;

/** Solana per-account create_account upper bound. */
export const MAX_INIT_SIZE = 10_240;

/** Solana MAX_PERMITTED_DATA_INCREASE per realloc call. */
export const MAX_REALLOC_STEP = 10_240;

/**
 * Anchor instruction discriminators (8-byte SHA256-of-`global:<name>` prefix).
 * Sourced from `programs/p01_stark_verifier`'s IDL — verified against the
 * mobile twin (`apps/mobile/services/stark/index.ts`).
 */
export const DISCRIMINATORS = {
  initProofBuffer:      new Uint8Array([49, 27, 28, 88, 19, 99, 133, 194]),
  resizeProofBuffer:    new Uint8Array([187, 39, 46, 173, 247, 90, 178, 205]),
  writeProofChunk:      new Uint8Array([183, 3, 171, 138, 153, 138, 133, 147]),
  verifyStarkProof:     new Uint8Array([208, 216, 183, 38, 47, 69, 156, 138]),
  verifyStarkProofV2:   new Uint8Array([149, 18, 96, 15, 144, 68, 8, 233]),
  verifyDeepAliPhase2:  new Uint8Array([217, 239, 203, 65, 109, 182, 70, 115]),
  closeProofBuffer:     new Uint8Array([130, 150, 6, 35, 193, 34, 243, 87]),
} as const;

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

export function getProofBufferPda(
  authority: PublicKey,
  circuitId: number,
  programId: PublicKey = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID),
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      new Uint8Array([
        ...new TextEncoder().encode('stark_proof'),
      ]),
      authority.toBuffer(),
      new Uint8Array([circuitId]),
    ],
    programId,
  );
}

// ---------------------------------------------------------------------------
// Borsh helpers (no `@coral-xyz/anchor` dep — keep the package tiny)
// ---------------------------------------------------------------------------

function u32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, true);
  return buf;
}

function u64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function concat(...parts: Uint8Array[]): Buffer {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function buildInitProofBufferIx(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: concat(DISCRIMINATORS.initProofBuffer, u32LE(proofSize), new Uint8Array([circuitId])),
  });
}

function buildWriteProofChunkIx(
  offset: number,
  chunk: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  // offset (u32 LE) + Borsh Vec<u8>: 4-byte length prefix + data
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(DISCRIMINATORS.writeProofChunk, u32LE(offset), u32LE(chunk.length), chunk),
  });
}

function buildResizeProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.resizeProofBuffer),
  });
}

function buildVerifyStarkProofIx(
  commitment: bigint,
  proofBuffer: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(DISCRIMINATORS.verifyStarkProof, u64LE(commitment)),
  });
}

function buildVerifyStarkProofV2Ix(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(
      DISCRIMINATORS.verifyStarkProofV2,
      u32LE(publicInputs.length),
      ...publicInputs.map(u64LE),
    ),
  });
}

function buildVerifyDeepAliPhase2Ix(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(
      DISCRIMINATORS.verifyDeepAliPhase2,
      u32LE(publicInputs.length),
      ...publicInputs.map(u64LE),
    ),
  });
}

export function buildCloseProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
  programId: PublicKey = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID),
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(DISCRIMINATORS.closeProofBuffer),
  });
}

// ---------------------------------------------------------------------------
// Tx signing helpers
// ---------------------------------------------------------------------------

function isKeypair(payer: Keypair | WalletSigner): payer is Keypair {
  return 'secretKey' in (payer as object);
}

async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  payer: Keypair | WalletSigner,
  opts?: { skipPreflight?: boolean },
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;

  let signed: Transaction = tx;
  if (isKeypair(payer)) {
    signed.sign(payer);
  } else {
    signed = await payer.signTransaction(tx);
  }

  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: opts?.skipPreflight ?? false,
  });
  const result = await conn.confirmTransaction(sig, 'confirmed');
  if (result.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  }
  return sig;
}

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
        conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.status === 'fulfilled') {
        sigs[w + i] = r.value;
      } else {
        const reason = r && 'reason' in r ? r.reason : undefined;
        const message = reason instanceof Error ? reason.message : String(reason);
        throw new Error(`sendRawTransaction failed for tx[${w + i}]: ${message}`);
      }
    }
    if (waveEnd < signedTxs.length) {
      await new Promise(r => setTimeout(r, waveDelayMs));
    }
  }
  return sigs;
}

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
        `${label} confirmation timeout: ${confirmed.size}/${sigs.length} confirmed after ${timeoutMs}ms`,
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
      console.warn(`[stark-prover] ${label} soft timeout: ${confirmed.size}/${sigs.length} confirmed, ${unconfirmed.length} will retry`);
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

// ---------------------------------------------------------------------------
// Resize + upload pipeline
// ---------------------------------------------------------------------------

async function resizeToTarget(
  conn: Connection,
  targetSize: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
  payer: Keypair | WalletSigner,
  programId: PublicKey,
  onProgress?: (step: string) => void,
): Promise<void> {
  if (targetSize <= MAX_INIT_SIZE) return;
  const resizesNeeded = Math.ceil((targetSize - MAX_INIT_SIZE) / MAX_REALLOC_STEP);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');

  // Each TX needs a UNIQUE compute-unit price so the serialized bytes (and
  // therefore the signature) differ. Otherwise Solana would dedupe N
  // identical resize TXs into one and the buffer wouldn't grow.
  const signedTxs = await Promise.all(
    Array.from({ length: resizesNeeded }, async (_, i) => {
      onProgress?.(`Resizing proof buffer (${i + 1}/${resizesNeeded})...`);
      let tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: i + 1 }))
        .add(buildResizeProofBufferIx(proofBuffer, authority, programId));
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      if (isKeypair(payer)) {
        tx.sign(payer);
      } else {
        tx = await payer.signTransaction(tx);
      }
      return tx;
    }),
  );

  const sigs = await sendTxsInWaves(conn, signedTxs);
  await confirmAllBatched(conn, sigs, 'Resize');
}

async function uploadChunksParallel(
  conn: Connection,
  proofBytes: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
  payer: Keypair | WalletSigner,
  programId: PublicKey,
  onProgress?: (step: string) => void,
): Promise<void> {
  const totalChunks = Math.ceil(proofBytes.length / MAX_CHUNK_SIZE);
  const BATCH_SIZE = 20; // chunks per blockhash window
  const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);
  const MAX_BATCH_RETRIES = 4;

  for (let batchStart = 0; batchStart < totalChunks; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalChunks);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;

    interface Chunk { offset: number; data: Uint8Array }
    let remaining: Chunk[] = Array.from({ length: batchEnd - batchStart }, (_, j) => {
      const i = batchStart + j;
      const off = i * MAX_CHUNK_SIZE;
      const end = Math.min(off + MAX_CHUNK_SIZE, proofBytes.length);
      return { offset: off, data: proofBytes.slice(off, end) };
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
            buildWriteProofChunkIx(offset, data, proofBuffer, authority, programId),
          );
          tx.recentBlockhash = blockhash;
          tx.feePayer = payer.publicKey;
          if (isKeypair(payer)) {
            tx.sign(payer);
          } else {
            tx = await payer.signTransaction(tx);
          }
          return tx;
        }),
      );
      const sigs = await sendTxsInWaves(conn, signedTxs);
      const unconfirmed = await confirmAllBatchedSoft(
        conn, sigs, `Chunk batch ${batchNum} attempt ${attempt + 1}`,
      );
      if (unconfirmed.length === 0) break;
      const next: Chunk[] = [];
      for (const i of unconfirmed) {
        const c = remaining[i];
        if (c !== undefined) next.push(c);
      }
      remaining = next;
      if (attempt === MAX_BATCH_RETRIES - 1) {
        throw new Error(
          `Chunk batch ${batchNum} failed after ${MAX_BATCH_RETRIES} attempts: ${remaining.length} chunks still unconfirmed`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface UploadAndVerifyOptions {
  /** If true, skip the close-buffer step so a follow-up ix can read the PDA. */
  retainBuffer?: boolean;
  /** Override the on-chain program ID (defaults to the canonical deployment). */
  programId?: PublicKey;
  /** Progress callback fired at every phase boundary. */
  onProgress?: (step: string) => void;
}

export interface UploadAndVerifyResult {
  /** The verified proof buffer PDA (still open if retainBuffer). */
  proofBufferPda: PublicKey;
  /** Final tx signature (Phase-2 verify, or Phase-1 for circuit 0). */
  signature: string;
  /** Authority that signed the upload — same as `payer.publicKey`. */
  authority: PublicKey;
}

/**
 * End-to-end: init buffer → resize → upload chunks → verify phase 1 →
 * (circuits 1-6) verify phase 2 → optionally close.
 *
 * Returns the proof-buffer PDA so the caller can pass it to a downstream
 * instruction (`zk_shielded` reads it cross-program). When `retainBuffer`
 * is false, the buffer is closed and rent recovered.
 */
export async function uploadAndVerify(
  connection: Connection,
  payer: Keypair | WalletSigner,
  circuitId: number,
  proofBytes: Uint8Array,
  publicInputs: bigint[],
  options: UploadAndVerifyOptions = {},
): Promise<UploadAndVerifyResult> {
  const programId = options.programId ?? new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID);
  const retain = options.retainBuffer ?? true;
  const onProgress = options.onProgress;

  const authority = payer.publicKey;
  const [proofBuffer] = getProofBufferPda(authority, circuitId, programId);

  // Step 0: clean up stale buffer (rare — only if a prior run crashed mid-pipeline).
  const existing = await connection.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing stale proof buffer...');
    const closeTx = new Transaction().add(
      buildCloseProofBufferIx(proofBuffer, authority, programId),
    );
    try {
      await signSendConfirm(connection, closeTx, payer);
    } catch (closeErr) {
      // Buffer exists but can't be closed — likely due to bad state. Re-check
      // and fail loud rather than fight the chain.
      await new Promise(r => setTimeout(r, 2000));
      const recheck = await connection.getAccountInfo(proofBuffer);
      if (recheck) {
        throw new Error(
          'Stale STARK proof buffer exists and cannot be closed. Wait a few seconds and try again, or use a different authority.',
        );
      }
    }
  }

  // Step 1: init buffer.
  onProgress?.('Initializing proof buffer...');
  const initTx = new Transaction().add(
    buildInitProofBufferIx(proofBytes.length, circuitId, proofBuffer, authority, programId),
  );
  await signSendConfirm(connection, initTx, payer);

  // Step 1b: resize to target.
  await resizeToTarget(
    connection,
    proofBytes.length + PROOF_DATA_OFFSET,
    proofBuffer,
    authority,
    payer,
    programId,
    onProgress,
  );

  // Step 2: upload chunks.
  await uploadChunksParallel(connection, proofBytes, proofBuffer, authority, payer, programId, onProgress);

  // Step 3a: phase 1 verify.
  onProgress?.('Verifying STARK proof phase 1...');
  let phase1Tx: Transaction;
  if (circuitId === 0) {
    // Circuit 0 still uses the legacy `verify_stark_proof` (commitment as u64).
    const commitment = publicInputs[0] ?? 0n;
    phase1Tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(buildVerifyStarkProofIx(commitment, proofBuffer, authority, programId));
  } else {
    phase1Tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(buildVerifyStarkProofV2Ix(publicInputs, proofBuffer, authority, programId));
  }
  let signature = await signSendConfirm(connection, phase1Tx, payer);

  // Step 3b: phase 2 verify (DEEP-ALI). Mandatory for circuits 1-7.
  // [C7 2026-08-24] INVERTED, on purpose. This used to read
  // `circuitId >= 1 && circuitId <= 6`, which is an ALLOW-LIST: every
  // circuit added after it was written silently skipped phase 2 and the
  // upload reported success on a half-verified proof. C7 would have been
  // the first victim and it is the circuit that can least afford it --
  // phase 2 carries its entire public-input-to-trace binding.
  //
  // Now it is a DENY-list of one. Circuit 0 is the legacy single-phase
  // path; everything else gets phase 2 by default, including circuits
  // that do not exist yet.
  const PHASE1_ONLY = new Set([0]);
  if (!PHASE1_ONLY.has(circuitId)) {
    onProgress?.('Verifying STARK proof phase 2 (DEEP-ALI)...');
    const phase2Tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(buildVerifyDeepAliPhase2Ix(publicInputs, proofBuffer, authority, programId));
    signature = await signSendConfirm(connection, phase2Tx, payer);
  }

  // Step 4: optionally close buffer.
  if (!retain) {
    onProgress?.('Closing proof buffer...');
    const closeTx = new Transaction().add(
      buildCloseProofBufferIx(proofBuffer, authority, programId),
    );
    await signSendConfirm(connection, closeTx, payer).catch(() => {
      // Non-critical: rent will be recoverable later.
      console.warn('[stark-prover] Failed to close proof buffer; rent not recovered.');
    });
  } else {
    onProgress?.('STARK proof verified (buffer retained for cross-program read).');
  }

  return { proofBufferPda: proofBuffer, signature, authority };
}

/**
 * Standalone close — call after the consuming instruction has read the
 * verified proof buffer (e.g. after `zk_shielded.shield_stark`).
 */
export async function closeProofBuffer(
  connection: Connection,
  payer: Keypair | WalletSigner,
  proofBuffer: PublicKey,
  programId: PublicKey = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID),
): Promise<void> {
  const closeTx = new Transaction().add(
    buildCloseProofBufferIx(proofBuffer, payer.publicKey, programId),
  );
  await signSendConfirm(connection, closeTx, payer).catch(() => {
    console.warn('[stark-prover] Failed to close proof buffer; rent not recovered.');
  });
}
