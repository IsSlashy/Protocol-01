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

import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import {
  DEFAULT_STARK_VERIFIER_PROGRAM_ID,
  type WalletSigner,
} from './types';

// ---------------------------------------------------------------------------
// Constants — DO NOT CHANGE without rebuilding p01_stark_verifier
// ---------------------------------------------------------------------------

/** Max bytes per chunk — fits comfortably under Solana's 1232-byte tx limit. */
export const MAX_CHUNK_SIZE = 1000;

// ---------------------------------------------------------------------------
// [TX-V1 2026-09-13] Transaction v1 (SIMD-0385): 4,096-byte transactions
// ---------------------------------------------------------------------------
//
// MEASURED 2026-09-13 (`docs/BENCHMARK-2026-09-13.md` §2b): 3,840-byte chunks in
// v1 envelopes turn an 80-transaction upload into 21 and the STARK half of a
// flow from 14-16 s to 7-8 s on the app's RPC. The feature gate below is active
// on devnet since slot 492,480,000 and announced for mainnet at epoch 1035; the
// uploader reads it and falls back to 1,000-byte legacy chunks when it is off.
// A v1 message must declare its resources or it runs with none: the chunk
// write loads the ~83 KB buffer AND the verifier's ~780 KB of bytecode (128 KiB
// landed and failed with `MaxLoadedAccountsDataSizeExceeded`; 4 MiB passes).
export const TX_V1_FEATURE_GATE = new PublicKey('txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL');
export const V1_CHUNK_SIZE = 3_840;
export const V1_MAX_WIRE_BYTES = 4_096;
const V1_CHUNK_CONFIG = {
  computeUnitLimit: 50_000,
  loadedAccountsDataSizeLimit: 4 * 1024 * 1024,
  priorityFeeLamports: 1_000n,
} as const;

const v1GateCache = new WeakMap<Connection, Promise<boolean>>();

/** Is the transaction-v1 gate activated on this connection's cluster? Read once per connection; any failure is "no". */
export function isTransactionV1Active(connection: Connection): Promise<boolean> {
  let p = v1GateCache.get(connection);
  if (!p) {
    p = connection
      .getAccountInfo(TX_V1_FEATURE_GATE)
      .then((info) => !!info && info.data.length >= 9 && info.data[0] === 1)
      .catch(() => false);
    v1GateCache.set(connection, p);
  }
  return p;
}

/** The wire bytes of one v1 `write_proof_chunk`, signed by the keypair authority. */
function buildV1ChunkWire(
  offset: number,
  data: Uint8Array,
  proofBuffer: PublicKey,
  payer: Keypair,
  programId: PublicKey,
  blockhash: string,
  lastValidBlockHeight: number,
): Uint8Array {
  const payerAddress = address(payer.publicKey.toBase58());
  const ix: Instruction = {
    programAddress: address(programId.toBase58()),
    accounts: [
      { address: address(proofBuffer.toBase58()), role: AccountRole.WRITABLE },
      { address: payerAddress, role: AccountRole.READONLY_SIGNER },
    ],
    data: concat(DISCRIMINATORS.writeProofChunk, u32LE(offset), u32LE(data.length), data),
  };
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(payerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstruction(ix, m),
    (m) => setTransactionMessageConfig(V1_CHUNK_CONFIG, m),
  );
  const compiled = compileTransaction(message);
  const signature = nacl.sign.detached(new Uint8Array(compiled.messageBytes), payer.secretKey);
  const wire = getTransactionEncoder().encode({
    messageBytes: compiled.messageBytes,
    signatures: { [payerAddress]: signature as SignatureBytes },
  });
  if (wire.length > V1_MAX_WIRE_BYTES) {
    throw new Error(`v1 chunk at offset ${offset} serialises to ${wire.length} bytes > ${V1_MAX_WIRE_BYTES}`);
  }
  return new Uint8Array(wire);
}

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
  // sha256("global:init_proof_buffer_v3")[..8] / sha256("global:reset_proof_buffer")[..8]:
  // the L2 pre-sized-buffer instructions, deployed 2026-09-06 (slot 494130741).
  initProofBufferV3:    new Uint8Array([239, 25, 230, 31, 173, 116, 84, 51]),
  resetProofBuffer:     new Uint8Array([54, 87, 185, 180, 122, 35, 136, 127]),
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
  opts?: { skipPreflight?: boolean; extraSigners?: Keypair[] },
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
  // [L2-CLIENT] a buffer keypair co-signs `createAccount`, after the payer so a
  // wallet that rebuilds the transaction cannot drop its signature.
  if (opts?.extraSigners?.length) signed.partialSign(...opts.extraSigners);

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
  signedTxs: Uint8Array[],
  waveSize = 3,
  waveDelayMs = 700,
): Promise<string[]> {
  const sigs: string[] = new Array(signedTxs.length);
  // [L2-CLIENT 2026-09-13] A send the RPC refuses with 429 after web3.js's own
  // five retries is re-sent after a pause instead of aborting the upload:
  // MEASURED on the public devnet endpoint, `waveSize 8 / 150 ms` died on
  // tx[19] with "Too many requests for a specific RPC call" (40 sends per 10 s
  // per method), and a buffer that was already allocated stayed behind.
  const sendWithRetry = async (wire: Uint8Array, idx: number): Promise<string> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await conn.sendRawTransaction(wire, { skipPreflight: true });
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/429|Too many requests/i.test(msg)) break;
        await new Promise(r => setTimeout(r, 2500 * (attempt + 1)));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`sendRawTransaction failed for tx[${idx}]: ${message}`);
  };
  for (let w = 0; w < signedTxs.length; w += waveSize) {
    const waveEnd = Math.min(w + waveSize, signedTxs.length);
    const results = await Promise.allSettled(
      signedTxs.slice(w, waveEnd).map((tx, i) => sendWithRetry(tx, w + i)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.status === 'fulfilled') {
        sigs[w + i] = r.value;
      } else {
        const reason = r && 'reason' in r ? r.reason : undefined;
        throw reason instanceof Error ? reason : new Error(String(reason));
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

  const sigs = await sendTxsInWaves(conn, signedTxs.map((t) => new Uint8Array(t.serialize())));
  await confirmAllBatched(conn, sigs, 'Resize');
}

/** How the chunk transactions are paced. The defaults are what survived the public
 *  devnet endpoint's 429s; `live-timing.ts` measures the alternatives. */
export interface ChunkPacing {
  /** Transactions sent per wave (default 3). */
  waveSize?: number;
  /** Pause between waves in ms (default 700). */
  waveDelayMs?: number;
  /** Chunks per confirmation batch (default 20); `Infinity` = one batch. */
  batchSize?: number;
}

async function uploadChunksParallel(
  conn: Connection,
  proofBytes: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
  payer: Keypair | WalletSigner,
  programId: PublicKey,
  onProgress?: (step: string) => void,
  pacing: ChunkPacing = {},
  txV1 = true,
): Promise<void> {
  // [TX-V1] 3,840-byte chunks in 4,096-byte v1 transactions when the cluster's
  // gate is active and the payer is a keypair (raw signing); legacy otherwise.
  const v1 = txV1 && isKeypair(payer) && (await isTransactionV1Active(conn));
  const chunkSize = v1 ? V1_CHUNK_SIZE : MAX_CHUNK_SIZE;
  const totalChunks = Math.ceil(proofBytes.length / chunkSize);
  const BATCH_SIZE = Math.max(1, Math.min(totalChunks, pacing.batchSize ?? (v1 ? Infinity : 20))); // chunks per blockhash window
  const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);
  const MAX_BATCH_RETRIES = 4;

  for (let batchStart = 0; batchStart < totalChunks; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalChunks);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;

    interface Chunk { offset: number; data: Uint8Array }
    let remaining: Chunk[] = Array.from({ length: batchEnd - batchStart }, (_, j) => {
      const i = batchStart + j;
      const off = i * chunkSize;
      const end = Math.min(off + chunkSize, proofBytes.length);
      return { offset: off, data: proofBytes.slice(off, end) };
    });

    for (let attempt = 0; attempt < MAX_BATCH_RETRIES; attempt++) {
      onProgress?.(
        attempt === 0
          ? `Uploading proof batch ${batchNum}/${totalBatches}...`
          : `Retrying batch ${batchNum}/${totalBatches} (${remaining.length} chunks, attempt ${attempt + 1}/${MAX_BATCH_RETRIES})...`,
      );

      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const wires: Uint8Array[] = await Promise.all(
        remaining.map(async ({ offset, data }) => {
          if (v1) {
            return buildV1ChunkWire(offset, data, proofBuffer, payer as Keypair, programId, blockhash, lastValidBlockHeight);
          }
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
          return new Uint8Array(tx.serialize());
        }),
      );
      // MEASURED 2026-09-13 on Helius devnet: 21 v1 sends at 8 per 100 ms land
      // with 0 HTTP 429s; the public endpoint wants the legacy 3 per 700 ms.
      const sigs = await sendTxsInWaves(
        conn, wires, pacing.waveSize ?? (v1 ? 8 : 3), pacing.waveDelayMs ?? (v1 ? 100 : 700),
      );
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
// [L2-CLIENT 2026-09-13] Pre-sized proof buffers: ONE transaction, not nine
// ---------------------------------------------------------------------------
//
// `init_proof_buffer` allocates a PDA through a CPI, capped at 10,240 bytes, so
// an 80 KB proof cost one init plus seven or eight `resize_proof_buffer`
// transactions confirmed in turn. `init_proof_buffer_v3` initialises an account
// the CLIENT allocated with a top-level `SystemProgram.createAccount` (no such
// cap) in the same transaction. The account is a keypair derived from PUBLIC
// data, sha256(domain ‖ authority ‖ circuit_id ‖ attempt): as findable as a PDA
// (a rerun rearms its own buffer with `reset_proof_buffer`; a crash recovery can
// close it), and the key authorises exactly one thing, signing `createAccount`
// for that address -- once created the account belongs to the verifier program.
// Someone who computes the key can only OCCUPY the address first; the `attempt`
// byte steps past that. Twin of `apps/web/lib/privacy/pool/stark.ts`.
const PROOF_BUFFER_KEY_DOMAIN = 'p01/stark-proof-buffer/v3';
const PROOF_BUFFER_KEY_ATTEMPTS = 4;

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
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(DISCRIMINATORS.initProofBufferV3, u32LE(proofSize), new Uint8Array([circuitId])),
  });
}

function buildResetProofBufferIx(
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
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(DISCRIMINATORS.resetProofBuffer, u32LE(proofSize), new Uint8Array([circuitId])),
  });
}

/** The `ProofBuffer` header (83 bytes before the proof), as the verifier lays it out. */
export interface ProofBufferState {
  owner: PublicKey;
  authority: PublicKey;
  circuitId: number;
  proofSize: number;
  verified: boolean;
  deepAliVerified: boolean;
  /** Whole account size, header included. */
  space: number;
}

export function parseProofBufferState(owner: PublicKey, data: Uint8Array): ProofBufferState | null {
  if (data.length < PROOF_DATA_OFFSET) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    owner,
    authority: new PublicKey(data.subarray(8, 40)),
    circuitId: data[40] ?? 0,
    proofSize: view.getUint32(41, true),
    verified: data[49] === 1,
    deepAliVerified: data[82] === 1,
    space: data.length,
  };
}

export async function readProofBufferState(
  connection: Connection,
  proofBuffer: PublicKey,
): Promise<ProofBufferState | null> {
  const info = await connection.getAccountInfo(proofBuffer);
  if (!info) return null;
  return parseProofBufferState(info.owner, new Uint8Array(info.data));
}

/** Anchor's `InstructionFallbackNotFound` (101 = 0x65): the deployed program has no such instruction. */
function isUnknownInstruction(e: unknown): boolean {
  const msg = (e as Error)?.message ?? String(e);
  return /InstructionFallbackNotFound|Fallback functions are not supported|custom program error: (0x65|101)\b/i.test(msg);
}

/**
 * Allocate and initialise a buffer sized for the whole proof in ONE transaction
 * (`createAccount` + `init_proof_buffer_v3`), or rearm this authority's earlier
 * buffer at the same derived address (`reset_proof_buffer`, also one
 * transaction). Falls back to the PDA path only if the program answers that
 * `init_proof_buffer_v3` does not exist.
 */
async function allocateProofBuffer(
  connection: Connection,
  payer: Keypair | WalletSigner,
  proofSize: number,
  circuitId: number,
  programId: PublicKey,
  onProgress?: (step: string) => void,
): Promise<PublicKey> {
  const authority = payer.publicKey;
  const space = PROOF_DATA_OFFSET + proofSize;
  for (let attempt = 0; attempt < PROOF_BUFFER_KEY_ATTEMPTS; attempt++) {
    const kp = deriveProofBufferKeypair(authority, circuitId, attempt);
    const existing = await readProofBufferState(connection, kp.publicKey);
    if (existing) {
      const ours = existing.owner.equals(programId) && existing.authority.equals(authority);
      if (!ours) continue; // a stranger occupies the address: next derived one
      if (existing.space >= space) {
        onProgress?.('Rearming an existing proof buffer...');
        const resetTx = new Transaction().add(
          buildResetProofBufferIx(proofSize, circuitId, kp.publicKey, authority, programId),
        );
        await signSendConfirm(connection, resetTx, payer);
        return kp.publicKey;
      }
      onProgress?.('Closing an undersized proof buffer...');
      const closeTx = new Transaction().add(buildCloseProofBufferIx(kp.publicKey, authority, programId));
      await signSendConfirm(connection, closeTx, payer);
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
          programId,
        }),
      )
      .add(buildInitProofBufferV3Ix(proofSize, circuitId, kp.publicKey, authority, programId));
    try {
      await signSendConfirm(connection, createTx, payer, { extraSigners: [kp] });
    } catch (e) {
      if (!isUnknownInstruction(e)) throw e;
      console.warn('[stark-prover] init_proof_buffer_v3 is not deployed here, using the PDA path');
      return allocateProofBufferLegacy(connection, payer, proofSize, circuitId, programId, onProgress);
    }
    return kp.publicKey;
  }
  throw new Error(
    `Could not allocate a proof buffer: ${PROOF_BUFFER_KEY_ATTEMPTS} derived addresses are ` +
      'occupied by accounts that are not ours.',
  );
}

/** The pre-L2 sequence: close a stale PDA, `init_proof_buffer`, one resize per 10,240 bytes. */
async function allocateProofBufferLegacy(
  connection: Connection,
  payer: Keypair | WalletSigner,
  proofSize: number,
  circuitId: number,
  programId: PublicKey,
  onProgress?: (step: string) => void,
): Promise<PublicKey> {
  const authority = payer.publicKey;
  const [proofBuffer] = getProofBufferPda(authority, circuitId, programId);
  const existing = await connection.getAccountInfo(proofBuffer);
  if (existing) {
    onProgress?.('Closing stale proof buffer...');
    const closeTx = new Transaction().add(
      buildCloseProofBufferIx(proofBuffer, authority, programId),
    );
    try {
      await signSendConfirm(connection, closeTx, payer);
    } catch {
      await new Promise(r => setTimeout(r, 2000));
      const recheck = await connection.getAccountInfo(proofBuffer);
      if (recheck) {
        throw new Error(
          'Stale STARK proof buffer exists and cannot be closed. Wait a few seconds and try again, or use a different authority.',
        );
      }
    }
  }
  onProgress?.('Initializing proof buffer...');
  const initTx = new Transaction().add(
    buildInitProofBufferIx(proofSize, circuitId, proofBuffer, authority, programId),
  );
  await signSendConfirm(connection, initTx, payer);
  await resizeToTarget(connection, proofSize + PROOF_DATA_OFFSET, proofBuffer, authority, payer, programId, onProgress);
  return proofBuffer;
}

/**
 * Circuits whose phase 1 + phase 2 fit ONE transaction, with the measured sum
 * (litesvm, 2026-09-12, `docs/UNIFORM-MASKING-2026-09-11.md` §4a): C3 1,044,961,
 * C4 1,219,481, C6 1,075,102, C7 1,080,683 against the 1,400,000 CU a transaction
 * may request. C2 (1,357,548, 97%) is not merged; C1 (1,429,650) and C5
 * (1,416,705) exceed it; C0 runs both phases inside `verify_stark_proof`. A
 * merged transaction is atomic: a miss costs one failed transaction and the
 * two-transaction path runs instead.
 */
export const SINGLE_TX_VERIFY_CU: Readonly<Partial<Record<number, number>>> = {
  3: 1_044_961,
  4: 1_219_481,
  6: 1_075_102,
  7: 1_080_683,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface UploadAndVerifyOptions {
  retainBuffer?: boolean;
  programId?: PublicKey;
  onProgress?: (step: string) => void;
  /** [L2-CLIENT] Force the pre-L2 PDA path (init + resizes). For A/B timing; default false. */
  legacyBuffer?: boolean;
  /** [L2-CLIENT] Put phase 1 and phase 2 in one transaction where `SINGLE_TX_VERIFY_CU` allows. Default true. */
  mergePhases?: boolean;
  /** [L2-CLIENT] Chunk transaction pacing; defaults are the devnet-safe 3 / 700 ms / 20 (legacy) or 8 / 100 ms / one batch (v1). */
  chunkPacing?: ChunkPacing;
  /** [TX-V1] Use 4,096-byte transaction-v1 chunks when the cluster's gate is active and the payer is a keypair. Default true. */
  txV1?: boolean;
  /** Replace the chunk uploader entirely (the live harness measures transaction-v1 chunks this way). */
  uploadChunks?: (
    conn: Connection,
    proofBytes: Uint8Array,
    proofBuffer: PublicKey,
    authority: PublicKey,
    payer: Keypair | WalletSigner,
    programId: PublicKey,
    onProgress?: (step: string) => void,
  ) => Promise<void>;
}
export interface UploadAndVerifyResult {
  /** The buffer's address. Since [L2-CLIENT] a derived keypair address, a PDA only on the legacy path. */
  proofBufferPda: PublicKey;
  /** The signature of the transaction that set `deep_ali_verified` (phase 1's for circuit 0). */
  signature: string;
  authority: PublicKey;
  /** Every verify transaction that landed, in order. */
  verifySignatures: string[];
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

  // [L2-CLIENT 2026-09-13] one transaction allocates and initialises the buffer.
  const proofBuffer = options.legacyBuffer
    ? await allocateProofBufferLegacy(connection, payer, proofBytes.length, circuitId, programId, onProgress)
    : await allocateProofBuffer(connection, payer, proofBytes.length, circuitId, programId, onProgress);

  if (options.uploadChunks) {
    await options.uploadChunks(connection, proofBytes, proofBuffer, authority, payer, programId, onProgress);
  } else {
    await uploadChunksParallel(
      connection, proofBytes, proofBuffer, authority, payer, programId, onProgress, options.chunkPacing ?? {},
      options.txV1 ?? true,
    );
  }

  const budget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const verifySignatures: string[] = [];
  let signature = '';
  if (circuitId === 0) {
    onProgress?.('Verifying STARK proof on-chain...');
    const commitment = publicInputs[0] ?? 0n;
    const tx = new Transaction()
      .add(budget())
      .add(buildVerifyStarkProofIx(commitment, proofBuffer, authority, programId));
    signature = await signSendConfirm(connection, tx, payer);
    verifySignatures.push(signature);
  } else {
    const phase1 = buildVerifyStarkProofV2Ix(publicInputs, proofBuffer, authority, programId);
    const phase2 = buildVerifyDeepAliPhase2Ix(publicInputs, proofBuffer, authority, programId);
    let merged = false;
    if ((options.mergePhases ?? true) && SINGLE_TX_VERIFY_CU[circuitId] !== undefined) {
      onProgress?.('Verifying STARK proof (phase 1 + DEEP-ALI, one transaction)...');
      try {
        signature = await signSendConfirm(connection, new Transaction().add(budget()).add(phase1).add(phase2), payer);
        verifySignatures.push(signature);
        merged = true;
      } catch (e) {
        const state = await readProofBufferState(connection, proofBuffer);
        if (state?.verified && state.deepAliVerified) {
          // It landed; only our confirmation was lost.
          const recent = await connection.getSignaturesForAddress(proofBuffer, { limit: 1 });
          signature = recent[0]?.signature ?? '';
          verifySignatures.push(signature);
          merged = true;
        } else {
          console.warn('[stark-prover] merged verify did not land, falling back to two transactions:', (e as Error).message);
        }
      }
    }
    if (!merged) {
      onProgress?.('Verifying STARK proof phase 1...');
      signature = await signSendConfirm(connection, new Transaction().add(budget()).add(phase1), payer);
      verifySignatures.push(signature);
      onProgress?.('Verifying STARK proof phase 2 (DEEP-ALI)...');
      signature = await signSendConfirm(connection, new Transaction().add(budget()).add(phase2), payer);
      verifySignatures.push(signature);
    }
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

  return { proofBufferPda: proofBuffer, signature, authority, verifySignatures };
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
