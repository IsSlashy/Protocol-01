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
const MAX_CHUNK_SIZE = 900; // Safe tx size for proof upload

// Instruction discriminators (from Anchor IDL)
const DISCRIMINATORS = {
  initProofBuffer: Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  resizeProofBuffer: Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]),
  writeProofChunk: Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]),
  verifyStarkProof: Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]),
  verifyStarkProofV2: Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]),
  closeProofBuffer: Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]),
};

const PROOF_DATA_OFFSET = 50; // 8 disc + 32 pubkey + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified
const MAX_INIT_SIZE = 10_240; // Solana create_account limit

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
// Transaction signing helper (supports Keypair and Privy WalletSigner)
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
 * Submit and verify a STARK proof on-chain.
 *
 * Flow:
 * 1. Init proof buffer PDA (or clean up stale one)
 * 2. Upload proof in chunks (900 bytes per tx)
 * 3. Call verify_stark_proof with commitment (~900K CU)
 * 4. Close buffer and recover rent
 *
 * Supports both local Keypair and Privy WalletSigner.
 * If neither is provided, reads keypair from SecureStore.
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

  // Step 1b: Resize if proof > 10KB
  if (proof.proofSize + PROOF_DATA_OFFSET > MAX_INIT_SIZE) {
    onProgress?.('Resizing proof buffer...');
    const resizeTx = new Transaction().add(
      buildResizeProofBufferIx(proofBuffer, authority)
    );
    await signSendConfirm(conn, resizeTx, keypair, walletSigner);
  }

  // Step 2: Upload proof in chunks
  const totalChunks = Math.ceil(proof.proofBytes.length / MAX_CHUNK_SIZE);
  for (let i = 0, offset = 0; offset < proof.proofBytes.length; i++, offset += MAX_CHUNK_SIZE) {
    onProgress?.(`Uploading proof chunk ${i + 1}/${totalChunks}...`);
    const end = Math.min(offset + MAX_CHUNK_SIZE, proof.proofBytes.length);
    const chunk = proof.proofBytes.slice(offset, end);

    const chunkTx = new Transaction().add(
      buildWriteProofChunkIx(offset, chunk, proofBuffer, authority)
    );
    await signSendConfirm(conn, chunkTx, keypair, walletSigner);
  }

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

  // Step 1b: Resize if proof > 10KB
  if (proof.proofSize + PROOF_DATA_OFFSET > MAX_INIT_SIZE) {
    onProgress?.('Resizing proof buffer...');
    const resizeTx = new Transaction().add(
      buildResizeProofBufferIx(proofBuffer, authority)
    );
    await signSendConfirm(conn, resizeTx, keypair, walletSigner);
  }

  // Step 2: Upload proof in chunks
  const totalChunks = Math.ceil(proof.proofBytes.length / MAX_CHUNK_SIZE);
  for (let i = 0, offset = 0; offset < proof.proofBytes.length; i++, offset += MAX_CHUNK_SIZE) {
    onProgress?.(`Uploading proof chunk ${i + 1}/${totalChunks}...`);
    const end = Math.min(offset + MAX_CHUNK_SIZE, proof.proofBytes.length);
    const chunk = proof.proofBytes.slice(offset, end);

    const chunkTx = new Transaction().add(
      buildWriteProofChunkIx(offset, chunk, proofBuffer, authority)
    );
    await signSendConfirm(conn, chunkTx, keypair, walletSigner);
  }

  // Step 3: Verify with v2 (multiple public inputs)
  onProgress?.('Verifying STARK proof on-chain...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  const txSig = await signSendConfirm(conn, verifyTx, keypair, walletSigner);

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

  // Step 1b: Resize if proof > 10KB
  if (proof.proofSize + PROOF_DATA_OFFSET > MAX_INIT_SIZE) {
    onProgress?.('Resizing proof buffer...');
    const resizeTx = new Transaction().add(
      buildResizeProofBufferIx(proofBuffer, authority)
    );
    await signSendConfirm(conn, resizeTx, keypair, walletSigner);
  }

  // Step 2: Upload proof in chunks
  const totalChunks = Math.ceil(proof.proofBytes.length / MAX_CHUNK_SIZE);
  for (let i = 0, offset = 0; offset < proof.proofBytes.length; i++, offset += MAX_CHUNK_SIZE) {
    onProgress?.(`Uploading proof chunk ${i + 1}/${totalChunks}...`);
    const end = Math.min(offset + MAX_CHUNK_SIZE, proof.proofBytes.length);
    const chunk = proof.proofBytes.slice(offset, end);
    const chunkTx = new Transaction().add(
      buildWriteProofChunkIx(offset, chunk, proofBuffer, authority)
    );
    await signSendConfirm(conn, chunkTx, keypair, walletSigner);
  }

  // Step 3: Verify with v2 (multiple public inputs)
  onProgress?.('Verifying STARK proof on-chain...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  const txSig = await signSendConfirm(conn, verifyTx, keypair, walletSigner);

  onProgress?.('STARK proof verified (buffer retained for cross-program read)');
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
};
