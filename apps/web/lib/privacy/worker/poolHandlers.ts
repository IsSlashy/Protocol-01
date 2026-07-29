/**
 * poolHandlers — denominated-pool RPC, running inside the stealth Web Worker.
 *
 * Lives alongside the stealth core so there is exactly ONE secret-holding
 * thread in apps/web. The pool seed, note secrets, and the ephemeral depositor
 * keypair never cross back to the main thread; only public material does
 * (commitments, leaf indices, the ephemeral's PUBLIC key, transaction
 * signatures, and notes already encrypted to the user's own PQ address).
 *
 * Shield is deliberately two-phase, because the user's wallet lives on the main
 * thread and must sign the pre-fund:
 *
 *   1. `poolShieldPrepare` — read the tree, derive the note, prove C6, price the
 *      pre-fund. Nothing has moved on-chain yet.
 *   2. main thread — the wallet signs ONE transfer to the ephemeral.
 *   3. `poolShieldExecute` — the ephemeral signs the ~150 proof-chunk uploads
 *      and the shield itself, then sweeps its residual back.
 *
 * Everything the second phase needs is held in `prepared`, keyed by job id, and
 * dropped once the job finishes.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import {
  fetchPoolCommitments,
  findPoolV3,
  getPoolsForTokenV3,
  type PoolConfig,
} from '../pool/denominatedPool';
import {
  createNoteEncryptionAddress,
  decryptNote,
  encryptNote,
} from '../pool/noteCrypto';
import type { StoredMerklePath } from '../pool/unshieldFromPath';
import { recoverNotes, scanPoolForSeed, type RecoveredNote } from '../pool/poolNotes';
import { recoverStuckFloat } from '../pool/recoverFloat';
import { createPacedFetch } from './pacedFetch';
import { usePollingConfirmation } from './pollingConfirm';
import {
  executeUnshield,
  prepareUnshieldJob,
  type PreparedUnshield,
} from '../pool/unshieldEphemeral';
import {
  executeShield,
  prepareShield,
  readTreeLeafCount,
  recordShieldBreadcrumb,
  type PreparedShield,
} from '../pool/shieldEphemeral';

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export interface PoolShieldPrepareRequest {
  kind: 'poolShieldPrepare';
  /** Session key — the encoded meta returned by `deriveMeta`. */
  meta: string;
  token: 'SOL';
  denomination: number;
}

export interface PoolShieldExecuteRequest {
  kind: 'poolShieldExecute';
  jobId: string;
  /** Wallet that pre-funded the ephemeral; receives the swept residual. */
  ownerPubkey: string;
}

export interface PoolScanRequest {
  kind: 'poolScan';
  meta: string;
  token: 'SOL';
  /** Omit to scan every denomination of the token. */
  denomination?: number;
}

/** Withdraw a note. The note is identified by the pool + leaf index it occupies;
 *  its secrets are re-derived in here from the pool seed, so no secret crosses
 *  the wire in either direction. */
export interface PoolUnshieldPrepareRequest {
  kind: 'poolUnshieldPrepare';
  meta: string;
  token: 'SOL';
  denomination: number;
  leafIndex: number;
  /** Note blobs stored at shield time. The one whose commitment matches this
   *  note supplies the Merkle path, letting the withdrawal skip the history
   *  rebuild. Untrusted: each is authenticated by decryption and cross-checked
   *  against the derived note, and anything that fails is ignored. */
  encryptedNotes?: string[];
}

export interface PoolUnshieldExecuteRequest {
  kind: 'poolUnshieldExecute';
  jobId: string;
  /** Address that receives the withdrawn funds. */
  recipient: string;
  /** Wallet that pre-funded the ephemeral; receives the swept residual. */
  ownerPubkey: string;
}

export interface PoolRecoverRequest {
  kind: 'poolRecover';
  meta: string;
  token: 'SOL';
  denomination: number;
  ownerPubkey: string;
}

export type PoolRequest =
  | PoolRecoverRequest
  | PoolShieldPrepareRequest
  | PoolShieldExecuteRequest
  | PoolScanRequest
  | PoolUnshieldPrepareRequest
  | PoolUnshieldExecuteRequest;

export interface PoolShieldPrepareResponse {
  kind: 'poolShieldPrepare';
  jobId: string;
  /** Base58 — the main thread funds THIS address, then calls execute. */
  ephemeralPubkey: string;
  requiredLamports: number;
  denomination: number;
  counter: number;
}

export interface PoolShieldExecuteResponse {
  kind: 'poolShieldExecute';
  txSig: string;
  commitment: string;
  leafIndex: number;
  denomination: number;
  /** The note, encrypted to the user's own PQ address. Safe to persist as-is. */
  encryptedNote: string;
}

export interface PoolNoteView {
  pool: string;
  token: 'SOL' | 'USDC';
  denomination: number;
  counter: number;
  leafIndex: number;
  commitment: string;
  spent: boolean;
}

/**
 * How many notes exist in a pool overall. Surfaced so the UI can state a real
 * number instead of implying the pool is private in the abstract.
 *
 * This is a pool SIZE, not the anonymity set a withdrawal hides in. The v3
 * unshield passes the note commitment as a public instruction argument and the
 * deposit emitted the same value, so a withdrawal is publicly matchable to its
 * deposit and the effective set is ONE regardless of this count (verified on
 * devnet, docs/PAY_HANDOFF_OPUS5.md §10). PoolPanel says so explicitly — keep
 * it that way until the C7 spend circuit ships.
 */
export interface PoolSizeView {
  denomination: number;
  /** Leaves in the tree account — authoritative, unaffected by RPC pruning. */
  totalNotes: number;
  /** Leaves whose insert event the RPC still serves. Recovery-by-scan can only
   *  see these, so a large gap means notes are only findable from local
   *  storage until an archival RPC is available. */
  discoverableNotes: number;
}

export interface PoolScanResponse {
  kind: 'poolScan';
  notes: PoolNoteView[];
  /** Unspent total, in whole tokens. */
  shieldedBalance: number;
  poolSizes: PoolSizeView[];
}

export interface PoolUnshieldPrepareResponse {
  kind: 'poolUnshieldPrepare';
  jobId: string;
  ephemeralPubkey: string;
  requiredLamports: number;
  denomination: number;
}

export interface PoolUnshieldExecuteResponse {
  kind: 'poolUnshieldExecute';
  txSig: string;
  denomination: number;
}

export interface PoolRecoverResponse {
  kind: 'poolRecover';
  /** Total lamports swept back to the owner. */
  lamports: number;
  closedBuffers: number;
  keys: number;
}

export type PoolResponse =
  | PoolRecoverResponse
  | PoolShieldPrepareResponse
  | PoolShieldExecuteResponse
  | PoolScanResponse
  | PoolUnshieldPrepareResponse
  | PoolUnshieldExecuteResponse;

export type PoolResponseFor<R extends PoolRequest> = Extract<PoolResponse, { kind: R['kind'] }>;

// ---------------------------------------------------------------------------
// Worker-local state
// ---------------------------------------------------------------------------

let connection: Connection | null = null;

/** Pool seeds by meta. Same lifetime as the stealth sessions in workerCore. */
const poolSeeds = new Map<string, Uint8Array>();

/** In-flight shields, awaiting their pre-fund. */
const prepared = new Map<string, { ctx: PreparedShield; meta: string; counter: number }>();

/** In-flight withdrawals, awaiting their pre-fund. */
const preparedUnshields = new Map<string, { ctx: PreparedUnshield; meta: string }>();

export function configurePoolHandlers(rpcUrl: string): void {
  // Paced transport: a shield is ~150 chunk uploads plus polling, which public
  // devnet RPC answers with 429 if fired at full speed. See pacedFetch.ts.
  // Polling confirmation: a Worker has no working WebSocket subscription client
  // for web3.js, so the default confirmTransaction waits out the blockhash on
  // EVERY transaction (~58s each, ~14 per shield) and reports a landed
  // transaction as expired. See pollingConfirm.ts.
  connection = usePollingConfirmation(
    new Connection(rpcUrl, {
      commitment: 'confirmed',
      fetch: createPacedFetch(),
    }),
  );
}

/**
 * Derive and retain this identity's pool seed. Called by the worker entry right
 * after a successful `deriveMeta`, from the same wallet signature.
 *
 * Domain-separated from the stealth wallet seed so a compromise of one derived
 * key set says nothing about the other. Deterministic in the signature, so the
 * same wallet always reaches the same notes — that is what makes storage-free
 * recovery possible.
 */
export function setPoolSeed(meta: string, signature: Uint8Array): void {
  poolSeeds.set(meta, hkdf(sha256, signature, undefined, utf8ToBytes('p01:web:poolseed:v1'), 32));
}

export function clearPoolState(): void {
  poolSeeds.clear();
  prepared.clear();
  preparedUnshields.clear();
}

function requireSeed(meta: string): Uint8Array {
  const seed = poolSeeds.get(meta);
  if (!seed) {
    throw new Error('No pool keys for this identity. Reconnect and sign to derive.');
  }
  return seed;
}

function requireConnection(): Connection {
  if (!connection) throw new Error('Pool handlers are not configured.');
  return connection;
}

function requirePool(token: 'SOL', denomination: number): PoolConfig {
  const pool = findPoolV3(token, denomination);
  if (!pool) {
    const available = getPoolsForTokenV3(token).map((p) => p.denomination).join(', ');
    throw new Error(`No ${token} pool for ${denomination}. Supported: ${available}.`);
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePoolScan(
  req: PoolScanRequest,
  onProgress?: (step: string) => void,
): Promise<PoolScanResponse> {
  const conn = requireConnection();
  const seed = requireSeed(req.meta);
  const pools = req.denomination !== undefined
    ? [requirePool(req.token, req.denomination)]
    : getPoolsForTokenV3(req.token);

  const notes: PoolNoteView[] = [];
  const poolSizes: PoolSizeView[] = [];
  let shieldedBalance = 0;

  for (const pool of pools) {
    onProgress?.(`Scanning the ${pool.denomination} ${pool.token} pool...`);
    const commitments = await fetchPoolCommitments(conn, pool.poolPDA);
    poolSizes.push({
      denomination: pool.denomination,
      totalNotes: await readTreeLeafCount(conn, pool),
      discoverableNotes: commitments.size,
    });

    const { notes: found } = await scanPoolForSeed(conn, pool, seed, { commitments, onProgress });
    for (const n of found) {
      notes.push(toNoteView(n));
      if (!n.spent) shieldedBalance += pool.denomination;
    }
  }

  return { kind: 'poolScan', notes, shieldedBalance, poolSizes };
}

function toNoteView(n: RecoveredNote): PoolNoteView {
  return {
    pool: n.receipt.pool,
    token: n.receipt.token,
    denomination: n.receipt.denominationHuman,
    counter: n.counter,
    leafIndex: n.receipt.leafIndex,
    commitment: n.receipt.commitment.toString(),
    spent: n.spent,
  };
}

async function handlePoolShieldPrepare(
  req: PoolShieldPrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolShieldPrepareResponse> {
  const conn = requireConnection();
  const seed = requireSeed(req.meta);
  const pool = requirePool(req.token, req.denomination);

  // The counter is the tree's leaf index, read inside prepareShield from the
  // tree account — see the comment there for why scanning past notes would be
  // a fund-loss bug on a pruning RPC.
  const ctx = await prepareShield(pool, conn, seed, onProgress);

  // Breadcrumb before the caller funds anything, so a crash between the
  // pre-fund and execute still leaves a record pointing at a re-derivable key.
  await recordShieldBreadcrumb(ctx);

  const counter = ctx.prepared.insertParams.leafIndex;
  prepared.set(ctx.jobId, { ctx, meta: req.meta, counter });

  return {
    kind: 'poolShieldPrepare',
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    requiredLamports: ctx.requiredLamports,
    denomination: pool.denomination,
    counter,
  };
}

async function handlePoolShieldExecute(
  req: PoolShieldExecuteRequest,
  onProgress?: (step: string) => void,
): Promise<PoolShieldExecuteResponse> {
  const conn = requireConnection();
  const job = prepared.get(req.jobId);
  if (!job) {
    throw new Error('Unknown shield job — prepare it again (the worker was restarted).');
  }
  const seed = requireSeed(job.meta);

  try {
    const { txSig, receipt } = await executeShield(
      job.ctx,
      conn,
      new PublicKey(req.ownerPubkey),
      onProgress,
    );

    // Persist-ready note, encrypted to the user's OWN post-quantum address, so
    // the main thread can store it without ever seeing a secret. Recovery does
    // not depend on this blob (see poolNotes.ts) — it is the fast path.
    const encryptedNote = encryptNote(
      createNoteEncryptionAddress(seed),
      utf8ToBytes(JSON.stringify({
        version: 1,
        pool: receipt.pool,
        secret: receipt.secret.toString(),
        nullifier_preimage: receipt.nullifierPreimage.toString(),
        // KEY IS LOAD-BEARING: `extractStoredPath` below matches previously
        // stored blobs by parsing this exact shape, so `deposit_epoch` stays
        // even though the field is now `receipt.noteBlinding`. Renaming it
        // without a `version` bump silently drops the stored Merkle path.
        deposit_epoch: receipt.noteBlinding.toString(),
        token_mint: receipt.tokenMint.toString(),
        commitment: receipt.commitment.toString(),
        leafIndex: receipt.leafIndex,
        merklePath: {
          pathElements: job.ctx.prepared.merklePath.pathElements.map((e) => e.toString()),
          pathIndices: job.ctx.prepared.merklePath.pathIndices,
          root: job.ctx.prepared.merklePath.root.toString(),
        },
        token: receipt.token,
        denominationHuman: receipt.denominationHuman,
        shieldedAt: receipt.shieldedAt,
      })),
    );

    return {
      kind: 'poolShieldExecute',
      txSig,
      commitment: receipt.commitment.toString(),
      leafIndex: receipt.leafIndex,
      denomination: receipt.denominationHuman,
      encryptedNote,
    };
  } finally {
    prepared.delete(req.jobId);
  }
}

async function handlePoolUnshieldPrepare(
  req: PoolUnshieldPrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolUnshieldPrepareResponse> {
  const conn = requireConnection();
  const seed = requireSeed(req.meta);
  const pool = requirePool(req.token, req.denomination);

  // Rebuild the note from the seed: its secrets come from (seed, pool, leaf
  // index) and its deposit epoch is recovered by matching the derived
  // commitment against the on-chain leaf. No secret crosses the wire — but note
  // this is NOT an authorization boundary: the caller picks the leaf index, so
  // same-origin script can ask to spend any note this seed owns. What it cannot
  // do is learn the secrets or redirect funds outside the recipient it names.
  onProgress?.('Locating your note on-chain...');
  const notes = await recoverNotes(conn, pool, seed, { onProgress });
  const note = notes.find((n) => n.receipt.leafIndex === req.leafIndex);
  if (!note) {
    throw new Error(
      `No note of yours found at leaf #${req.leafIndex} in the ${pool.denomination} ` +
        `${pool.token} pool. If it was just shielded, wait for the RPC to index it.`,
    );
  }
  if (note.spent) throw new Error('This note has already been withdrawn.');

  const storedPath = extractStoredPath(seed, req.encryptedNotes, note.receipt.commitment);
  const ctx = await prepareUnshieldJob(note.receipt, pool, conn, seed, onProgress, storedPath);
  preparedUnshields.set(ctx.jobId, { ctx, meta: req.meta });

  return {
    kind: 'poolUnshieldPrepare',
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    requiredLamports: ctx.requiredLamports,
    denomination: pool.denomination,
  };
}

/**
 * Pull the Merkle path out of a stored note blob, if it is genuinely ours and
 * describes this exact note. Anything unparseable or mismatched is ignored —
 * the caller then rebuilds from history, which is always correct.
 */
function extractStoredPath(
  seed: Uint8Array,
  blobs: string[] | undefined,
  expectedCommitment: bigint,
): StoredMerklePath | undefined {
  for (const blob of blobs ?? []) {
    try {
      const note = JSON.parse(new TextDecoder().decode(decryptNote(seed, blob)));
      if (String(note.commitment) !== expectedCommitment.toString()) continue;
      const p = note.merklePath;
      if (!p || !Array.isArray(p.pathElements) || !Array.isArray(p.pathIndices) || !p.root) {
        continue;
      }
      return {
        pathElements: p.pathElements.map(String),
        pathIndices: p.pathIndices.map(Number),
        root: String(p.root),
      };
    } catch {
      // Not ours, or from a different seed — try the next.
    }
  }
  return undefined;
}

async function handlePoolUnshieldExecute(
  req: PoolUnshieldExecuteRequest,
  onProgress?: (step: string) => void,
): Promise<PoolUnshieldExecuteResponse> {
  const conn = requireConnection();
  const job = preparedUnshields.get(req.jobId);
  if (!job) {
    throw new Error('Unknown withdrawal job — prepare it again (the worker was restarted).');
  }

  try {
    const { txSig } = await executeUnshield(
      job.ctx,
      conn,
      new PublicKey(req.recipient),
      new PublicKey(req.ownerPubkey),
      onProgress,
    );
    return {
      kind: 'poolUnshieldExecute',
      txSig,
      denomination: job.ctx.poolConfig.denomination,
    };
  } finally {
    preparedUnshields.delete(req.jobId);
  }
}

/**
 * Reclaim SOL stranded on ephemerals from earlier failed runs. Refuses while a
 * job is in flight for safety — it closes proof buffers, and a live upload is
 * writing into one.
 */
async function handlePoolRecover(
  req: PoolRecoverRequest,
  onProgress?: (step: string) => void,
): Promise<PoolRecoverResponse> {
  const conn = requireConnection();
  const seed = requireSeed(req.meta);
  const pool = requirePool(req.token, req.denomination);

  if (prepared.size > 0 || preparedUnshields.size > 0) {
    throw new Error('A shield or withdrawal is still in progress — finish it before recovering.');
  }

  onProgress?.('Looking for funds left on earlier attempts...');
  const found = await recoverStuckFloat(conn, pool, seed, new PublicKey(req.ownerPubkey), {
    onProgress,
  });

  return {
    kind: 'poolRecover',
    lamports: found.reduce((n, f) => n + f.lamports, 0),
    closedBuffers: found.reduce((n, f) => n + f.closedBuffers, 0),
    keys: found.length,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handlePoolRequest<R extends PoolRequest>(
  req: R,
  onProgress?: (step: string) => void,
): Promise<PoolResponseFor<R>> {
  let res: PoolResponse;
  switch (req.kind) {
    case 'poolScan':
      res = await handlePoolScan(req, onProgress);
      break;
    case 'poolShieldPrepare':
      res = await handlePoolShieldPrepare(req, onProgress);
      break;
    case 'poolShieldExecute':
      res = await handlePoolShieldExecute(req, onProgress);
      break;
    case 'poolRecover':
      res = await handlePoolRecover(req, onProgress);
      break;
    case 'poolUnshieldPrepare':
      res = await handlePoolUnshieldPrepare(req, onProgress);
      break;
    case 'poolUnshieldExecute':
      res = await handlePoolUnshieldExecute(req, onProgress);
      break;
    default: {
      const _exhaustive: never = req;
      throw new Error(`Unknown pool request: ${JSON.stringify(_exhaustive)}`);
    }
  }
  return res as PoolResponseFor<R>;
}
