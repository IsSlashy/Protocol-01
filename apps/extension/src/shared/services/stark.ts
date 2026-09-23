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
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { compileV1ChunkMessage, encodeV1Wire, isTransactionV1Active, V1_CHUNK_SIZE } from './txv1';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STARK_VERIFIER_PROGRAM_ID = new PublicKey(
  'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
);

const CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;
const CIRCUIT_POOL_COMMITMENT = 1;
// No constant for circuits 2, 4 and 5: the prover blob shipped on 2026-09-23
// (241caaab) has no prover for them, so no client can build their proofs.
// Same set as apps/mobile/services/stark and packages/stark-prover.
const CIRCUIT_MERKLE_PATH = 3;
const CIRCUIT_MERKLE_UPDATE = 6;
/**
 * [C7] The spend circuit: C1's pool commitment and C3's Merkle path proven in
 * ONE trace, so the note commitment is never a public input.
 */
const CIRCUIT_SPEND = 7;

const MAX_CHUNK_SIZE = 1000;
const PROOF_DATA_OFFSET = 83;
const MAX_INIT_SIZE = 10_240;
const MAX_REALLOC_STEP = 10_240; // Solana MAX_PERMITTED_DATA_INCREASE per realloc

// Instruction discriminators (from Anchor IDL — must match mobile byte-for-byte)
const DISCRIMINATORS = {
  initProofBuffer: Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  // sha256("global:init_proof_buffer_v3")[..8] / sha256("global:reset_proof_buffer")[..8]
  initProofBufferV3: Buffer.from([239, 25, 230, 31, 173, 116, 84, 51]),
  resetProofBuffer: Buffer.from([54, 87, 185, 180, 122, 35, 136, 127]),
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
  /** [TX-V1] raw ed25519 over message bytes; present on keypair signers, absent on injected wallets (legacy chunks). */
  signBytes?: (message: Uint8Array) => Promise<Uint8Array>;
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

// ---------------------------------------------------------------------------
// [L2-CLIENT 2026-09-13] Pre-sized proof buffers: ONE transaction, not nine.
// Twin of `apps/web/lib/privacy/pool/stark.ts`; the rationale lives there.
// ---------------------------------------------------------------------------
const PROOF_BUFFER_KEY_DOMAIN = 'p01/stark-proof-buffer/v3';
const PROOF_BUFFER_KEY_ATTEMPTS = 4;

/** Derived from PUBLIC data: findable like a PDA; the key only signs `createAccount`. */
export function deriveProofBufferKeypair(
  authority: PublicKey,
  circuitId: number,
  attempt = 0,
): Keypair {
  const seed = sha256(
    concatBytes(
      utf8ToBytes(PROOF_BUFFER_KEY_DOMAIN),
      authority.toBytes(),
      Uint8Array.of(circuitId & 0xff, attempt & 0xff),
    ),
  );
  return Keypair.fromSeed(seed);
}

function buildInitProofBufferV3Ix(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 1);
  DISCRIMINATORS.initProofBufferV3.copy(data, 0);
  data.writeUInt32LE(proofSize, 8);
  data.writeUInt8(circuitId, 12);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildResetProofBufferIx(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 1);
  DISCRIMINATORS.resetProofBuffer.copy(data, 0);
  data.writeUInt32LE(proofSize, 8);
  data.writeUInt8(circuitId, 12);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

interface ProofBufferState {
  owner: PublicKey;
  authority: PublicKey;
  circuitId: number;
  proofSize: number;
  verified: boolean;
  deepAliVerified: boolean;
  space: number;
}

function parseProofBufferState(owner: PublicKey, data: Uint8Array): ProofBufferState | null {
  if (data.length < PROOF_DATA_OFFSET) return null;
  const d = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    owner,
    authority: new PublicKey(d.subarray(8, 40)),
    circuitId: d[40],
    proofSize: d.readUInt32LE(41),
    verified: d[49] === 1,
    deepAliVerified: d[82] === 1,
    space: data.length,
  };
}

async function readProofBufferState(
  connection: Connection,
  proofBuffer: PublicKey,
): Promise<ProofBufferState | null> {
  const info = await connection.getAccountInfo(proofBuffer);
  if (!info) return null;
  return parseProofBufferState(info.owner ?? PublicKey.default, info.data);
}

function isUnknownInstruction(e: unknown): boolean {
  const msg = (e as Error)?.message ?? String(e);
  return /InstructionFallbackNotFound|Fallback functions are not supported|custom program error: (0x65|101)\b/i.test(msg);
}

/** `createAccount` + `init_proof_buffer_v3` in one transaction, or `reset_proof_buffer` on our own earlier buffer. */
async function allocateProofBuffer(
  connection: Connection,
  signer: WalletSigner,
  proofSize: number,
  circuitId: number,
  onProgress?: (step: string) => void,
): Promise<PublicKey> {
  const authority = signer.publicKey;
  const space = PROOF_DATA_OFFSET + proofSize;
  for (let attempt = 0; attempt < PROOF_BUFFER_KEY_ATTEMPTS; attempt++) {
    const kp = deriveProofBufferKeypair(authority, circuitId, attempt);
    const existing = await readProofBufferState(connection, kp.publicKey);
    if (existing) {
      const ours =
        existing.owner.equals(STARK_VERIFIER_PROGRAM_ID) && existing.authority.equals(authority);
      if (!ours) continue;
      if (existing.space >= space) {
        onProgress?.('Rearming an existing proof buffer...');
        const resetTx = new Transaction().add(
          buildResetProofBufferIx(proofSize, circuitId, kp.publicKey, authority),
        );
        await signSendConfirm(connection, resetTx, signer);
        return kp.publicKey;
      }
      onProgress?.('Closing an undersized proof buffer...');
      const closeTx = new Transaction().add(buildCloseProofBufferIx(kp.publicKey, authority));
      await signSendConfirm(connection, closeTx, signer);
    }
    onProgress?.('Allocating proof buffer...');
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    const createTx = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: authority,
          newAccountPubkey: kp.publicKey,
          lamports,
          space,
          programId: STARK_VERIFIER_PROGRAM_ID,
        }),
      )
      .add(buildInitProofBufferV3Ix(proofSize, circuitId, kp.publicKey, authority));
    try {
      await signSendConfirm(connection, createTx, signer, { extraSigners: [kp] });
    } catch (e) {
      if (!isUnknownInstruction(e)) throw e;
      console.warn('[STARK] init_proof_buffer_v3 is not deployed here, using the PDA path');
      return allocateProofBufferLegacy(connection, signer, proofSize, circuitId, onProgress);
    }
    return kp.publicKey;
  }
  throw new Error(
    `Could not allocate a proof buffer: ${PROOF_BUFFER_KEY_ATTEMPTS} derived addresses are ` +
      'occupied by accounts that are not ours.',
  );
}

/** The pre-L2 sequence (PDA, init, one resize per 10,240 bytes), kept as the fallback. */
async function allocateProofBufferLegacy(
  connection: Connection,
  signer: WalletSigner,
  proofSize: number,
  circuitId: number,
  onProgress?: (step: string) => void,
): Promise<PublicKey> {
  const authority = signer.publicKey;
  const [proofBuffer] = getProofBufferPDA(authority, circuitId);
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
    buildInitProofBufferIx(proofSize, circuitId, proofBuffer, authority),
  );
  await signSendConfirm(connection, initTx, signer);
  const resizeTarget = proofSize + PROOF_DATA_OFFSET;
  if (resizeTarget > MAX_INIT_SIZE) {
    const resizesNeeded = Math.ceil((resizeTarget - MAX_INIT_SIZE) / MAX_REALLOC_STEP);
    for (let r = 0; r < resizesNeeded; r++) {
      onProgress?.(`Resizing proof buffer (${r + 1}/${resizesNeeded})...`);
      const resizeTx = new Transaction().add(buildResizeProofBufferIx(proofBuffer, authority));
      await signSendConfirm(connection, resizeTx, signer);
    }
  }
  return proofBuffer;
}

/**
 * Circuits whose phase 1 + phase 2 fit ONE transaction, with the measured sum
 * (litesvm, 2026-09-12, `docs/UNIFORM-MASKING-2026-09-11.md` §4a): C3 1,044,961,
 * C6 1,075,102, C7 1,080,683 against the 1,400,000 cap. C1 exceeds it; C0 runs
 * both phases in `verify_stark_proof`. C2, C4 and C5 have no client prover, so
 * they have no row (same table as packages/stark-prover/src/upload-protocol.ts
 * and apps/mobile/services/stark).
 */
export const SINGLE_TX_VERIFY_CU: Readonly<Partial<Record<number, number>>> = {
  [CIRCUIT_MERKLE_PATH]: 1_044_961,
  [CIRCUIT_MERKLE_UPDATE]: 1_075_102,
  [CIRCUIT_SPEND]: 1_080_683,
};

// Chunk transactions in flight at once (independent, idempotent, skipPreflight).
const CHUNK_SEND_CONCURRENCY = 8;

/** Send every chunk, CHUNK_SEND_CONCURRENCY at a time, then confirm the batch. */
async function uploadProofChunks(
  connection: Connection,
  signer: WalletSigner,
  proofBuffer: PublicKey,
  proofBytes: Uint8Array,
  onProgress?: (step: string) => void,
): Promise<void> {
  const authority = signer.publicKey;
  // [TX-V1 2026-09-13] 3,840-byte chunks in 4,096-byte v1 transactions when the
  // cluster's gate is active and the signer can sign raw bytes (see `txv1.ts`).
  const v1 = !!signer.signBytes && (await isTransactionV1Active(connection));
  const chunkSize = v1 ? V1_CHUNK_SIZE : MAX_CHUNK_SIZE;
  const totalChunks = Math.ceil(proofBytes.length / chunkSize);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const sigs: string[] = new Array<string>(totalChunks);
  let next = 0;
  let sent = 0;
  const worker = async () => {
    for (;;) {
      const k = next++;
      if (k >= totalChunks) return;
      const offset = k * chunkSize;
      const end = Math.min(offset + chunkSize, proofBytes.length);
      if (v1) {
        const { messageBytes, payer } = compileV1ChunkMessage({
          programId: STARK_VERIFIER_PROGRAM_ID,
          proofBuffer,
          authority,
          offset,
          bytes: proofBytes.slice(offset, end),
          blockhash,
          lastValidBlockHeight,
          discriminator: DISCRIMINATORS.writeProofChunk,
        });
        const signature = await signer.signBytes!(messageBytes);
        sigs[k] = await connection.sendRawTransaction(encodeV1Wire(messageBytes, payer, signature), { skipPreflight: true });
      } else {
        const chunkTx = new Transaction().add(
          buildWriteProofChunkIx(offset, proofBytes.slice(offset, end), proofBuffer, authority),
        );
        chunkTx.recentBlockhash = blockhash;
        chunkTx.feePayer = authority;
        const signed = await signer.signTransaction(chunkTx);
        sigs[k] = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      }
      sent += 1;
      onProgress?.(`Uploading proof chunk${v1 ? ' (tx v1)' : ''} ${sent}/${totalChunks}...`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_SEND_CONCURRENCY, totalChunks) }, worker));
  onProgress?.('Confirming chunk uploads...');
  await confirmSignatures(connection, sigs);
}

/** Phase 1 and, for circuits 1..=7, phase 2 — one transaction where the measured CU fits. */
async function verifyUploadedProof(
  connection: Connection,
  signer: WalletSigner,
  proof: GenericStarkProof,
  proofBuffer: PublicKey,
  onProgress?: (step: string) => void,
): Promise<string> {
  const authority = signer.publicKey;
  const phase1 = buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority);
  const needsPhase2 = proof.circuitId >= 1 && proof.circuitId <= 7;
  const phase2 = needsPhase2
    ? buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority)
    : null;
  if (phase2 && SINGLE_TX_VERIFY_CU[proof.circuitId] !== undefined) {
    onProgress?.('Verifying STARK proof (phase 1 + DEEP-ALI, one transaction)...');
    const merged = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(phase1)
      .add(phase2);
    try {
      return await signSendConfirm(connection, merged, signer);
    } catch (e) {
      const state = await readProofBufferState(connection, proofBuffer);
      if (state?.verified && state.deepAliVerified) {
        const recent = await connection.getSignaturesForAddress(proofBuffer, { limit: 1 });
        return recent[0]?.signature ?? '';
      }
      console.warn('[STARK] merged verify did not land, falling back to two transactions:', (e as Error).message);
    }
  }
  onProgress?.('Verifying STARK proof phase 1...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(phase1);
  const txSignature = await signSendConfirm(connection, verifyTx, signer);
  if (phase2) {
    onProgress?.('Verifying STARK proof phase 2 (DEEP-ALI)...');
    const deepAliTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(phase2);
    await signSendConfirm(connection, deepAliTx, signer);
  }
  return txSignature;
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
  opts?: { skipPreflight?: boolean; extraSigners?: Keypair[] },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  const signed = await signer.signTransaction(tx);
  // A buffer keypair co-signs `createAccount`, after the wallet so its signature survives.
  if (opts?.extraSigners?.length) signed.partialSign(...opts.extraSigners);
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
  // [L2-CLIENT 2026-09-13] one transaction allocates and initialises the buffer.
  const proofBuffer = await allocateProofBuffer(
    connection,
    signer,
    proof.proofSize,
    CIRCUIT_SUBSCRIBER_OWNERSHIP,
    onProgress,
  );
  await uploadProofChunks(connection, signer, proofBuffer, proof.proofBytes, onProgress);

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
  // [L2-CLIENT 2026-09-13] allocate in one transaction, upload concurrently,
  // merge the two verify phases where the measured CU fits.
  const proofBuffer = await allocateProofBuffer(
    connection,
    signer,
    proof.proofSize,
    proof.circuitId,
    onProgress,
  );
  await uploadProofChunks(connection, signer, proofBuffer, proof.proofBytes, onProgress);
  const txSignature = await verifyUploadedProof(connection, signer, proof, proofBuffer, onProgress);
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
  buildInitProofBufferV3Ix,
  buildResetProofBufferIx,
  STARK_VERIFIER_PROGRAM_ID,
  CIRCUIT_SUBSCRIBER_OWNERSHIP,
  CIRCUIT_POOL_COMMITMENT,
  CIRCUIT_MERKLE_PATH,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_SPEND,
};
