/**
 * STARK Proof Service for the Extension.
 *
 * Browser-extension twin of `apps/mobile/services/stark/index.ts`. Same
 * on-chain contract (Anchor discriminators, PDA scheme, two-phase verify),
 * slimmed down for extension call sites:
 *
 *   - Connection is always provided by the caller — no implicit getConnection
 *     fallback because the extension has per-network connections.
 *   - WalletSigner is required — extension has no local Keypair store; signing
 *     always goes through a provided `signTransaction` callback (injected
 *     wallet, hardware signer, etc.).
 *
 * Program: p01_stark_verifier (DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs)
 */

import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STARK_VERIFIER_PROGRAM_ID = new PublicKey(
  'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
);

const CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;
const CIRCUIT_POOL_COMMITMENT = 1;
const CIRCUIT_BALANCE_PROOF = 2;
const CIRCUIT_MERKLE_PATH = 3;
const CIRCUIT_CONFIDENTIAL_BALANCE = 4;
const CIRCUIT_TRANSFER = 5;
const CIRCUIT_MERKLE_UPDATE = 6;

const MAX_CHUNK_SIZE = 1000;
const PROOF_DATA_OFFSET = 83;
const MAX_INIT_SIZE = 10_240;
const MAX_REALLOC_STEP = 10_240; // Solana MAX_PERMITTED_DATA_INCREASE per realloc

// Instruction discriminators (from Anchor IDL — must match mobile byte-for-byte)
const DISCRIMINATORS = {
  initProofBuffer: Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  resizeProofBuffer: Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]),
  writeProofChunk: Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]),
  verifyStarkProof: Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]),
  verifyStarkProofV2: Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]),
  verifyDeepAliPhase2: Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]),
  closeProofBuffer: Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactStarkProof {
  proofBytes: Uint8Array;
  commitment: bigint;
  proofSize: number;
}

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
}

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function getProofBufferPDA(
  authority: PublicKey,
  circuitId: number = CIRCUIT_SUBSCRIBER_OWNERSHIP,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stark_proof'), authority.toBuffer(), Buffer.from([circuitId])],
    STARK_VERIFIER_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function buildInitProofBufferIx(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
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
  authority: PublicKey,
): TransactionInstruction {
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
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.verifyStarkProof.copy(data, 0);
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
  authority: PublicKey,
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
  authority: PublicKey,
): TransactionInstruction {
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
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

function buildVerifyDeepAliPhase2Ix(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
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
  authority: PublicKey,
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
// Sign / send helper
// ---------------------------------------------------------------------------

async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  signer: WalletSigner,
  opts?: { skipPreflight?: boolean },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  const signed = await signer.signTransaction(tx);

  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: opts?.skipPreflight ?? false,
  });

  try {
    // Blockhash-based confirmation waits until the blockhash actually expires
    // (~60-90s) rather than the deprecated fixed 30s timeout.
    const result = await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (result.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
    }
    return sig;
  } catch (e) {
    // Slow / rate-limited devnet can throw a timeout even when the tx actually
    // landed. Re-check the on-chain status (history-searching) before failing.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const { value } = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (value) {
        if (value.err) throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);
        if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
          return sig;
        }
      }
    }
    throw e;
  }
}

/**
 * Confirm many signatures tolerantly: batch-poll getSignatureStatuses over a
 * long window (handles slow / rate-limited devnet far better than per-signature
 * confirmTransaction with its fixed 30s timeout).
 */
async function confirmSignatures(
  conn: Connection,
  sigs: string[],
  timeoutMs = 90_000,
): Promise<void> {
  const pending = new Set(sigs);
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    const arr = [...pending];
    for (let i = 0; i < arr.length; i += 256) {
      const slice = arr.slice(i, i + 256);
      const { value } = await conn.getSignatureStatuses(slice, { searchTransactionHistory: true });
      slice.forEach((sig, k) => {
        const st = value[k];
        if (st) {
          if (st.err) throw new Error(`Chunk upload failed: ${JSON.stringify(st.err)}`);
          if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
            pending.delete(sig);
          }
        }
      });
    }
    if (pending.size === 0) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (pending.size > 0) {
    throw new Error(`Chunk upload timed out: ${pending.size} chunk(s) unconfirmed`);
  }
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/**
 * Submit and verify a circuit-0 (subscriber_ownership) STARK proof, then close
 * the buffer to recover rent. Mirrors `submitStarkProof` from mobile.
 */
export async function submitStarkProof(
  proof: CompactStarkProof,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<StarkVerificationResult> {
  const authority = signer.publicKey;
  const [proofBuffer] = getProofBufferPDA(authority);

  const existing = await connection.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing stale proof buffer...');
    const closeTx = new Transaction().add(buildCloseProofBufferIx(proofBuffer, authority));
    await signSendConfirm(connection, closeTx, signer);
  }

  onProgress?.('Initializing proof buffer...');
  const initTx = new Transaction().add(
    buildInitProofBufferIx(proof.proofSize, CIRCUIT_SUBSCRIBER_OWNERSHIP, proofBuffer, authority),
  );
  await signSendConfirm(connection, initTx, signer);

  // Grow the buffer to the FULL proof size. Anchor realloc grows by at most
  // MAX_REALLOC_STEP (10KB) per call, so large proofs (e.g. circuit 6) need
  // several resize txs — a single resize leaves the buffer too small and a
  // later chunk write aborts with ProgramFailedToComplete.
  const resizeTarget = proof.proofSize + PROOF_DATA_OFFSET;
  if (resizeTarget > MAX_INIT_SIZE) {
    const resizesNeeded = Math.ceil((resizeTarget - MAX_INIT_SIZE) / MAX_REALLOC_STEP);
    for (let r = 0; r < resizesNeeded; r++) {
      onProgress?.(`Resizing proof buffer (${r + 1}/${resizesNeeded})...`);
      const resizeTx = new Transaction().add(buildResizeProofBufferIx(proofBuffer, authority));
      await signSendConfirm(connection, resizeTx, signer);
    }
  }

  // A blockhash is valid for ~150 slots (60-90 s), but a ~140 KB proof takes
  // minutes to upload. One blockhash fetched up front expires mid-loop and every
  // remaining chunk dies with "Blockhash not found". Refresh it as we go.
  const CHUNK_BLOCKHASH_MAX_AGE_MS = 30_000;
  let chunkBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  let chunkBlockhashAt = Date.now();
  const totalChunks = Math.ceil(proof.proofBytes.length / MAX_CHUNK_SIZE);
  const chunkSigs: string[] = [];

  for (let i = 0, offset = 0; offset < proof.proofBytes.length; i++, offset += MAX_CHUNK_SIZE) {
    onProgress?.(`Uploading proof chunk ${i + 1}/${totalChunks}...`);
    if (Date.now() - chunkBlockhashAt > CHUNK_BLOCKHASH_MAX_AGE_MS) {
      chunkBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      chunkBlockhashAt = Date.now();
    }
    const end = Math.min(offset + MAX_CHUNK_SIZE, proof.proofBytes.length);
    const chunk = proof.proofBytes.slice(offset, end);
    const chunkTx = new Transaction().add(
      buildWriteProofChunkIx(offset, chunk, proofBuffer, authority),
    );
    chunkTx.recentBlockhash = chunkBlockhash;
    chunkTx.feePayer = authority;
    const signed = await signer.signTransaction(chunkTx);

    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    chunkSigs.push(sig);
  }

  onProgress?.('Confirming chunk uploads...');
  await confirmSignatures(connection, chunkSigs);

  onProgress?.('Verifying STARK proof on-chain...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofIx(proof.commitment, proofBuffer, authority));
  const txSig = await signSendConfirm(connection, verifyTx, signer);

  onProgress?.('Closing proof buffer...');
  const closeTx = new Transaction().add(buildCloseProofBufferIx(proofBuffer, authority));
  await signSendConfirm(connection, closeTx, signer).catch(() => {
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
 * Return the current on-chain status of the proof buffer for `authority`.
 */
export async function getProofBufferStatus(
  authority: PublicKey,
  connection: Connection,
): Promise<{ exists: boolean; verified: boolean }> {
  const [proofBuffer] = getProofBufferPDA(authority);
  const info = await connection.getAccountInfo(proofBuffer);
  if (!info) return { exists: false, verified: false };
  // Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified
  const verified = info.data[8 + 32 + 1 + 4 + 4] === 1;
  return { exists: true, verified };
}

/**
 * Submit + verify (phase 1 + DEEP-ALI phase 2) + close a generic STARK proof
 * (circuits 1–6). Mirrors `submitGenericStarkProof` from mobile.
 */
export async function submitGenericStarkProof(
  proof: GenericStarkProof,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<StarkVerificationResult> {
  const { proofBuffer, txSignature } = await submitAndVerifyStarkProof(
    proof,
    signer,
    connection,
    onProgress,
  );
  await closeStarkProofBuffer(proofBuffer, signer, connection);
  return {
    verified: true,
    txSignature,
    commitment: proof.publicInputs[0] ?? 0n,
    proofSize: proof.proofSize,
  };
}

/**
 * Upload + verify a generic STARK proof but leave the buffer alive so a
 * subsequent instruction (e.g. `unshield_denominated_stark`,
 * `transfer_denominated_stark`) can cross-program-read it. Caller is
 * responsible for calling `closeStarkProofBuffer` afterwards.
 */
export async function submitAndVerifyStarkProof(
  proof: GenericStarkProof,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<{ proofBuffer: PublicKey; authority: PublicKey; txSignature: string }> {
  const authority = signer.publicKey;
  const [proofBuffer] = getProofBufferPDA(authority, proof.circuitId);

  const existing = await connection.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing stale proof buffer...');
    try {
      const closeTx = new Transaction().add(buildCloseProofBufferIx(proofBuffer, authority));
      await signSendConfirm(connection, closeTx, signer);
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
      const recheck = await connection.getAccountInfo(proofBuffer);
      if (recheck) {
        throw new Error(
          'Stale STARK proof buffer exists and cannot be closed. ' +
            'Please wait a few seconds and try again, or use a different wallet.',
        );
      }
    }
  }

  onProgress?.('Initializing proof buffer...');
  const initTx = new Transaction().add(
    buildInitProofBufferIx(proof.proofSize, proof.circuitId, proofBuffer, authority),
  );
  await signSendConfirm(connection, initTx, signer);

  // Grow the buffer to the FULL proof size. Anchor realloc grows by at most
  // MAX_REALLOC_STEP (10KB) per call, so large proofs (e.g. circuit 6) need
  // several resize txs — a single resize leaves the buffer too small and a
  // later chunk write aborts with ProgramFailedToComplete.
  const resizeTarget = proof.proofSize + PROOF_DATA_OFFSET;
  if (resizeTarget > MAX_INIT_SIZE) {
    const resizesNeeded = Math.ceil((resizeTarget - MAX_INIT_SIZE) / MAX_REALLOC_STEP);
    for (let r = 0; r < resizesNeeded; r++) {
      onProgress?.(`Resizing proof buffer (${r + 1}/${resizesNeeded})...`);
      const resizeTx = new Transaction().add(buildResizeProofBufferIx(proofBuffer, authority));
      await signSendConfirm(connection, resizeTx, signer);
    }
  }

  // A blockhash is valid for ~150 slots (60-90 s), but a ~140 KB proof takes
  // minutes to upload. One blockhash fetched up front expires mid-loop and every
  // remaining chunk dies with "Blockhash not found". Refresh it as we go.
  const CHUNK_BLOCKHASH_MAX_AGE_MS = 30_000;
  let chunkBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  let chunkBlockhashAt = Date.now();
  const totalChunks = Math.ceil(proof.proofBytes.length / MAX_CHUNK_SIZE);
  const chunkSigs: string[] = [];

  for (let i = 0, offset = 0; offset < proof.proofBytes.length; i++, offset += MAX_CHUNK_SIZE) {
    onProgress?.(`Uploading proof chunk ${i + 1}/${totalChunks}...`);
    if (Date.now() - chunkBlockhashAt > CHUNK_BLOCKHASH_MAX_AGE_MS) {
      chunkBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      chunkBlockhashAt = Date.now();
    }
    const end = Math.min(offset + MAX_CHUNK_SIZE, proof.proofBytes.length);
    const chunk = proof.proofBytes.slice(offset, end);
    const chunkTx = new Transaction().add(
      buildWriteProofChunkIx(offset, chunk, proofBuffer, authority),
    );
    chunkTx.recentBlockhash = chunkBlockhash;
    chunkTx.feePayer = authority;
    const signed = await signer.signTransaction(chunkTx);

    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    chunkSigs.push(sig);
  }

  onProgress?.('Confirming chunk uploads...');
  await confirmSignatures(connection, chunkSigs);

  onProgress?.('Verifying STARK proof phase 1...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  const txSignature = await signSendConfirm(connection, verifyTx, signer);

  // Phase 2 (DEEP-ALI at OOD) — mandatory for circuits 1–6. Circuit 0 runs
  // DEEP-ALI inline in phase 1. Combined phase 1+2 exceeds the 1.4M CU per-ix
  // budget, so we split across two transactions.
  if (proof.circuitId >= 1 && proof.circuitId <= 6) {
    onProgress?.('Verifying STARK proof phase 2 (DEEP-ALI)...');
    const deepAliTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority));
    await signSendConfirm(connection, deepAliTx, signer);
  }

  onProgress?.('STARK proof verified (buffer retained for cross-program read)');
  return { proofBuffer, authority, txSignature };
}

/**
 * Close a proof buffer and recover rent. Call after the consuming instruction
 * (shield/transfer/unshield) has read the buffer.
 */
export async function closeStarkProofBuffer(
  proofBuffer: PublicKey,
  signer: WalletSigner,
  connection: Connection,
): Promise<void> {
  const closeTx = new Transaction().add(
    buildCloseProofBufferIx(proofBuffer, signer.publicKey),
  );
  await signSendConfirm(connection, closeTx, signer).catch(() => {
    console.warn('[STARK] Failed to close proof buffer, rent not recovered');
  });
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

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
