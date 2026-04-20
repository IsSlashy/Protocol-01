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
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  const signed = await signer.signTransaction(tx);

  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: opts?.skipPreflight ?? false,
  });
  const result = await conn.confirmTransaction(sig, 'confirmed');
  if (result.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  }
  return sig;
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

  if (proof.proofSize + PROOF_DATA_OFFSET > MAX_INIT_SIZE) {
    onProgress?.('Resizing proof buffer...');
    const resizeTx = new Transaction().add(buildResizeProofBufferIx(proofBuffer, authority));
    await signSendConfirm(connection, resizeTx, signer);
  }

  const { blockhash: chunkBlockhash } = await connection.getLatestBlockhash('confirmed');
  const totalChunks = Math.ceil(proof.proofBytes.length / MAX_CHUNK_SIZE);
  const chunkSigs: string[] = [];

  for (let i = 0, offset = 0; offset < proof.proofBytes.length; i++, offset += MAX_CHUNK_SIZE) {
    onProgress?.(`Uploading proof chunk ${i + 1}/${totalChunks}...`);
    const end = Math.min(offset + MAX_CHUNK_SIZE, proof.proofBytes.length);
    const chunk = proof.proofBytes.slice(offset, end);
    const chunkTx = new Transaction().add(
      buildWriteProofChunkIx(offset, chunk, proofBuffer, authority),
    );
    chunkTx.recentBlockhash = chunkBlockhash;
    chunkTx.feePayer = authority;
    const signed = await signer.signTransaction(chunkTx);

    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    chunkSigs.push(sig);
  }

  onProgress?.('Confirming chunk uploads...');
  await Promise.all(
    chunkSigs.map(async (sig) => {
      const result = await connection.confirmTransaction(sig, 'confirmed');
      if (result.value.err) {
        throw new Error(`Chunk upload failed: ${JSON.stringify(result.value.err)}`);
      }
    }),
  );

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

  if (proof.proofSize + PROOF_DATA_OFFSET > MAX_INIT_SIZE) {
    onProgress?.('Resizing proof buffer...');
    const resizeTx = new Transaction().add(buildResizeProofBufferIx(proofBuffer, authority));
    await signSendConfirm(connection, resizeTx, signer);
  }

  const { blockhash: chunkBlockhash } = await connection.getLatestBlockhash('confirmed');
  const totalChunks = Math.ceil(proof.proofBytes.length / MAX_CHUNK_SIZE);
  const chunkSigs: string[] = [];

  for (let i = 0, offset = 0; offset < proof.proofBytes.length; i++, offset += MAX_CHUNK_SIZE) {
    onProgress?.(`Uploading proof chunk ${i + 1}/${totalChunks}...`);
    const end = Math.min(offset + MAX_CHUNK_SIZE, proof.proofBytes.length);
    const chunk = proof.proofBytes.slice(offset, end);
    const chunkTx = new Transaction().add(
      buildWriteProofChunkIx(offset, chunk, proofBuffer, authority),
    );
    chunkTx.recentBlockhash = chunkBlockhash;
    chunkTx.feePayer = authority;
    const signed = await signer.signTransaction(chunkTx);

    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    chunkSigs.push(sig);
  }

  onProgress?.('Confirming chunk uploads...');
  await Promise.all(
    chunkSigs.map(async (sig) => {
      const result = await connection.confirmTransaction(sig, 'confirmed');
      if (result.value.err) {
        throw new Error(`Chunk upload failed: ${JSON.stringify(result.value.err)}`);
      }
    }),
  );

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
