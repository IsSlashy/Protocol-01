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
  // 🚨 `finalized`, NOT `confirmed`, AND A RETRY. Both, because they answer two
  // different failures that produce the identical message.
  //
  // A `confirmed` blockhash is known to the node that issued it and not yet to
  // its neighbours. Every request here goes through a load-balanced provider,
  // so the node asked to run PREFLIGHT is routinely not the node that gave the
  // blockhash — and it answers "Blockhash not found" for a transaction that is
  // perfectly valid. A finalized blockhash is one every node has, at the cost of
  // ~13s of its ~60s validity, which is ample for a send that happens next.
  //
  // MEASURED 2026-08-18: a subscribe reached the proof buffers, landed six
  // transactions, then died on "Transaction simulation failed: Blockhash not
  // found" with an empty log — the shape a stale-node preflight has, and one no
  // amount of reading the program can explain. The same reasoning was already
  // applied to the wallet-signed funding transaction and stopped there; this
  // helper sends every buffer init, every resize and both verify phases.
  //
  // The retry covers the other cause: under a paced/rate-limited transport the
  // gap between fetching and sending can outlive the blockhash. Refetching is
  // the only correct response and costs one round trip.
  let sig: string | undefined;
  let blockhash = '';
  let lastValidBlockHeight = 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt < BLOCKHASH_SEND_ATTEMPTS; attempt++) {
    ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized'));
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;
    // Re-signed each attempt: the signature covers the blockhash, so a retry
    // that reuses the old signature is rejected for a different reason and the
    // real one is never seen.
    const signed = await signer.signTransaction(tx);
    try {
      sig = await conn.sendRawTransaction(signed.serialize(), {
        skipPreflight: opts?.skipPreflight ?? false,
      });
      break;
    } catch (e) {
      lastErr = e;
      if (!/blockhash not found/i.test((e as Error).message ?? '')) throw e;
      // Give the provider a moment to agree with itself before asking again.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!sig) throw lastErr instanceof Error ? lastErr : new Error('Transaction could not be sent');

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
 *
 * Returns the indices (into `sigs`) still unconfirmed when the window closes,
 * instead of throwing — the caller owns the resend policy. A signature that
 * LANDED with an on-chain error still throws: a chunk write is a bounds-checked
 * constant instruction, so the program rejecting it once means it will reject
 * the identical resend, and paying the fee again buys nothing.
 */
async function confirmSignatures(
  conn: Connection,
  sigs: string[],
  timeoutMs = CHUNK_CONFIRM_WINDOW_MS,
  onProgress?: (step: string) => void,
): Promise<number[]> {
  const pending = new Map<string, number>();
  sigs.forEach((sig, i) => pending.set(sig, i));
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    const arr = [...pending.keys()];
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
    if (pending.size === 0) break;
    onProgress?.(`Confirming chunk uploads (${pending.size} pending)...`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  return [...pending.values()];
}

// ---------------------------------------------------------------------------
// Chunked upload with per-chunk resume
// ---------------------------------------------------------------------------

// A blockhash is valid for ~150 slots (60-90 s), but a ~140 KB proof takes
// minutes to upload. One blockhash fetched up front expires mid-loop and every
// remaining chunk dies with "Blockhash not found". Refresh it as we go.
const CHUNK_BLOCKHASH_MAX_AGE_MS = 30_000;

/**
 * How many times a send retries when the provider says the blockhash does not
 * exist. Three: one for a node that is merely behind, one for a blockhash that
 * aged out under a paced transport, and one to fail on rather than loop.
 */
const BLOCKHASH_SEND_ATTEMPTS = 3;

// One confirm window covers a full blockhash lifetime (90 s is the upper
// bound), so every transaction sent in a round gets the whole life of its
// blockhash to land before we judge it lost.
const CHUNK_CONFIRM_WINDOW_MS = 90_000;

// Resend budget. Round 0 sends everything; each later round re-signs ONLY the
// unconfirmed chunks with a fresh blockhash and watches for one more full
// blockhash lifetime. Initial send + 3 resends = four independent blockhash
// lifetimes per chunk, ~6 minutes of landing opportunity — measured deposits
// run 63-554 s end to end, so a chunk that misses all four windows is an RPC
// outage, not congestion, and more rounds would only spend more fees on a
// dead link.
const MAX_RESEND_ROUNDS = 3;

/** One upload unit. Chunk writes are offset-addressed on-chain
 * (`write_proof_chunk(offset, data)`), so resending a chunk is idempotent —
 * the same bytes land at the same place however many times they arrive. The
 * index ↔ offset ↔ bytes binding is what resume and readback both navigate by. */
export interface ProofChunk {
  index: number;
  offset: number;
  bytes: Uint8Array;
}

/** Split proof bytes into MAX_CHUNK_SIZE upload units. Pure, exported so the
 * torn-buffer tests can reason about the exact same chunk geometry. */
export function splitProofIntoChunks(proofBytes: Uint8Array): ProofChunk[] {
  const chunks: ProofChunk[] = [];
  for (let index = 0, offset = 0; offset < proofBytes.length; index++, offset += MAX_CHUNK_SIZE) {
    const end = Math.min(offset + MAX_CHUNK_SIZE, proofBytes.length);
    chunks.push({ index, offset, bytes: proofBytes.slice(offset, end) });
  }
  return chunks;
}

/**
 * Compare local proof bytes against the RAW proof-buffer account data (the
 * PROOF_DATA_OFFSET-byte header included, exactly as getAccountInfo returns
 * it) and return the indices of chunks whose on-chain bytes differ. Null or
 * truncated account data marks the unreadable chunks as holes. Pure, so the
 * torn-buffer detection is provable without a cluster.
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

/**
 * Upload proof bytes as offset-addressed chunk writes with per-chunk resume,
 * then prove completeness by reading the buffer back byte for byte.
 *
 * The readback is not paranoia. On-chain, `bytes_written` is a HIGH-WATER MARK
 * (`bytes_written = bytes_written.max(offset + len)`, lib.rs:89-90), not a
 * count: lose chunk 5 while chunks 6..148 land, and the program's own
 * completeness check (`bytes_written >= proof_size`, lib.rs:118) passes over a
 * hole of zeros — verification then fails much later, unreadably, after the
 * 1.4M CU budget is already spent. No on-chain state distinguishes a complete
 * buffer from a torn one, so the client is the sole source of truth on which
 * chunks arrived, and one getAccountInfo (~140 KB) gates the verify
 * transaction.
 *
 * No pacing here by design: every Connection the pool hands this code routes
 * through createPacedFetch (lib/privacy/worker/pacedFetch.ts), so throughput
 * is bounded at the transport and this loop must not stack a second queue on
 * top of it.
 */
async function uploadProofChunks(
  connection: Connection,
  signer: WalletSigner,
  proofBuffer: PublicKey,
  proofBytes: Uint8Array,
  onProgress?: (step: string) => void,
): Promise<void> {
  const chunks = splitProofIntoChunks(proofBytes);

  let chunkBlockhash = '';
  let chunkBlockhashAt = 0;
  const refreshBlockhash = async () => {
    // `finalized` for the same reason as `signSendConfirm` above: every node
    // knows it. These chunks go out with skipPreflight, so a stale blockhash
    // does not fail here — it fails LATER, as chunks that never confirm and a
    // resend round that looks like congestion. Same cause, different mask.
    chunkBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
    chunkBlockhashAt = Date.now();
  };

  const sendChunks = async (toSend: ProofChunk[], label: string): Promise<string[]> => {
    const sigs: string[] = [];
    for (let k = 0; k < toSend.length; k++) {
      const chunk = toSend[k];
      onProgress?.(`${label} ${k + 1}/${toSend.length}...`);
      if (Date.now() - chunkBlockhashAt > CHUNK_BLOCKHASH_MAX_AGE_MS) await refreshBlockhash();
      const chunkTx = new Transaction().add(
        buildWriteProofChunkIx(chunk.offset, chunk.bytes, proofBuffer, signer.publicKey),
      );
      chunkTx.recentBlockhash = chunkBlockhash;
      chunkTx.feePayer = signer.publicKey;
      const signed = await signer.signTransaction(chunkTx);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      sigs.push(sig);
    }
    return sigs;
  };

  // Round 0 sends everything; each later round resends ONLY what did not
  // confirm. See MAX_RESEND_ROUNDS for why the budget is what it is.
  let pendingChunks = chunks;
  for (let round = 0; ; round++) {
    const label =
      round === 0
        ? 'Uploading proof chunk'
        : `Resending chunk (round ${round}/${MAX_RESEND_ROUNDS})`;
    const sigs = await sendChunks(pendingChunks, label);
    onProgress?.('Confirming chunk uploads...');
    const unconfirmed = await confirmSignatures(connection, sigs, CHUNK_CONFIRM_WINDOW_MS, onProgress);
    if (unconfirmed.length === 0) break;
    if (round >= MAX_RESEND_ROUNDS) {
      throw new Error(
        `Chunk upload failed: ${unconfirmed.length} chunk(s) unconfirmed after ` +
          `${MAX_RESEND_ROUNDS} resend round(s). No verify fee was spent.`,
      );
    }
    pendingChunks = unconfirmed.map((i) => pendingChunks[i]);
    onProgress?.(`${pendingChunks.length} chunk(s) lost, resending with a fresh blockhash...`);
    await refreshBlockhash();
  }

  // Authoritative completeness gate — see the doc comment above for why
  // signature confirmations alone cannot prove the buffer is whole.
  onProgress?.('Checking uploaded proof against the local bytes...');
  for (let attempt = 0; ; attempt++) {
    const info = await connection.getAccountInfo(proofBuffer);
    const holes = findBufferHoles(proofBytes, info?.data ?? null);
    if (holes.length === 0) return;
    if (attempt >= 1) {
      throw new Error(
        `Proof buffer is torn on-chain: chunk(s) [${holes.join(', ')}] still differ ` +
          'from the local proof after a repair pass. Aborting before spending verify CU.',
      );
    }
    // Statuses can confirm a transaction whose write we never saw land
    // (status races on congested devnet). Writes are idempotent, so patch
    // exactly the torn chunks and read back once more.
    onProgress?.(`Readback found ${holes.length} torn chunk(s), repairing...`);
    await refreshBlockhash();
    const repairSigs = await sendChunks(
      holes.map((i) => chunks[i]),
      'Re-uploading torn chunk',
    );
    await confirmSignatures(connection, repairSigs, CHUNK_CONFIRM_WINDOW_MS, onProgress);
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
      const resizeTx = new Transaction().add(buildResizeProofBufferIx(proofBuffer, authority));
      await audible(
        `Resizing proof buffer (${r + 1}/${resizesNeeded})...`,
        onProgress,
        () => signSendConfirm(connection, resizeTx, signer),
      );
    }
  }

  // Chunked upload with per-chunk resume and a byte-for-byte readback gate —
  // see uploadProofChunks for why confirmations alone cannot prove completeness.
  await uploadProofChunks(connection, signer, proofBuffer, proof.proofBytes, onProgress);

  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofIx(proof.commitment, proofBuffer, authority));
  const txSig = await audible('Verifying STARK proof on-chain...', onProgress, () =>
    signSendConfirm(connection, verifyTx, signer),
  );

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
/**
 * Keep a long `await` AUDIBLE.
 *
 * 🚨 MEASURED 2026-08-31, ON REAL MONEY. The main thread's watchdog fires
 * after 180 s of SILENCE and re-arms on every progress message. The resize loop
 * emitted one message per step and then blocked on `signSendConfirm`, so a
 * single slow confirmation went quiet for longer than that and the page gave up
 * on a job that was working fine. The buyer had already paid the till; the
 * ephemeral finished its ten transactions and was swept; nothing landed.
 *
 * The proof step has had a heartbeat since 2026-08-05 for exactly this reason.
 * Every other step that can block for minutes needs one too, and "it usually
 * takes two seconds" is not a bound.
 */
async function audible<T>(
  label: string,
  onProgress: ((step: string) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!onProgress) return run();
  const startedAt = Date.now();
  onProgress(label);
  const beat = setInterval(() => {
    onProgress(`${label} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }, 10_000);
  try {
    return await run();
  } finally {
    clearInterval(beat);
  }
}

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
      const resizeTx = new Transaction().add(buildResizeProofBufferIx(proofBuffer, authority));
      await audible(
        `Resizing proof buffer (${r + 1}/${resizesNeeded})...`,
        onProgress,
        () => signSendConfirm(connection, resizeTx, signer),
      );
    }
  }

  // Chunked upload with per-chunk resume and a byte-for-byte readback gate —
  // see uploadProofChunks for why confirmations alone cannot prove completeness.
  await uploadProofChunks(connection, signer, proofBuffer, proof.proofBytes, onProgress);

  onProgress?.('Verifying STARK proof phase 1...');
  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  const txSignature = await signSendConfirm(connection, verifyTx, signer);

  // Phase 2 (DEEP-ALI at OOD) — mandatory for circuits 1–6. Circuit 0 runs
  // DEEP-ALI inline in phase 1. Combined phase 1+2 exceeds the 1.4M CU per-ix
  // budget, so we split across two transactions.
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
// Build-only assembly, for the relayed path
// ---------------------------------------------------------------------------

/**
 * A blockhash is required to serialise a transaction, and the relayer replaces
 * it before signing — it is the sole signer, so it may, and it must, because
 * ~79 sequential transactions outlive the ~60 s any blockhash chosen here would
 * have. This placeholder exists so `serialize()` does not throw.
 */
export const RELAY_PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';

/**
 * The same sequence `submitAndVerifyStarkProof` sends, built and NOT sent, with
 * somebody else as `authority` and fee payer.
 *
 * 🚨 `authority` is the relayer, not the buyer. The proof buffer is a PDA seeded
 * on `[b"stark_proof", authority, circuit_id]`, and `unshield_denominated_stark_v4`
 * requires `c7_authority == payer`, so the whole upload has to be in the
 * relayer's name for the spend to be relayable at all.
 *
 * ⚠️ Kept next to `submitAndVerifyStarkProof` on purpose: these two are the same
 * sequence and they must stay the same sequence. A resize count computed
 * differently in the two places is a buffer too small and a chunk write that
 * aborts with ProgramFailedToComplete at the end of the upload.
 */
export function buildStarkProofUploadBatch(
  proof: GenericStarkProof,
  authority: PublicKey,
  opts: { closeStaleBufferFirst?: boolean } = {},
): { transactions: Transaction[]; proofBuffer: PublicKey } {
  const [proofBuffer] = getProofBufferPDA(authority, proof.circuitId);
  const transactions: Transaction[] = [];

  const push = (...ixs: TransactionInstruction[]) => {
    const tx = new Transaction();
    tx.feePayer = authority;
    tx.recentBlockhash = RELAY_PLACEHOLDER_BLOCKHASH;
    tx.add(...ixs);
    transactions.push(tx);
  };

  // The buffer PDA is derived from the RELAYER's key, so a stale one is the
  // relayer's own leftover — from a batch that died between upload and close.
  // The caller checks `getAccountInfo(proofBuffer)` and asks for this.
  if (opts.closeStaleBufferFirst) {
    push(buildCloseProofBufferIx(proofBuffer, authority));
  }

  push(buildInitProofBufferIx(proof.proofSize, proof.circuitId, proofBuffer, authority));

  const resizeTarget = proof.proofSize + PROOF_DATA_OFFSET;
  if (resizeTarget > MAX_INIT_SIZE) {
    const resizesNeeded = Math.ceil((resizeTarget - MAX_INIT_SIZE) / MAX_REALLOC_STEP);
    for (let r = 0; r < resizesNeeded; r++) {
      push(buildResizeProofBufferIx(proofBuffer, authority));
    }
  }

  for (const chunk of splitProofIntoChunks(proof.proofBytes)) {
    push(buildWriteProofChunkIx(chunk.offset, chunk.bytes, proofBuffer, authority));
  }

  push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority),
  );

  // Same range as submitAndVerifyStarkProof: circuit 7 splits phase 1 / phase 2
  // like 1..6, and phase 2 is where ALL of its binding lives. Skipping it
  // reports success on a proof whose boundary assertions were never checked.
  if (proof.circuitId >= 1 && proof.circuitId <= 7) {
    push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority),
    );
  }

  return { transactions, proofBuffer };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  getProofBufferPDA,
  buildCloseProofBufferIx,
  STARK_VERIFIER_PROGRAM_ID,
  PROOF_DATA_OFFSET,
  MAX_CHUNK_SIZE,
  CIRCUIT_SUBSCRIBER_OWNERSHIP,
  CIRCUIT_POOL_COMMITMENT,
  CIRCUIT_BALANCE_PROOF,
  CIRCUIT_MERKLE_PATH,
  CIRCUIT_CONFIDENTIAL_BALANCE,
  CIRCUIT_TRANSFER,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_SPEND,
};
