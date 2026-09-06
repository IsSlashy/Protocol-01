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
import {
  buildCreateAndInitProofBufferV3Ixs,
  buildResetProofBufferIx,
  bufferCanBeReset,
  proofBufferSpace,
} from './proofBufferV3';

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

/**
 * How often a confirmation is polled. 400 ms, one slot. The previous 2,500 ms
 * turned every one of the ~15 sequential confirmations a flow makes into a
 * 2.5 s floor regardless of how fast the chain answered — measured 2026-09-06
 * (docs/PERF-AND-CAPACITY-PLAN-2026-09-06.md §1): the wall clock was
 * transactions and timers, never the proof.
 */
const STATUS_POLL_MS = 400;

/**
 * Past this age a signature may have fallen out of the status cache, so the
 * poll pays for the history search. Same rule as worker/pollingConfirm.ts.
 */
const STATUS_HISTORY_AFTER_MS = 20_000;

/** Ceiling per single-transaction confirmation, one blockhash lifetime. */
const CONFIRM_TIMEOUT_MS = 90_000;

/** Solana's per-transaction compute cap. Everything composed here fits under it. */
const TX_CU_CAP = 1_400_000;

/** Solana's transaction packet cap; a composed transaction must serialise under it. */
const PACKET_DATA_SIZE = 1232;

/** Mirrors `buildComputeBudgetIxs` in denominatedPool.ts. */
const DEFAULT_CU_PRICE_MICROLAMPORTS = 1000;

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
  opts?: { skipPreflight?: boolean; extraSigners?: Keypair[] },
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
    // The buffer keypair of a fresh v3 allocation co-signs `createAccount`;
    // it signs AFTER the authority so a wallet that rebuilds the transaction
    // on signing cannot drop it.
    if (opts?.extraSigners?.length) signed.partialSign(...opts.extraSigners);
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
  void lastValidBlockHeight;

  await pollSignature(conn, sig);
  return sig;
}

/**
 * Wait for ONE signature by polling `getSignatureStatuses` every slot.
 *
 * Not `confirmTransaction`: inside a Web Worker its WebSocket subscription
 * throws and it silently falls back to "wait until the blockhash expires" —
 * measured 2026-07-24 at ~58 s per resize (worker/pollingConfirm.ts). And the
 * patched polling it was replaced with still slept 1.5 s between looks. A
 * confirmation is a 400 ms event on a healthy cluster; the poll now runs at
 * that granularity, and pays for the history search only once the signature is
 * old enough to have left the status cache.
 *
 * An on-chain error THROWS. The status is the only place a failed instruction
 * is visible after `skipPreflight`, and a caller that reads the signature as
 * success would report a landed withdrawal that never moved a lamport.
 */
async function pollSignature(
  conn: Connection,
  sig: string,
  timeoutMs = CONFIRM_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([sig], {
      searchTransactionHistory: Date.now() - start > STATUS_HISTORY_AFTER_MS,
    });
    const st = value[0];
    if (st) {
      if (st.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
    }
    await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
  }
  throw new Error(`Transaction ${sig} was not confirmed within ${timeoutMs / 1000}s`);
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
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastSaid = 0;
  while (pending.size > 0 && Date.now() < deadline) {
    const arr = [...pending.keys()];
    for (let i = 0; i < arr.length; i += 256) {
      const slice = arr.slice(i, i + 256);
      const { value } = await conn.getSignatureStatuses(slice, {
        searchTransactionHistory: Date.now() - start > STATUS_HISTORY_AFTER_MS,
      });
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
    // One sentence a second, not one per poll: the bar reads the words, and a
    // message every 400 ms is noise to a human.
    if (Date.now() - lastSaid >= 1_000) {
      lastSaid = Date.now();
      onProgress?.(
        `Confirming chunk uploads (${pending.size} pending, ${Math.round((Date.now() - start) / 1000)}s)...`,
      );
    }
    await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
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
    // `confirmed`, not `finalized`, for the chunks. They go out with
    // skipPreflight, so no RPC node ever checks this blockhash — only the
    // leader does, and a confirmed blockhash is in every leader's recent set.
    // What `confirmed` buys is ~13 s more validity, which matters now that a
    // whole round is signed and fired within one second and the only thing
    // left to wait for is the confirmation window.
    chunkBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    chunkBlockhashAt = Date.now();
  };

  /**
   * Sign every chunk, then fire ALL of them at once and let the transport pace
   * them. Returns one entry per input chunk: the signature, or null when the
   * send itself failed (a network error is a lost chunk, not a dead upload —
   * the resend round picks it up).
   *
   * Sequential sends were the single largest timer in the flow: ~80 chunks
   * each awaiting its own round trip behind a 120 ms pace = ~10 s of pure
   * waiting per proof, plus a progress message per chunk. The chain accepts
   * 80 independent transactions in one or two slots.
   */
  const sendChunks = async (toSend: ProofChunk[], label: string): Promise<(string | null)[]> => {
    if (Date.now() - chunkBlockhashAt > CHUNK_BLOCKHASH_MAX_AGE_MS) await refreshBlockhash();
    onProgress?.(`${label}: signing ${toSend.length} chunk(s) before uploading...`);
    const signed: Uint8Array[] = [];
    for (const chunk of toSend) {
      const chunkTx = new Transaction().add(
        buildWriteProofChunkIx(chunk.offset, chunk.bytes, proofBuffer, signer.publicKey),
      );
      chunkTx.recentBlockhash = chunkBlockhash;
      chunkTx.feePayer = signer.publicKey;
      signed.push((await signer.signTransaction(chunkTx)).serialize());
    }
    onProgress?.(`Uploading ${toSend.length} proof chunks at once...`);
    let landed = 0;
    const results = await Promise.allSettled(
      signed.map(async (raw) => {
        const sig = await connection.sendRawTransaction(raw, { skipPreflight: true });
        landed++;
        // `chunk k/N` is the shape the progress bar reads its fraction from.
        onProgress?.(`Uploading proof chunk ${landed}/${toSend.length}...`);
        return sig;
      }),
    );
    return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
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
    // Chunks whose send never produced a signature are unconfirmed by
    // definition; the rest get the barrier.
    const sentIdx = sigs.map((s, i) => (s === null ? -1 : i)).filter((i) => i >= 0);
    const unconfirmedSent = await confirmSignatures(
      connection,
      sentIdx.map((i) => sigs[i] as string),
      CHUNK_CONFIRM_WINDOW_MS,
      onProgress,
    );
    const unconfirmed = [
      ...sigs.map((s, i) => (s === null ? i : -1)).filter((i) => i >= 0),
      ...unconfirmedSent.map((k) => sentIdx[k]),
    ].sort((a, b) => a - b);
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
    await confirmSignatures(
      connection,
      repairSigs.filter((s): s is string => s !== null),
      CHUNK_CONFIRM_WINDOW_MS,
      onProgress,
    );
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

// ---------------------------------------------------------------------------
// Proof buffer allocation: three strategies
// ---------------------------------------------------------------------------

/** How the buffer a proof is uploaded into came to exist. */
export type ProofBufferStrategy = 'v3-fresh' | 'reset' | 'legacy-pda';

/**
 * Where the proof buffer comes from. All optional; the default is `v3-fresh`.
 *
 *   v3-fresh    ONE transaction: `SystemProgram.createAccount` at the FULL size
 *               (the 10,240-byte cap is a CPI/PDA limit; a keypair account the
 *               client creates directly has none) + `init_proof_buffer_v3`.
 *               Replaces init + 7 or 8 resizes. Signed by the authority and the
 *               buffer keypair.
 *   reset       `reusable` names a buffer this authority already owns with
 *               enough capacity: one `reset_proof_buffer`, no allocation, no
 *               rent. Falls back to v3-fresh when the account is missing,
 *               foreign, or too small.
 *   legacy-pda  the pre-2026-09-06 path (`init_proof_buffer` on the
 *               `stark_proof` PDA, then resizes). Kept for rollback ONLY; off
 *               unless `legacyPda` is passed.
 */
export interface ProofBufferOptions {
  /**
   * The keypair of the fresh buffer. Generated when absent. Pass a
   * DETERMINISTIC derivation for an ephemeral signer (`deriveProofBufferKeypair`
   * in proofBufferV3.ts) so a job that dies between the upload and the close
   * leaves a buffer `recoverFloat` can find and close.
   */
  bufferKeypair?: Keypair;
  /** A buffer the authority already holds open, to be reset in place. */
  reusable?: PublicKey;
  /**
   * Leave the buffer open after the consuming transaction (no close), so the
   * NEXT proof of this authority can `reset` it. The rent stays parked.
   */
  keepOpen?: boolean;
  /** Rollback switch: the PDA init + resize path. */
  legacyPda?: boolean;
}

/** Authority field of a `ProofBuffer` account: bytes 8..40 of the data. */
function proofBufferAuthority(data: Uint8Array): PublicKey | null {
  if (data.length < 40) return null;
  return new PublicKey(data.subarray(8, 40));
}

/**
 * Allocate (or rearm) the buffer, then upload the bytes. Everything up to and
 * excluding verification, shared by the two-phase submit and the
 * single-transaction consume below so the two can never disagree on it.
 *
 * Returns the buffer address: with `v3-fresh` it is a keypair, NOT the PDA, so
 * every consumer must take the address from here rather than derive it.
 */
async function prepareProofBuffer(
  proof: GenericStarkProof,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
  opts: ProofBufferOptions = {},
): Promise<{ proofBuffer: PublicKey; strategy: ProofBufferStrategy }> {
  const authority = signer.publicKey;

  if (opts.legacyPda) {
    const proofBuffer = await prepareLegacyPdaBuffer(proof, signer, connection, onProgress);
    return { proofBuffer, strategy: 'legacy-pda' };
  }

  const fits = (data: Uint8Array | null, owner: PublicKey | null): boolean =>
    !!data &&
    !!owner &&
    owner.equals(STARK_VERIFIER_PROGRAM_ID) &&
    proofBufferAuthority(data)?.equals(authority) === true &&
    bufferCanBeReset(data, proof.proofSize);

  // `reset`: a buffer this authority already holds, big enough for this proof.
  // The three checks mirror the program's own (`has_one = authority`, owner,
  // `BufferTooSmall`), so a refusal here costs no transaction.
  const candidates: PublicKey[] = [];
  if (opts.reusable) candidates.push(opts.reusable);
  // A deterministic keypair may already exist on chain: a previous run of this
  // same job died between the upload and the close. Resetting it IS the
  // recovery, and `createAccount` on it would fail anyway.
  if (opts.bufferKeypair) candidates.push(opts.bufferKeypair.publicKey);
  for (const candidate of candidates) {
    const info = await connection.getAccountInfo(candidate);
    if (info && fits(info.data, info.owner)) {
      const resetTx = new Transaction().add(
        buildResetProofBufferIx(proof.proofSize, proof.circuitId, candidate, authority),
      );
      await audible('Reusing your proof buffer...', onProgress, () =>
        signSendConfirm(connection, resetTx, signer),
      );
      await uploadProofChunks(connection, signer, candidate, proof.proofBytes, onProgress);
      return { proofBuffer: candidate, strategy: 'reset' };
    }
    if (info && opts.bufferKeypair && candidate.equals(opts.bufferKeypair.publicKey)) {
      throw new Error(
        `The proof buffer keypair ${candidate.toBase58()} already exists on chain and is not ` +
          'a buffer this signer can reuse (foreign owner, other authority, or too small). ' +
          'Close or drain it before retrying.',
      );
    }
  }

  // `v3-fresh`: create at full size and initialise, in ONE transaction.
  const bufferKeypair = opts.bufferKeypair ?? Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(
    proofBufferSpace(proof.proofSize),
  );
  const allocTx = new Transaction().add(
    ...buildCreateAndInitProofBufferV3Ixs(
      proof.proofSize,
      proof.circuitId,
      bufferKeypair,
      authority,
      lamports,
    ),
  );
  await audible('Opening the proof buffer (one transaction)...', onProgress, () =>
    signSendConfirm(connection, allocTx, signer, { extraSigners: [bufferKeypair] }),
  );
  await uploadProofChunks(connection, signer, bufferKeypair.publicKey, proof.proofBytes, onProgress);
  return { proofBuffer: bufferKeypair.publicKey, strategy: 'v3-fresh' };
}

/**
 * The pre-2026-09-06 allocation: close a stale PDA buffer, `init_proof_buffer`
 * (capped at 10,240 bytes), then one `resize_proof_buffer` per further 10,240
 * bytes, sequentially. Eight transactions for a circuit-7 proof. Reachable
 * only through `ProofBufferOptions.legacyPda`.
 */
async function prepareLegacyPdaBuffer(
  proof: GenericStarkProof,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<PublicKey> {
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

  const initTx = new Transaction().add(
    buildInitProofBufferIx(proof.proofSize, proof.circuitId, proofBuffer, authority),
  );
  await audible('Initializing proof buffer...', onProgress, () =>
    signSendConfirm(connection, initTx, signer),
  );

  // Grow the buffer to the FULL proof size. Anchor realloc grows by at most
  // MAX_REALLOC_STEP (10KB) per call, so large proofs (e.g. circuit 6) need
  // several resize txs — a single resize leaves the buffer too small and a
  // later chunk write aborts with ProgramFailedToComplete.
  //
  // Sequential ON PURPOSE. Each realloc is +10,240 over the previous data
  // length, so two resizes landing in the same slot are not two steps, they
  // are one step and one refusal; ordering them by waiting for each is the
  // only way to be sure of the count. The wait is now one slot per resize
  // (STATUS_POLL_MS), so the chain is at most ~8 slots, not ~8 × 2.5 s.
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
  return proofBuffer;
}

/** Circuits whose proof needs the DEEP-ALI phase 2 after phase 1. */
function needsPhase2(circuitId: number): boolean {
  // Phase 2 (DEEP-ALI at OOD) — mandatory for circuits 1–6. Circuit 0 runs
  // DEEP-ALI inline in phase 1.
  // [C7 2026-08-24] <= 7. Circuit 7 (spend) splits phase 1 / phase 2 like
  // 1..6, and phase 2 is where ALL of its binding lives -- its per-query
  // arm is vacuous and step 5 is gone. Left at <= 6 this branch skips
  // phase 2 silently and the client reports SUCCESS on a proof whose six
  // boundary assertions were never checked against the trace.
  return circuitId >= 1 && circuitId <= 7;
}

export async function submitAndVerifyStarkProof(
  proof: GenericStarkProof,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
  bufferOpts?: ProofBufferOptions,
): Promise<{ proofBuffer: PublicKey; authority: PublicKey; txSignature: string; strategy: ProofBufferStrategy }> {
  const authority = signer.publicKey;
  const { proofBuffer, strategy } = await prepareProofBuffer(
    proof, signer, connection, onProgress, bufferOpts,
  );

  const verifyTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: TX_CU_CAP }))
    .add(buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority));
  const txSignature = await audible('Verifying STARK proof phase 1...', onProgress, () =>
    signSendConfirm(connection, verifyTx, signer),
  );

  // Combined phase 1+2 exceeds the 1.4M CU per-ix budget for C6, so this
  // two-phase submit keeps them in two transactions. See needsPhase2.
  if (needsPhase2(proof.circuitId)) {
    const deepAliTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: TX_CU_CAP }))
      .add(buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority));
    await audible('Verifying STARK proof phase 2 (DEEP-ALI)...', onProgress, () =>
      signSendConfirm(connection, deepAliTx, signer),
    );
  }

  onProgress?.('STARK proof verified (buffer retained for cross-program read)');
  return { proofBuffer, authority, txSignature, strategy };
}

// ---------------------------------------------------------------------------
// Verify AND consume in one transaction
// ---------------------------------------------------------------------------

/**
 * What the caller wants done with the verified buffer, in the same transaction
 * as the verification.
 */
export interface ProofConsumer {
  /**
   * The instructions that read the buffer: an optional ATA create, then the
   * pool instruction. Appended after the verify phases, before the close.
   *
   * A FUNCTION of the buffer address, because with `v3-fresh` the buffer is a
   * keypair chosen at allocation time, not a PDA the caller can derive up
   * front. An array is still accepted for a caller that already knows the
   * address (the `reset` and `legacy-pda` strategies).
   */
  instructions: TransactionInstruction[] | ((proofBuffer: PublicKey) => TransactionInstruction[]);
  /**
   * Compute budget for the SPLIT shape's consume transaction (phase 2 +
   * consume + close, or consume + close). The combined shape always asks the
   * full TX_CU_CAP. Measured figures per circuit live at the call sites.
   */
  computeUnits: number;
  /** Plain words for the progress line: "withdrawing", "opening the subscription". */
  label: string;
  /**
   * How to send the consuming transaction. Default: sign with `signer`, send
   * with preflight, poll for confirmation. The extension passes its relayer
   * route here; the transaction is complete and user-signed either way.
   */
  send?: (tx: Transaction) => Promise<string>;
  /** Fires immediately before the consuming transaction is sent. */
  beforeSend?: () => void;
}

/** The compute-budget error the runtime reports when a transaction overruns its limit. */
function isComputeBudgetError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /exceeded CUs|exceeded maximum number of instructions|computational budget|ComputeBudget/i.test(
    msg,
  );
}

/**
 * Would this transaction serialise under the packet cap once signed? The
 * signature bytes are not there before signing, so they are added by hand.
 */
function fitsInPacket(tx: Transaction, feePayer: PublicKey, signers = 1): boolean {
  const probe = new Transaction();
  probe.feePayer = feePayer;
  probe.recentBlockhash = RELAY_PLACEHOLDER_BLOCKHASH;
  probe.add(...tx.instructions);
  try {
    const messageLen = probe.compileMessage().serialize().length;
    return 1 + 64 * signers + messageLen <= PACKET_DATA_SIZE;
  } catch {
    return false;
  }
}

/**
 * Upload the proof, then verify it AND consume it in ONE transaction:
 *
 *   [ compute limit, compute price, verify_stark_proof_v2,
 *     verify_deep_ali_phase2, ...consumer.instructions, close_proof_buffer ]
 *
 * Instructions in one transaction see the writes of the ones before them, and
 * nothing in the verifier requires a slot between phase 1, phase 2 and the
 * cross-program read (no Clock use anywhere in `p01_stark_verifier`). What
 * kept them apart was the per-transaction compute cap, and for circuit 7 the
 * three fit under it: MEASURED 2026-09-02, phase 1 878,756 + phase 2 192,715 +
 * `unshield_denominated_stark_v4` 176,404 = 1,247,875 CU, 11% under 1,400,000.
 * That removes three sequential confirmations from every withdrawal and
 * subscription, and the buffer's rent comes back in the same transaction, so
 * a "closing proof buffer" step no longer exists on the success path.
 *
 * Circuit 6 (the deposit) is the exception: its phase 1 alone is 1,316,491 CU,
 * so it stays in its own transaction and the second one is
 * [phase 2 + shield + close]. Two transactions instead of four.
 *
 * Two automatic fallbacks, both to the SPLIT shape (phase 1, phase 2, then
 * consume + close), because both are things a measured CU figure cannot
 * promise forever:
 *   - the composed transaction does not fit the 1,232-byte packet (deep pools
 *     carry more sibling bytes);
 *   - the runtime refuses it for compute. Atomicity makes this safe: a refused
 *     transaction changed nothing, so re-running verification is not a replay.
 *
 * If the consuming transaction fails for any other reason, the buffer is
 * closed here — the rent is the caller's and the failure is not made worse —
 * and the error is rethrown as is.
 */
export async function submitAndConsumeStarkProof(
  proof: GenericStarkProof,
  signer: WalletSigner,
  connection: Connection,
  consumer: ProofConsumer,
  onProgress?: (step: string) => void,
  bufferOpts?: ProofBufferOptions,
): Promise<{
  proofBuffer: PublicKey;
  authority: PublicKey;
  txSignature: string;
  transactions: number;
  strategy: ProofBufferStrategy;
  /** False when `keepOpen` left the buffer alive for the next proof. */
  closed: boolean;
}> {
  const authority = signer.publicKey;
  const { proofBuffer, strategy } = await prepareProofBuffer(
    proof, signer, connection, onProgress, bufferOpts,
  );
  const send = consumer.send ?? ((tx: Transaction) => signSendConfirm(connection, tx, signer));
  const consumeIxs =
    typeof consumer.instructions === 'function'
      ? consumer.instructions(proofBuffer)
      : consumer.instructions;
  // `keepOpen` parks the rent so the next proof can `reset` this buffer: no
  // close in the transaction, and none on failure either.
  const keepOpen = bufferOpts?.keepOpen === true;
  const closeIxs = keepOpen ? [] : [buildCloseProofBufferIx(proofBuffer, authority)];

  const verify1 = buildVerifyStarkProofV2Ix(proof.publicInputs, proofBuffer, authority);
  const verify2 = needsPhase2(proof.circuitId)
    ? buildVerifyDeepAliPhase2Ix(proof.publicInputs, proofBuffer, authority)
    : null;
  const budget = (units: number) => [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_CU_PRICE_MICROLAMPORTS }),
  ];

  // Phase 1 alone when it cannot share a transaction with anything: C6's is
  // 1,316,491 CU measured, and the cap is 1,400,000.
  const phase1Alone = proof.circuitId === CIRCUIT_MERKLE_UPDATE;

  // Once, even when the combined shape is refused and the split shape follows:
  // the hook records state the caller wants written exactly one time.
  let beforeSendFired = false;
  const fireBeforeSend = () => {
    if (beforeSendFired) return;
    beforeSendFired = true;
    consumer.beforeSend?.();
  };

  const consumeAlone = async (): Promise<string> => {
    const tx = new Transaction().add(...budget(consumer.computeUnits), ...consumeIxs, ...closeIxs);
    fireBeforeSend();
    return audible(
      keepOpen
        ? `Verified; now ${consumer.label}...`
        : `Verified; now ${consumer.label} and closing the buffer...`,
      onProgress,
      () => send(tx),
    );
  };

  const splitShape = async (skipPhase1: boolean): Promise<{ txSignature: string; transactions: number }> => {
    let n = 0;
    if (!skipPhase1) {
      const tx1 = new Transaction().add(...budget(TX_CU_CAP), verify1);
      await audible('Verifying STARK proof phase 1...', onProgress, () =>
        signSendConfirm(connection, tx1, signer),
      );
      n++;
    }
    if (verify2) {
      const tx2 = new Transaction().add(...budget(TX_CU_CAP), verify2);
      await audible('Verifying STARK proof phase 2 (DEEP-ALI)...', onProgress, () =>
        signSendConfirm(connection, tx2, signer),
      );
      n++;
    }
    const txSignature = await consumeAlone();
    return { txSignature, transactions: n + 1 };
  };

  let closeOnFailure = true;
  try {
    let n = 0;
    if (phase1Alone) {
      const tx1 = new Transaction().add(...budget(TX_CU_CAP), verify1);
      await audible('Verifying STARK proof phase 1...', onProgress, () =>
        signSendConfirm(connection, tx1, signer),
      );
      n++;
    }

    const combined = new Transaction().add(
      ...budget(phase1Alone ? consumer.computeUnits : TX_CU_CAP),
      ...(phase1Alone ? [] : [verify1]),
      ...(verify2 ? [verify2] : []),
      ...consumeIxs,
      ...closeIxs,
    );

    if (!fitsInPacket(combined, authority)) {
      onProgress?.('Verifying in separate transactions (the combined one does not fit a packet)...');
      const r = await splitShape(phase1Alone);
      closeOnFailure = false;
      return { proofBuffer, authority, txSignature: r.txSignature, transactions: n + r.transactions, strategy, closed: !keepOpen };
    }

    fireBeforeSend();
    try {
      const txSignature = await audible(
        `Verifying the proof and ${consumer.label} in one transaction...`,
        onProgress,
        () => send(combined),
      );
      closeOnFailure = false;
      return { proofBuffer, authority, txSignature, transactions: n + 1, strategy, closed: !keepOpen };
    } catch (e) {
      if (!isComputeBudgetError(e)) throw e;
      // Refused for compute, so nothing landed: the same statement, in parts.
      onProgress?.('Verifying in separate transactions (the combined one was over the compute cap)...');
      const r = await splitShape(phase1Alone);
      closeOnFailure = false;
      return { proofBuffer, authority, txSignature: r.txSignature, transactions: n + r.transactions, strategy, closed: !keepOpen };
    }
  } finally {
    if (closeOnFailure && !keepOpen) {
      // The rent is the signer's. Reclaim it before surfacing the failure; a
      // failure here must not hide the original error.
      try {
        onProgress?.('Closing proof buffer (rent recovery)...');
        const closeTx = new Transaction().add(buildCloseProofBufferIx(proofBuffer, authority));
        await signSendConfirm(connection, closeTx, signer);
      } catch (closeErr: unknown) {
        console.warn(
          '[STARK] closing the proof buffer after a failed consume did not land; rent recoverable later:',
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
    }
  }
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
  // STILL THE PDA PATH (init + resizes), on purpose. The relayer node that
  // signs this batch is outside this repository and its protocol names the
  // `stark_proof` PDA; a keypair buffer would need the node to hold the
  // keypair. Moving the relayed path to `init_proof_buffer_v3` is the node's
  // change, not this builder's. (2026-09-06)
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
