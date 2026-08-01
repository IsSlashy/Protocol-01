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
import { utf8ToBytes } from '@noble/hashes/utils.js';

import {
  fetchPoolCommitments,
  findPoolV3,
  getPoolsForTokenV3,
  type PoolConfig,
} from '../pool/denominatedPool';
import {
  assertPassphraseAcceptable,
  derivePoolSeeds,
  normalizePassphrase,
  seedsInSearchOrder,
  wipePoolSeeds,
  type DerivationVersion,
  type PoolSeedSet,
  type SeedCandidate,
} from '../pool/seedDerivation';
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

/**
 * Arm the passphrase that the NEXT `deriveMeta` will mix into the pool seed.
 *
 * Why it is a separate message and why it clears state: the pool seed is built
 * the instant the wallet signature reaches the worker, and the signature is
 * wiped immediately after (`stealth.worker.ts`), so a passphrase supplied later
 * could not be applied without retaining the signature — which would hand a
 * post-quantum attacker the same one-secret target this whole mechanism exists
 * to remove. So arming a passphrase drops every derived seed and the caller must
 * re-sign. `requiresRederive` says so explicitly rather than leaving the caller
 * to assume a silent no-op worked.
 *
 * Send `passphrase: null` to disarm and go back to the legacy derivation.
 */
export interface PoolSetPassphraseRequest {
  kind: 'poolSetPassphrase';
  passphrase: string | null;
}

export type PoolRequest =
  | PoolRecoverRequest
  | PoolShieldPrepareRequest
  | PoolShieldExecuteRequest
  | PoolScanRequest
  | PoolSetPassphraseRequest
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
  /** Which seed derivation owns this note — 1 = wallet signature only,
   *  2 = signature + passphrase. Notes shielded before a passphrase was adopted
   *  stay at 1 forever and remain spendable from the signature alone. */
  derivation: DerivationVersion;
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
  /** Seed derivation the note was found under, resolved in the worker. */
  derivation: DerivationVersion;
}

export interface PoolSetPassphraseResponse {
  kind: 'poolSetPassphrase';
  /** Always true — the caller must re-run deriveMeta for this to take effect. */
  requiresRederive: true;
  /** True when a passphrase is now armed, false when it was disarmed. */
  armed: boolean;
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
  | PoolSetPassphraseResponse
  | PoolUnshieldPrepareResponse
  | PoolUnshieldExecuteResponse;

export type PoolResponseFor<R extends PoolRequest> = Extract<PoolResponse, { kind: R['kind'] }>;

// ---------------------------------------------------------------------------
// Worker-local state
// ---------------------------------------------------------------------------

let connection: Connection | null = null;

/** Pool seeds by meta. Same lifetime as the stealth sessions in workerCore. */
const poolSeeds = new Map<string, PoolSeedSet>();

/**
 * Passphrase armed by `poolSetPassphrase`, consumed by the next `setPoolSeed`.
 *
 * Held only between those two calls, and only in this worker — it never reaches
 * the main thread and is never persisted. It is deliberately NOT stored
 * alongside the seed: once the seed exists the passphrase has done its job.
 */
let armedPassphrase: string | null = null;

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
 * Derive and retain this identity's pool seeds. Called by the worker entry right
 * after a successful `deriveMeta`, from the same wallet signature.
 *
 * Domain-separated from the stealth wallet seed so a compromise of one derived
 * key set says nothing about the other. Deterministic in the signature (and, when
 * armed, the passphrase), so the same wallet always reaches the same notes — that
 * is what makes storage-free recovery possible.
 *
 * With a passphrase armed this stores BOTH the salted seed and the legacy one:
 * a wallet that adopts a passphrase must not lose sight of the notes it shielded
 * before. See `seedDerivation.ts`.
 */
export function setPoolSeed(meta: string, signature: Uint8Array, passphrase?: string | null): void {
  const existing = poolSeeds.get(meta);
  if (existing) wipePoolSeeds(existing);
  poolSeeds.set(meta, derivePoolSeeds(signature, passphrase ?? armedPassphrase));
  armedPassphrase = null;
}

export function clearPoolState(): void {
  for (const set of poolSeeds.values()) wipePoolSeeds(set);
  poolSeeds.clear();
  armedPassphrase = null;
  prepared.clear();
  preparedUnshields.clear();
}

function requireSeeds(meta: string): PoolSeedSet {
  const seeds = poolSeeds.get(meta);
  if (!seeds) {
    throw new Error('No pool keys for this identity. Reconnect and sign to derive.');
  }
  return seeds;
}

/**
 * The seed NEW notes are created under. Read paths must use
 * `seedsInSearchOrder(requireSeeds(meta))` instead, or they will hide every note
 * shielded before the passphrase was adopted.
 */
function requireActiveSeed(meta: string): Uint8Array {
  return requireSeeds(meta).active;
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
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));
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

    // Every derivation this identity holds, not just the active one — a wallet
    // that adopted a passphrase still owns everything it shielded before, and a
    // note that stops appearing in the balance is a note the user believes is
    // gone. The commitment map is fetched once and reused across derivations.
    const seenLeaves = new Set<number>();
    for (const candidate of candidates) {
      const { notes: found } = await scanPoolForSeed(conn, pool, candidate.seed, {
        commitments,
        onProgress,
      });
      for (const n of found) {
        // A leaf can only belong to one derivation; a second hit would mean a
        // commitment collision. Keep the active-derivation view and drop the
        // duplicate rather than double-count the balance.
        if (seenLeaves.has(n.receipt.leafIndex)) continue;
        seenLeaves.add(n.receipt.leafIndex);
        notes.push(toNoteView(n, candidate.derivation));
        if (!n.spent) shieldedBalance += pool.denomination;
      }
    }
  }

  return { kind: 'poolScan', notes, shieldedBalance, poolSizes };
}

function toNoteView(n: RecoveredNote, derivation: DerivationVersion): PoolNoteView {
  return {
    pool: n.receipt.pool,
    token: n.receipt.token,
    denomination: n.receipt.denominationHuman,
    counter: n.counter,
    leafIndex: n.receipt.leafIndex,
    commitment: n.receipt.commitment.toString(),
    spent: n.spent,
    derivation,
  };
}

async function handlePoolShieldPrepare(
  req: PoolShieldPrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolShieldPrepareResponse> {
  const conn = requireConnection();
  // Active seed only: a new note is always created under the current derivation.
  const seed = requireActiveSeed(req.meta);
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
  // Same seed the note was prepared under; the blob is encrypted to that seed's
  // own PQ address, so a salted wallet's blobs are unreadable by the legacy seed.
  const seed = requireActiveSeed(job.meta);

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
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));
  const pool = requirePool(req.token, req.denomination);

  // Rebuild the note from the seed: its secrets come from (seed, pool, leaf
  // index) and its deposit epoch is recovered by matching the derived
  // commitment against the on-chain leaf. No secret crosses the wire — but note
  // this is NOT an authorization boundary: the caller picks the leaf index, so
  // same-origin script can ask to spend any note this seed owns. What it cannot
  // do is learn the secrets or redirect funds outside the recipient it names.
  //
  // Every derivation is tried, active first. A note shielded before the wallet
  // adopted a passphrase is a v1 note: its secrets, its withdrawal ephemeral and
  // its stored blob all key off the legacy seed, and using the active seed for
  // any of them would produce a proof for a commitment that is not on the tree.
  //
  // The commitment map is fetched ONCE and reused across derivations, the same
  // way handlePoolScan does it. Letting each candidate call recoverNotes bare
  // would re-pull the pool's whole history per derivation, i.e. double the
  // heaviest RPC call on the withdrawal path for every passphrase wallet — and
  // a Helius devnet 429 arrives as HTTP 200 with a JSON-RPC -32429 body, so the
  // second pull failing does not look like a failure.
  onProgress?.('Locating your note on-chain...');
  const commitments = await fetchPoolCommitments(conn, pool.poolPDA);
  let owner: { candidate: SeedCandidate; note: RecoveredNote } | null = null;
  for (const candidate of candidates) {
    const notes = await recoverNotes(conn, pool, candidate.seed, { commitments, onProgress });
    const hit = notes.find((n) => n.receipt.leafIndex === req.leafIndex);
    if (hit) {
      owner = { candidate, note: hit };
      break;
    }
  }
  if (!owner) {
    throw new Error(
      `No note of yours found at leaf #${req.leafIndex} in the ${pool.denomination} ` +
        `${pool.token} pool. If it was just shielded, wait for the RPC to index it.`,
    );
  }
  const { candidate, note } = owner;
  if (note.spent) throw new Error('This note has already been withdrawn.');

  const seed = candidate.seed;
  const storedPath = extractStoredPath(seed, req.encryptedNotes, note.receipt.commitment);
  const ctx = await prepareUnshieldJob(note.receipt, pool, conn, seed, onProgress, storedPath);
  preparedUnshields.set(ctx.jobId, { ctx, meta: req.meta });

  return {
    kind: 'poolUnshieldPrepare',
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    requiredLamports: ctx.requiredLamports,
    denomination: pool.denomination,
    derivation: candidate.derivation,
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
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));
  const pool = requirePool(req.token, req.denomination);

  if (prepared.size > 0 || preparedUnshields.size > 0) {
    throw new Error('A shield or withdrawal is still in progress — finish it before recovering.');
  }

  onProgress?.('Looking for funds left on earlier attempts...');
  // Sweep every derivation. Float stranded on an ephemeral derived before the
  // wallet adopted a passphrase is only reachable through the legacy seed, and
  // that float is often ~1 SOL of proof-buffer rent.
  const found = [];
  for (const candidate of candidates) {
    found.push(
      ...(await recoverStuckFloat(conn, pool, candidate.seed, new PublicKey(req.ownerPubkey), {
        onProgress,
      })),
    );
  }

  return {
    kind: 'poolRecover',
    lamports: found.reduce((n, f) => n + f.lamports, 0),
    closedBuffers: found.reduce((n, f) => n + f.closedBuffers, 0),
    keys: found.length,
  };
}

/**
 * Arm (or disarm) the passphrase the next derivation will mix in, and drop every
 * seed already derived so nothing keeps running under the old derivation.
 *
 * `derivePoolSeeds` validates the passphrase — a too-short one throws here,
 * before any state is touched, so a rejected passphrase leaves the session
 * exactly as it was.
 */
function handlePoolSetPassphrase(req: PoolSetPassphraseRequest): PoolSetPassphraseResponse {
  // Validate BEFORE touching any state, so a rejected passphrase leaves the
  // session exactly as it was rather than logging the user out of their notes.
  const normalized =
    normalizePassphrase(req.passphrase) === null
      ? null
      : assertPassphraseAcceptable(req.passphrase as string);
  clearPoolState();
  armedPassphrase = normalized;
  return { kind: 'poolSetPassphrase', requiresRederive: true, armed: normalized !== null };
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
    case 'poolSetPassphrase':
      res = handlePoolSetPassphrase(req);
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
