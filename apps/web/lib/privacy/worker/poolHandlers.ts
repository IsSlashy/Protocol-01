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
  buildMerkleProofFromLeavesV3,
  fetchPoolCommitments,
  findPoolV3,
  getPoolsForTokenV3,
  type OnChainCommitment,
  type PoolConfig,
  isNullifierSpent,
  type PoolToken,
  type ShareableNote,
  shareableNoteToReceipt,
  ALL_POOLS_V3,
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
  isEncryptedNoteBlob,
  isNoteEncryptionAddress,
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
import {
  executeSubscribe,
  prepareSubscribeJob,
  type PreparedSubscribe,
} from '../pool/subscribeEphemeral';
import {
  deriveLicenseSecret,
  encodeLicenseKey,
  licenseCommitment,
  licenseServiceTag,
} from '../license';

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export interface PoolShieldPrepareRequest {
  kind: 'poolShieldPrepare';
  /** Session key — the encoded meta returned by `deriveMeta`. */
  meta: string;
  token: PoolToken;
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
  token: PoolToken;
  /** Omit to scan every denomination of the token. */
  denomination?: number;
}

/**
 * Read the caller's notes out of the blobs stored at shield time — NO RPC.
 *
 * A full `poolScan` walks every denomination's transaction history and then
 * re-derives per seed candidate: on the public devnet RPC that is tens of
 * seconds, and the user stares at "Scanning the 0.1 SOL pool…" while the app
 * already holds everything it needs to draw the list. A note shielded from this
 * browser was written to local storage encrypted under the pool seed, and that
 * blob carries the pool, the denomination, the leaf index, the commitment and
 * the Merkle path.
 *
 * WHAT THIS CANNOT KNOW, AND WHY IT MATTERS: whether the note has been SPENT.
 * That lives in a nullifier PDA on chain. So every note this returns is marked
 * `spentKnown: false`, and the caller must treat it as provisional and reconcile
 * with a real `poolScan`. Rendering a spent note as available would be a worse
 * defect than the delay this removes — it would invite the user to try to spend
 * money that is gone.
 */
export interface PoolScanLocalRequest {
  kind: 'poolScanLocal';
  meta: string;
  /** The encrypted blobs from local storage. The page holds them; the worker holds the key. */
  blobs: string[];
}

export interface PoolScanLocalResponse {
  kind: 'poolScanLocal';
  notes: PoolNoteView[];
  /** Blobs that decrypted under no seed this identity holds — someone else's, or corrupt. */
  skipped: number;
}

/** Withdraw a note. The note is identified by the pool + leaf index it occupies;
 *  its secrets are re-derived in here from the pool seed, so no secret crosses
 *  the wire in either direction. */
export interface PoolUnshieldPrepareRequest {
  kind: 'poolUnshieldPrepare';
  meta: string;
  token: PoolToken;
  denomination: number;
  leafIndex: number;
  /** Note blobs from the local store. Two jobs: the one whose commitment
   *  matches this note supplies the Merkle path, letting the withdrawal skip
   *  the history rebuild; and when the seed derivation finds nothing at this
   *  leaf, they identify a RECEIVED note (secrets from the sender's seed, so
   *  only the blob knows them). Untrusted either way: each is authenticated by
   *  decryption under this identity's own seeds, the commitment is recomputed
   *  from the secrets, and anything that fails is ignored. */
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

/**
 * Open a subscription vault from a note. Identical selection shape to
 * `poolUnshieldPrepare` — pool + leaf index, secrets re-derived in here — because
 * `subscribe_private_stark` consumes the same note, the same way, with the same
 * C1 + C3 pair.
 */
export interface PoolSubscribePrepareRequest {
  kind: 'poolSubscribePrepare';
  meta: string;
  token: PoolToken;
  denomination: number;
  leafIndex: number;
  /** Note blobs stored at shield time; see `PoolUnshieldPrepareRequest`. */
  encryptedNotes?: string[];
}

/**
 * Finish a prepared subscription.
 *
 * WHAT IS DELIBERATELY ABSENT FROM THIS TYPE
 * ──────────────────────────────────────────
 * `subscriberCommitment` and `licenseCommitment` are NOT wire fields, and adding
 * them would be a security regression, not a convenience. Both are functions of
 * the note secret, so the main thread cannot compute them — it has never seen a
 * secret and must not. Accepting them from the page would mean either the page
 * holds the secret (defeating the worker boundary outright) or it supplies values
 * it cannot check, in which case a wrong `subscriberCommitment` silently opens a
 * vault at an address the subscriber can never prove ownership of. They are
 * computed in here instead; see the two handlers for where and why.
 *
 * `vkHashSubscriber` IS a wire field: it is inert metadata, not secret-derived.
 */
export interface PoolSubscribeExecuteRequest {
  kind: 'poolSubscribeExecute';
  jobId: string;
  /** Wallet that pre-funded the ephemeral; receives the swept residual. */
  ownerPubkey: string;
  /** Merchant who can claim each period. */
  retailer: string;
  /** u64 decimal strings — the worker boundary carries JSON-safe primitives. */
  rate: string;
  intervalSlots: string;
  /**
   * Registry `serviceId` the license key is scoped to. Omitted (free-form
   * merchant) falls back to the retailer address, exactly as
   * `licenseServiceTag` defines it — the same rule mobile and the merchant SDK
   * apply, and normalising it here would orphan every key already issued.
   */
  serviceId?: string | null;
  /** 32 bytes of inert vault metadata. Defaults to zeros, as the extension does. */
  vkHashSubscriber?: number[];
}

/**
 * Seal one of the caller's own notes to somebody else's published note address.
 *
 * WHY THIS HANDLER EXISTS AT ALL, AND WHY IT CANNOT LIVE ON THE PAGE
 * ─────────────────────────────────────────────────────────────────
 * Handing a note over is the only path in this product that moves value with
 * NO transaction: the recipient ends up holding the note's secrets and spends
 * it later as their own. Nothing is broadcast, so there is no send transaction
 * for an observer to pair with anything. (What that does NOT buy is stated on
 * the UI — see SendForm.tsx — because the recipient's eventual withdrawal still
 * republishes the commitment this note's deposit already published, so the exit
 * is matchable to the sender's deposit. Only C7 closes that.)
 *
 * A `ShareableNote` is made almost entirely of note SECRETS (`secret`,
 * `nullifier_preimage`, the blinding). `PoolNoteView` — the only note shape the
 * main thread ever sees — deliberately carries none of them, so the page
 * physically cannot assemble one. The encode AND the encryption therefore both
 * happen in here and only the sealed ciphertext crosses back.
 *
 * DO NOT "simplify" this by returning the plaintext note and encrypting on the
 * page. That would put three spendable secrets on the main thread for every
 * handoff, which is the exact boundary this worker exists to hold.
 */
export interface PoolExportNoteRequest {
  kind: 'poolExportNote';
  meta: string;
  token: PoolToken;
  denomination: number;
  /** Which note to hand over, by the leaf index it occupies. */
  leafIndex: number;
  /** Recipient's published `p01pq:` note address. Validated before any work. */
  recipientAddress: string;
  /** Note blobs stored at shield time; the matching one supplies the Merkle
   *  path, so the recipient can withdraw without an RPC history rebuild. */
  encryptedNotes?: string[];
}

/**
 * Open a sealed `p01enc1:` note handed to THIS identity, validate it, and give
 * the page a blob it can persist. The receiving mirror of `poolExportNote`.
 *
 * WHY THE WHOLE CHAIN RUNS IN HERE
 * ────────────────────────────────
 * The plaintext inside a sealed note is three spendable secrets. Decrypting on
 * the page would put them on the main thread, which is the exact boundary this
 * worker exists to hold, so decryption, validation and re-encryption all happen
 * here and only ciphertext plus public fields cross back.
 *
 * The validation is `shareableNoteToReceipt`, the same integrity guard the
 * extension's import runs: it recomputes the commitment from the secrets and
 * refuses a mismatch, so a corrupted or fabricated note cannot enter the store
 * looking like money.
 *
 * WHY IT RE-ENCRYPTS INSTEAD OF STORING WHAT ARRIVED
 * ──────────────────────────────────────────────────
 * The incoming blob is sealed to us, so it would technically keep. But the
 * local note store is read by `poolScanLocal`, `poolResolveSpent` and
 * `extractStoredPath`, all of which decrypt with this identity's own seeds and
 * expect the exact JSON shape `poolShieldExecute` writes. Re-encrypting into
 * that shape makes a received note a first-class citizen of the store: it
 * paints in the note lists with no pool scan, and its spent status resolves
 * through the same nullifier read as every other local note.
 *
 * HOW A RECEIVED NOTE IS LATER SPENT: through the exact same paths as a
 * shielded one. `locateOwnedNote` first searches the seed derivations (a
 * received note's secrets came from the sender's seed, so that search always
 * misses) and then falls back to rebuilding the receipt from these stored
 * blobs, so the existing withdraw, subscribe and hand-over handlers all find
 * it without any dedicated path.
 */
export interface PoolImportNoteRequest {
  kind: 'poolImportNote';
  meta: string;
  /** The pasted `p01enc1:` blob, sealed to this identity's note address. */
  sealedNote: string;
  /** Blobs already stored locally, so importing the same note twice is refused
   *  instead of silently drawing the same money as two rows. */
  encryptedNotes?: string[];
}

export interface PoolImportNoteResponse {
  kind: 'poolImportNote';
  /** The note re-encrypted to the caller's OWN address, in the store's blob
   *  shape. Safe to persist as-is; `poolScanLocal` lists it from here on. */
  encryptedNote: string;
  /** Public view of what was received. No secret crosses back. */
  note: PoolNoteView;
  /** Whether a Merkle path travelled inside the sealed note ('stored') or the
   *  eventual spend will have to rebuild it from pool history ('none'). */
  merklePath: 'stored' | 'none';
}

/**
 * This identity's own `p01pq:` note address, the one a sender seals notes to.
 *
 * A read of PUBLIC material only (`noteCrypto.ts`: addresses are public-key
 * bytes, safe to share anywhere), but it is a function of the pool seed, which
 * never leaves this worker, so the derivation has to happen here.
 */
export interface PoolNoteAddressRequest {
  kind: 'poolNoteAddress';
  meta: string;
}

export interface PoolNoteAddressResponse {
  kind: 'poolNoteAddress';
  /** `p01pq:<base64>`, derived from the ACTIVE seed: the address to publish. */
  address: string;
}

export interface PoolRecoverRequest {
  kind: 'poolRecover';
  meta: string;
  token: PoolToken;
  denomination: number;
  ownerPubkey: string;
}

/**
 * Resolve `spent` for the notes this browser holds locally, against the chain.
 *
 * WHY THIS EXISTS: `poolScanLocal` paints the list in milliseconds but marks
 * every note `spentKnown: false`, because whether a note is spent lives in an on-chain
 * nullifier PDA. The full `poolScan` would answer, but it enumerates candidate
 * epochs across six denominations first and does not finish in a time a user
 * waits. Meanwhile a note spent by an early subscription (before the local
 * spent record existed), on another device, or in a wiped session keeps being
 * OFFERED in the pickers. The blobs already carry `secret` and
 * `nullifier_preimage`, so the worker can compute each note's nullifier
 * directly and check PDA existence: one `getAccountInfo` per local note,
 * seconds instead of never.
 *
 * Read-only: no transaction, no state written, nothing stored.
 */
export interface PoolResolveSpentRequest {
  kind: 'poolResolveSpent';
  meta: string;
  /** The encrypted blobs from local storage, same contract as `poolScanLocal`. */
  blobs: string[];
}

export interface PoolResolveSpentResponse {
  kind: 'poolResolveSpent';
  /**
   * `"<poolPDA>:<leafIndex>"` -> whether the nullifier PDA exists on chain.
   * `true` is definitive (the note is spent). `false` is the chain's answer at
   * this instant; callers must only ever promote a note from unspent to spent
   * off this map, never the reverse: a locally recorded spend stays spent.
   * Notes whose RPC read failed are ABSENT from the map, not reported false.
   */
  spent: Record<string, boolean>;
  /** Notes checked against the chain. */
  checked: number;
  /** Blobs that decrypted under no seed this identity holds. */
  skipped: number;
  /** Notes whose nullifier read failed; absent from `spent`. */
  unresolved: number;
}

/**
 * Re-derive the license key of a subscription paid for by a local note.
 *
 * `poolSubscribeExecute` already returns this exact key to the page at
 * purchase time, so answering again later moves the MOMENT, not the trust
 * boundary: the key is a 128-bit HKDF leg of the note secret, scoped by the
 * service tag, and cannot be inverted to spend the note. The secret itself
 * still never leaves the worker, and the key is derived on demand precisely so
 * that no store anywhere has to hold a bearer credential.
 *
 * ⛔ Never log the key, and never put it in an error message.
 */
export interface PoolLicenseKeyRequest {
  kind: 'poolLicenseKey';
  meta: string;
  /** The encrypted blobs from local storage; the matching one holds the secret. */
  blobs: string[];
  /** Pool PDA (base58) + leaf index identifying the note that paid. */
  pool: string;
  leafIndex: number;
  /** The string the key is scoped to: registry slug, else retailer address. */
  serviceTag: string;
}

export interface PoolLicenseKeyResponse {
  kind: 'poolLicenseKey';
  /** The "P01-…" key, re-derived. Displayed, never stored, never logged. */
  licenseKey: string;
  serviceTag: string;
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
  | PoolExportNoteRequest
  | PoolImportNoteRequest
  | PoolLicenseKeyRequest
  | PoolNoteAddressRequest
  | PoolRecoverRequest
  | PoolResolveSpentRequest
  | PoolShieldPrepareRequest
  | PoolShieldExecuteRequest
  | PoolScanRequest
  | PoolSetPassphraseRequest
  | PoolSubscribePrepareRequest
  | PoolSubscribeExecuteRequest
  | PoolUnshieldPrepareRequest
  | PoolUnshieldExecuteRequest
  | PoolScanLocalRequest;

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
  /**
   * Has `spent` actually been checked against the chain?
   *
   * `false` for a note read from local storage by `poolScanLocal`, which cannot
   * see a nullifier PDA. A caller showing such a note must say it is provisional
   * and must not offer to spend it as if the status were known.
   */
  spentKnown?: boolean;
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

export interface PoolSubscribePrepareResponse {
  kind: 'poolSubscribePrepare';
  jobId: string;
  ephemeralPubkey: string;
  requiredLamports: number;
  denomination: number;
  derivation: DerivationVersion;
}

export interface PoolSubscribeExecuteResponse {
  kind: 'poolSubscribeExecute';
  txSig: string;
  /** Base58 subscription vault PDA. Public — it is derivable from the chain. */
  vaultPDA: string;
  /**
   * The "P01-…" license key. This crosses the boundary ON PURPOSE: it is the
   * product the user is buying, and it is the ONE derived value that must reach
   * the page. It is a 128-bit HKDF leg of the note secret, not the secret — it
   * cannot be inverted to spend the note, and a merchant only ever sees
   * `blake3` of it.
   */
  licenseKey: string;
  /** The string the key is scoped to. A merchant needs it to check the key. */
  serviceTag: string;
  denomination: number;
}

/**
 * WHAT IS DELIBERATELY ABSENT FROM THIS TYPE: the note itself. `sealedNote` is
 * ciphertext under the RECIPIENT's public key, so even the tab that asked for it
 * cannot read it back. Every other field here is already public on chain.
 */
export interface PoolExportNoteResponse {
  kind: 'poolExportNote';
  /** `p01enc1:<base64>` — hybrid X25519 + ML-KEM-768, sealed to the recipient. */
  sealedNote: string;
  denomination: number;
  leafIndex: number;
  /** Public: the deposit already published it on chain. */
  commitment: string;
  /** Seed derivation the note was found under, resolved in the worker. */
  derivation: DerivationVersion;
  /**
   * Where the Merkle path in the sealed note came from, so the UI can say
   * whether the recipient will need this pool's RPC history to withdraw.
   *   'stored'  — the exact witness captured at shield time (never wrong).
   *   'rebuilt' — recomputed from the leaves this RPC still serves (best
   *               effort: a pruned RPC yields a root the pool will reject).
   *   'none'    — no path travels with the note; the recipient rebuilds.
   * In every case the receiving side re-checks the root against the pool's
   * historical ring before it uses it (`unshieldFromPath.ts:isRootAccepted`)
   * and falls back to a full rebuild, so a stale path costs time, not funds.
   */
  merklePath: 'stored' | 'rebuilt' | 'none';
}

export interface PoolRecoverResponse {
  kind: 'poolRecover';
  /** Total lamports swept back to the owner. */
  lamports: number;
  closedBuffers: number;
  keys: number;
}

export type PoolResponse =
  | PoolExportNoteResponse
  | PoolImportNoteResponse
  | PoolLicenseKeyResponse
  | PoolNoteAddressResponse
  | PoolRecoverResponse
  | PoolResolveSpentResponse
  | PoolShieldPrepareResponse
  | PoolShieldExecuteResponse
  | PoolScanResponse
  | PoolSetPassphraseResponse
  | PoolSubscribePrepareResponse
  | PoolSubscribeExecuteResponse
  | PoolUnshieldPrepareResponse
  | PoolUnshieldExecuteResponse
  | PoolScanLocalResponse;

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

/**
 * In-flight subscriptions, awaiting their pre-fund.
 *
 * `subscriberCommitment` is carried here rather than recomputed at execute time:
 * it is a wasm call, and a wasm failure must land in PREPARE, before the wallet
 * has moved the float, not after ~150 chunk uploads.
 */
const preparedSubscribes = new Map<
  string,
  { ctx: PreparedSubscribe; meta: string; subscriberCommitment: bigint }
>();

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
  preparedSubscribes.clear();
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

function requirePool(token: PoolToken, denomination: number): PoolConfig {
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

/**
 * Decrypt the locally stored note blobs and return them as views. No RPC call is
 * made, so this returns in milliseconds and works offline.
 *
 * Every seed candidate is tried, active first, for the same reason the on-chain
 * scan does it: a note shielded before the wallet adopted a passphrase is a v1
 * note and only the legacy seed decrypts its blob.
 */
function handlePoolScanLocal(req: PoolScanLocalRequest): PoolScanLocalResponse {
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));
  const notes: PoolNoteView[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const blob of req.blobs ?? []) {
    let placed = false;
    for (const candidate of candidates) {
      let note: Record<string, unknown>;
      try {
        note = JSON.parse(new TextDecoder().decode(decryptNote(candidate.seed, blob)));
      } catch {
        continue; // not this seed's blob — try the next derivation
      }
      const poolStr = typeof note.pool === 'string' ? note.pool : null;
      const leafIndex = Number(note.leafIndex);
      const commitment = note.commitment === undefined ? null : String(note.commitment);
      if (!poolStr || !Number.isInteger(leafIndex) || leafIndex < 0 || !commitment) break;

      // Resolve the pool from its PDA rather than trusting the blob's own
      // denomination field: the blob is ours, but the pool table is the
      // authority on what a denomination means.
      const pool = ALL_POOLS_V3.find((p) => p.poolPDA.toBase58() === poolStr);
      if (!pool) break;

      const key = `${poolStr}:${leafIndex}`;
      if (seen.has(key)) { placed = true; break; }
      seen.add(key);

      notes.push({
        pool: poolStr,
        token: pool.token,
        denomination: pool.denomination,
        counter: Number(note.counter ?? 0),
        leafIndex,
        commitment,
        // NOT a claim. Nothing here has seen a nullifier PDA.
        spent: false,
        spentKnown: false,
        derivation: candidate.derivation,
      });
      placed = true;
      break;
    }
    if (!placed) skipped += 1;
  }

  notes.sort((a, b) => a.denomination - b.denomination || a.leafIndex - b.leafIndex);
  return { kind: 'poolScanLocal', notes, skipped };
}

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

/**
 * Find the caller's note at `leafIndex`, under whichever seed derivation owns
 * it, and hand back everything a spend needs.
 *
 * Extracted so the withdrawal and the subscribe run the SAME lookup rather than
 * two copies that drift. Both spend a note the same way, and the derivation
 * search below is the part that a copy would get subtly wrong.
 */
async function locateOwnedNote(
  req: { meta: string; token: PoolToken; denomination: number; leafIndex: number; encryptedNotes?: string[] },
  onProgress?: (step: string) => void,
): Promise<{
  conn: Connection;
  pool: PoolConfig;
  candidate: SeedCandidate;
  note: RecoveredNote;
  storedPath: StoredMerklePath | undefined;
  /** The pool's leaves as this RPC serves them. Returned rather than refetched
   *  because `poolExportNote` needs them to rebuild a Merkle path, and a second
   *  full history pull is the heaviest call on the path — see below. */
  commitments: Map<string, OnChainCommitment>;
}> {
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
  // Heartbeat while the history walk runs.
  //
  // `fetchPoolCommitments` is the heaviest RPC call on this path and it says
  // nothing for its whole duration. The main thread re-arms its request timeout
  // on every progress message, so a silent stretch longer than that timeout
  // kills a job that was working fine: measured on devnet 2026-08-05, a note
  // handoff died with "The private-payment worker timed out" while the walk was
  // still going. It also left the user watching one frozen sentence, unable to
  // tell work from a hang.
  //
  // Counting elapsed seconds is honest here: it is the one number we actually
  // know. Nothing else about this call is measurable from outside it.
  const walkStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - walkStartedAt) / 1000);
    onProgress?.(`Reading the pool's history from the RPC (${seconds}s)...`);
  }, 10_000);
  let commitments: Awaited<ReturnType<typeof fetchPoolCommitments>>;
  try {
    commitments = await fetchPoolCommitments(conn, pool.poolPDA);
  } finally {
    clearInterval(heartbeat);
  }
  let owner: { candidate: SeedCandidate; note: RecoveredNote } | null = null;
  for (const candidate of candidates) {
    const notes = await recoverNotes(conn, pool, candidate.seed, { commitments, onProgress });
    const hit = notes.find((n) => n.receipt.leafIndex === req.leafIndex);
    if (hit) {
      owner = { candidate, note: hit };
      break;
    }
  }

  // FALLBACK: a RECEIVED note. Its secrets came from the SENDER's seed, so the
  // derivation search above can never find it; what does know them is the blob
  // `poolImportNote` filed in the local store, which every spending caller
  // already passes in as `encryptedNotes`. Rebuilding the receipt from that
  // blob is what lets the EXISTING withdraw, subscribe and hand-over paths
  // spend a received note with no dedicated machinery: everything downstream
  // of this function is receipt-driven (`prepareUnshieldJob` proves from the
  // receipt; the seed it also takes only derives the withdrawal ephemeral,
  // which is correctly OURS, not the sender's).
  if (!owner) {
    const received = await receivedNoteFromBlobs(
      candidates,
      req.encryptedNotes,
      pool,
      req.leafIndex,
      commitments,
      conn,
    );
    // The ACTIVE candidate on purpose: it drives the ephemeral derivation and
    // the subscribe path's own-blob address, both of which belong to the
    // current derivation regardless of which seed decrypted the blob.
    if (received) owner = { candidate: candidates[0], note: received };
  }

  if (!owner) {
    throw new Error(
      `No note of yours found at leaf #${req.leafIndex} in the ${pool.denomination} ` +
        `${pool.token} pool. If it was just shielded, wait for the RPC to index it.`,
    );
  }
  const { candidate, note } = owner;
  if (note.spent) throw new Error('This note has already been withdrawn.');

  return {
    conn,
    pool,
    candidate,
    note,
    storedPath: extractStoredPath(candidate.seed, req.encryptedNotes, note.receipt.commitment),
    commitments,
  };
}

async function handlePoolUnshieldPrepare(
  req: PoolUnshieldPrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolUnshieldPrepareResponse> {
  const { conn, pool, candidate, note, storedPath } = await locateOwnedNote(req, onProgress);

  const ctx = await prepareUnshieldJob(
    note.receipt, pool, conn, candidate.seed, onProgress, storedPath,
  );
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

/**
 * Rebuild a RECEIVED note's full receipt from the local blob store, for the
 * `locateOwnedNote` fallback. Returns null when no stored blob describes an
 * intact note at (pool, leafIndex).
 *
 * A blob is trusted only after the same three checks a fresh import runs:
 * it decrypts under one of this identity's own seeds, its commitment
 * recomputes from its secrets (`shareableNoteToReceipt`; the stored shape is
 * a superset of `ShareableNote`, written by `poolShieldExecute` and
 * `handlePoolImportNote`), and, when this RPC still serves the leaf, the
 * commitment actually sits at the claimed leaf on chain. A commitment the RPC
 * no longer serves is NOT refused: the stored Merkle path can still carry the
 * withdrawal, and `prepareUnshieldJob`'s root-ring pre-flight is the guard
 * that no proof rent is burned on a wrong claim. The spent check mirrors what
 * `recoverNotes` does per note, so the caller's "already been withdrawn"
 * refusal applies to received notes exactly as to shielded ones.
 */
async function receivedNoteFromBlobs(
  candidates: SeedCandidate[],
  blobs: string[] | undefined,
  pool: PoolConfig,
  leafIndex: number,
  commitments: Map<string, OnChainCommitment>,
  conn: Connection,
): Promise<RecoveredNote | null> {
  for (const blob of blobs ?? []) {
    let parsed: ShareableNote | null = null;
    for (const candidate of candidates) {
      try {
        parsed = JSON.parse(
          new TextDecoder().decode(decryptNote(candidate.seed, blob)),
        ) as ShareableNote;
        break;
      } catch {
        // Not this derivation's blob. Try the next.
      }
    }
    if (!parsed) continue;
    if (parsed.pool !== pool.poolPDA.toBase58() || Number(parsed.leafIndex) !== leafIndex) {
      continue;
    }

    let receipt;
    try {
      receipt = shareableNoteToReceipt(parsed);
    } catch {
      // Corrupted or mismatched blob: skip it rather than block a good one.
      continue;
    }

    // When the RPC still serves this commitment, it must sit at the claimed
    // leaf; a blob pointing at somebody else's leaf would otherwise send the
    // prover after a membership it can never prove.
    const onChain = commitments.get(receipt.commitment.toString());
    if (onChain && onChain.leafIndex !== leafIndex) continue;

    const spent = await isNullifierSpent(
      conn,
      pool.poolPDA,
      receipt.nullifierPreimage,
      receipt.secret,
    );
    return { counter: leafIndex, spent, receipt: { ...receipt, source: 'received' } };
  }
  return null;
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
 * Densify a commitment map into the leaf array `buildMerkleProofFromLeavesV3`
 * expects, without a second trip to the RPC.
 *
 * This is `fetchPoolLeavesByIndex` (denominatedPool.ts:1300) minus its
 * `fetchPoolCommitments` call, because `locateOwnedNote` has already made
 * exactly that call with exactly the same default (`maxSignatures: 1000`).
 * Calling the exported helper here would double the heaviest RPC operation on
 * this path for no new information — and a Helius devnet 429 arrives as HTTP
 * 200 with a JSON-RPC -32429 body, so the second pull failing does not look
 * like a failure.
 *
 * The array is FILLED, never sparse: `buildMerkleProofFromLeavesV3` maps over
 * it, and `Array.prototype.map` preserves holes, so a hole would reach
 * `poseidonHash2` as `undefined`. `0n` is `ZERO_VALUE_V3`
 * (denominatedPool.ts:1063), the empty-leaf marker that function already
 * substitutes with `zeros[0]`.
 */
function leavesFromCommitments(commitments: Map<string, OnChainCommitment>): bigint[] {
  let maxIdx = -1;
  for (const e of commitments.values()) {
    if (e.leafIndex > maxIdx) maxIdx = e.leafIndex;
  }
  const leaves: bigint[] = maxIdx >= 0 ? new Array<bigint>(maxIdx + 1).fill(0n) : [];
  for (const e of commitments.values()) leaves[e.leafIndex] = e.commitment;
  return leaves;
}

/**
 * Encode + seal one owned note to a recipient's `p01pq:` address.
 *
 * NOTHING IS SENT. No transaction is built, signed or broadcast anywhere in
 * this function; the only chain access is the read `locateOwnedNote` performs
 * to find the note and prove it is unspent. That is the entire point of the
 * mechanism and also its main hazard, so both are handled explicitly:
 *
 *   - The note is NOT consumed. Its secrets are derived from THIS wallet's pool
 *     seed (`poolNotes.ts:recoverNotes` → `deriveNoteMaterial`), so the sender
 *     keeps the ability to withdraw it for as long as it is unspent. Sealing it
 *     to somebody else does not, and cannot, revoke that. The UI must say so;
 *     see SendForm.tsx.
 *   - The sealed blob is a BEARER instrument once opened. It is encrypted to
 *     the recipient, so the ciphertext is safe on any channel, but whoever ends
 *     up holding the plaintext can spend the note.
 *
 * Wire format is fixed by the only client that can currently open one of these:
 * `apps/extension/src/shared/store/denominatedPool.ts:449-470` decrypts the
 * blob and then does `JSON.parse(decode(plaintext))` straight into a
 * `ShareableNote`. So the plaintext is `JSON.stringify(ShareableNote)` — NOT
 * the base64 `encodeShareableNote` form — matching what the extension's own
 * transfer produces at `denominatedPool.ts:2161`. Changing the plaintext shape
 * here silently breaks every recipient.
 */
async function handlePoolExportNote(
  req: PoolExportNoteRequest,
  onProgress?: (step: string) => void,
): Promise<PoolExportNoteResponse> {
  // BEFORE any RPC work. A pool scan is minutes of history-walking on devnet,
  // and a typo in the address would otherwise be reported only after all of it
  // — at the one moment the user has stopped watching.
  if (!isNoteEncryptionAddress(req.recipientAddress)) {
    throw new Error(
      'That is not a Protocol 01 note address. It must start with "p01pq:" and is shown ' +
        'on the recipient\'s own Import note screen. Nothing was read or sent.',
    );
  }

  // Same lookup the withdrawal uses, so a note that can be withdrawn can be
  // handed over and vice versa — including the derivation search, which is what
  // keeps a pre-passphrase note exportable. It also refuses an already-spent
  // note, which matters more here than anywhere else: a sealed note that was
  // already withdrawn looks exactly like a good one to the recipient.
  const { pool, candidate, note, storedPath, commitments } = await locateOwnedNote(req, onProgress);

  // The Merkle path is what lets the recipient withdraw with no history rebuild.
  // Stored first: it is the exact witness the shield captured and was accepted
  // on chain. The rebuild is a fallback because it can only see the leaves this
  // RPC still serves, and a pruned history yields a root the pool never had.
  let merkleRoot: string | undefined;
  let merklePathElements: string[] | undefined;
  let merklePathIndices: number[] | undefined;
  let merklePath: PoolExportNoteResponse['merklePath'] = 'none';

  if (storedPath) {
    merkleRoot = storedPath.root;
    merklePathElements = storedPath.pathElements;
    merklePathIndices = storedPath.pathIndices;
    merklePath = 'stored';
  } else {
    try {
      onProgress?.('Building the Merkle path the recipient will withdraw with...');
      const built = buildMerkleProofFromLeavesV3({
        leavesByIndex: leavesFromCommitments(commitments),
        targetLeafIndex: note.receipt.leafIndex,
      });
      merkleRoot = built.root.toString();
      merklePathElements = built.pathElements.map((e) => e.toString());
      merklePathIndices = built.pathIndices;
      merklePath = 'rebuilt';
    } catch {
      // Leave the path off rather than ship a wrong one. The recipient then
      // rebuilds from history, which is slower but always correct.
      merklePath = 'none';
    }
  }

  const shareable: ShareableNote = {
    version: 1,
    pool: note.receipt.pool,
    secret: note.receipt.secret.toString(),
    nullifier_preimage: note.receipt.nullifierPreimage.toString(),
    // Wire key stays `deposit_epoch`; it carries `noteBlinding`. See ShareableNote.
    deposit_epoch: note.receipt.noteBlinding.toString(),
    token_mint: note.receipt.tokenMint.toString(),
    commitment: note.receipt.commitment.toString(),
    leafIndex: note.receipt.leafIndex,
    token: note.receipt.token,
    denominationHuman: note.receipt.denominationHuman,
    shieldedAt: note.receipt.shieldedAt,
    merkle_root: merkleRoot,
    merkle_path_elements: merklePathElements,
    merkle_path_indices: merklePathIndices,
  };

  onProgress?.('Sealing the note to the recipient (X25519 + ML-KEM-768)...');
  const sealedNote = encryptNote(
    req.recipientAddress,
    utf8ToBytes(JSON.stringify(shareable)),
  );

  return {
    kind: 'poolExportNote',
    sealedNote,
    denomination: pool.denomination,
    leafIndex: note.receipt.leafIndex,
    commitment: note.receipt.commitment.toString(),
    derivation: candidate.derivation,
    merklePath,
  };
}

/**
 * Decrypt + validate + re-encrypt one received sealed note. See
 * `PoolImportNoteRequest` for why every step of the chain lives in here.
 *
 * Order of operations is load-bearing:
 *   1. prefix check, before any cryptography, so a pasted wallet address or a
 *      `p01pq:` address (the classic mix-up) is named for what it is;
 *   2. decrypt under every seed derivation, active first, because the address
 *      the sender sealed to may have been published before a passphrase was
 *      adopted, and only the legacy seed opens those;
 *   3. `shareableNoteToReceipt`, the commitment-recomputation integrity guard;
 *   4. duplicate check against the stored blobs, so the same note cannot enter
 *      the store as two rows of apparent money;
 *   5. one nullifier read against the chain, BEST EFFORT: a note that is
 *      provably spent is refused (it looks exactly like a good one and is worth
 *      exactly nothing), but an RPC failure imports anyway and says the status
 *      is unverified, because losing the note over a 429 would be the worse
 *      outcome.
 */
async function handlePoolImportNote(
  req: PoolImportNoteRequest,
  onProgress?: (step: string) => void,
): Promise<PoolImportNoteResponse> {
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));

  const sealed = req.sealedNote.trim();
  if (!isEncryptedNoteBlob(sealed)) {
    throw new Error(
      'That is not a sealed note. A sealed note starts with "p01enc1:". ' +
        'Nothing was imported.',
    );
  }

  onProgress?.('Opening the sealed note...');
  let plaintext: Uint8Array | null = null;
  for (const candidate of candidates) {
    try {
      plaintext = decryptNote(candidate.seed, sealed);
      break;
    } catch {
      // Not this derivation's blob. Try the next.
    }
  }
  if (!plaintext) {
    throw new Error(
      'This note is not sealed to your address, so it cannot be opened here. ' +
        'Ask the sender to seal it to the address shown on this screen. Nothing was imported.',
    );
  }

  let shared: ShareableNote;
  try {
    shared = JSON.parse(new TextDecoder().decode(plaintext)) as ShareableNote;
  } catch {
    throw new Error('The sealed note opened, but what is inside is not a note.');
  }

  // The integrity guard: recomputes the commitment from the secrets and throws
  // on any mismatch, unknown pool or unsupported version. Do NOT bypass it.
  const receipt = shareableNoteToReceipt(shared);

  // Refuse a second row for the same note. `decryptOwnedBlob` runs the same
  // candidate search over the stored blobs, so a note imported before a
  // passphrase was adopted is still recognised as already present.
  const key = `${receipt.pool}:${receipt.leafIndex}`;
  for (const blob of req.encryptedNotes ?? []) {
    const own = decryptOwnedBlob(candidates, blob);
    if (own && `${own.pool}:${own.leafIndex}` === key) {
      throw new Error(
        'This note is already in your list. Importing it again would only draw the same money twice.',
      );
    }
  }

  // `shareableNoteToReceipt` already resolved the pool, so the lookup cannot
  // miss; it is repeated here only because the receipt carries the base58 form.
  const pool = ALL_POOLS_V3.find((p) => p.poolPDA.toBase58() === receipt.pool)!;

  let spent: boolean | null = null;
  try {
    onProgress?.('Checking the note against the chain...');
    spent = await isNullifierSpent(
      requireConnection(),
      pool.poolPDA,
      receipt.nullifierPreimage,
      receipt.secret,
    );
  } catch {
    // RPC hiccup: import anyway and report the status as unverified, exactly
    // like `poolScanLocal` does for the notes it paints.
  }
  if (spent === true) {
    throw new Error(
      'This note has already been withdrawn, so it is spent and worth nothing. ' +
        'Ask the sender for a fresh one. Nothing was imported.',
    );
  }

  // Same JSON shape `poolShieldExecute` writes, so every consumer of the store
  // treats this note like one of its own. The wire key `deposit_epoch` and the
  // `merklePath` sub-shape are both load-bearing for `extractStoredPath`.
  onProgress?.('Filing it with your notes...');
  const hasPath =
    !!shared.merkle_root &&
    Array.isArray(shared.merkle_path_elements) &&
    Array.isArray(shared.merkle_path_indices);
  const encryptedNote = encryptNote(
    createNoteEncryptionAddress(requireActiveSeed(req.meta)),
    utf8ToBytes(
      JSON.stringify({
        version: 1,
        pool: receipt.pool,
        secret: receipt.secret.toString(),
        nullifier_preimage: receipt.nullifierPreimage.toString(),
        deposit_epoch: receipt.noteBlinding.toString(),
        token_mint: receipt.tokenMint.toString(),
        commitment: receipt.commitment.toString(),
        leafIndex: receipt.leafIndex,
        ...(hasPath
          ? {
              merklePath: {
                pathElements: shared.merkle_path_elements!.map(String),
                pathIndices: shared.merkle_path_indices!.map(Number),
                root: String(shared.merkle_root),
              },
            }
          : {}),
        token: receipt.token,
        denominationHuman: receipt.denominationHuman,
        shieldedAt: receipt.shieldedAt,
        source: 'received',
      }),
    ),
  );

  return {
    kind: 'poolImportNote',
    encryptedNote,
    note: {
      pool: receipt.pool,
      token: receipt.token,
      denomination: receipt.denominationHuman,
      counter: 0,
      leafIndex: receipt.leafIndex,
      commitment: receipt.commitment.toString(),
      spent: false,
      // True only when the chain actually answered the nullifier read above.
      spentKnown: spent !== null,
      derivation: candidates[0].derivation,
    },
    merklePath: hasPath ? 'stored' : 'none',
  };
}

/** This identity's own note address. Public material; seed stays in here. */
function handlePoolNoteAddress(req: PoolNoteAddressRequest): PoolNoteAddressResponse {
  return {
    kind: 'poolNoteAddress',
    address: createNoteEncryptionAddress(requireActiveSeed(req.meta)),
  };
}

/**
 * WHERE THE TWO SECRET-DERIVED VALUES ARE COMPUTED, AND WHY THERE
 * ───────────────────────────────────────────────────────────────
 * `subscriber_commitment` — HERE, in prepare. It is the circuit-0
 * (`subscriber_ownership`) Poseidon commitment over the note secret and it seeds
 * the vault PDA, so it is the value that later lets the subscriber prove
 * ownership without naming a wallet. It depends on nothing but the secret, so it
 * CAN be computed this early — and it must be, because it is a wasm call and
 * every other wasm failure on this path (C1, C3) also lands in prepare, before
 * the wallet has moved a lamport. Computing it at execute time would turn a wasm
 * fault into ~150 wasted chunk uploads and a stranded float.
 *
 * The license key — in EXECUTE, not here. It is scoped by the service tag, and
 * the merchant is only chosen at execute time. Unlike the commitment it is a
 * pure HKDF over material already in memory, so it cannot fail and gains nothing
 * from being computed early.
 *
 * Neither value's input leaves the worker.
 */
async function handlePoolSubscribePrepare(
  req: PoolSubscribePrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolSubscribePrepareResponse> {
  const { conn, pool, candidate, note, storedPath } = await locateOwnedNote(req, onProgress);

  const ctx = await prepareSubscribeJob(
    note.receipt, pool, conn, candidate.seed, onProgress, storedPath,
  );

  // `compute_stark_commitment` returns the Goldilocks felt as a DECIMAL string
  // (stark/src/lib.rs:129-135). `goldilocksU64To32` then puts it in bytes 0..8
  // with 24 zeroes above, which is the exact 32 bytes the vault PDA is seeded on.
  onProgress?.('Computing your subscriber commitment...');
  const { starkProver } = await import('../pool/starkProver');
  await starkProver.start();
  const subscriberCommitment = BigInt(
    await starkProver.computeCommitment(note.receipt.secret.toString()),
  );

  preparedSubscribes.set(ctx.jobId, { ctx, meta: req.meta, subscriberCommitment });

  return {
    kind: 'poolSubscribePrepare',
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    requiredLamports: ctx.requiredLamports,
    denomination: pool.denomination,
    derivation: candidate.derivation,
  };
}

async function handlePoolSubscribeExecute(
  req: PoolSubscribeExecuteRequest,
  onProgress?: (step: string) => void,
): Promise<PoolSubscribeExecuteResponse> {
  const conn = requireConnection();
  const job = preparedSubscribes.get(req.jobId);
  if (!job) {
    throw new Error('Unknown subscription job — prepare it again (the worker was restarted).');
  }

  try {
    const retailer = new PublicKey(req.retailer);
    const serviceTag = licenseServiceTag(req.serviceId, retailer.toBase58());

    // Derived from the SAME master note secret the vault's subscriber_commitment
    // comes from, scoped by the service tag — so a merchant can check a presented
    // key against `blake3(licenseSecret)` with no shared secret anywhere, and the
    // user can reproduce the key on any device holding the note. The SECRET stays
    // here; only the encoded key and its blake3 leave this function.
    const licenseSecret = deriveLicenseSecret(job.ctx.receipt.secret, serviceTag);
    const licenseKey = encodeLicenseKey(licenseSecret);
    const licenseCommitmentBytes = licenseCommitment(licenseSecret);

    // Inert on-chain metadata; zeros unless the caller has something to put there.
    // See `SubscribeExecuteParams.vkHashSubscriber`.
    const vkHashSubscriber =
      req.vkHashSubscriber && req.vkHashSubscriber.length === 32
        ? Uint8Array.from(req.vkHashSubscriber)
        : new Uint8Array(32);

    const { txSig, vaultPDA } = await executeSubscribe(
      job.ctx,
      conn,
      {
        ownerPubkey: new PublicKey(req.ownerPubkey),
        retailer,
        rate: BigInt(req.rate),
        intervalSlots: BigInt(req.intervalSlots),
        subscriberCommitment: job.subscriberCommitment,
        vkHashSubscriber,
        licenseCommitment: licenseCommitmentBytes,
      },
      onProgress,
    );

    return {
      kind: 'poolSubscribeExecute',
      txSig,
      vaultPDA: vaultPDA.toBase58(),
      licenseKey,
      serviceTag,
      denomination: job.ctx.poolConfig.denomination,
    };
  } finally {
    preparedSubscribes.delete(req.jobId);
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

  if (prepared.size > 0 || preparedUnshields.size > 0 || preparedSubscribes.size > 0) {
    throw new Error('A shield, withdrawal or subscription is still in progress — finish it before recovering.');
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
// Local-note helpers (used by the two read-only resolution handlers below)
// ---------------------------------------------------------------------------

/** The blob fields the resolution handlers read. All written at shield time. */
interface OwnedBlobNote {
  pool: string;
  leafIndex: number;
  secret: bigint;
  nullifierPreimage: bigint;
}

/**
 * Decrypt one stored blob with every seed candidate, active first, the same
 * search `handlePoolScanLocal` does, for the same reason: a note shielded
 * before a passphrase was adopted only opens under the legacy seed. Returns
 * null for a blob this identity does not own or that lacks the needed fields.
 */
function decryptOwnedBlob(candidates: SeedCandidate[], blob: string): OwnedBlobNote | null {
  for (const candidate of candidates) {
    let note: Record<string, unknown>;
    try {
      note = JSON.parse(new TextDecoder().decode(decryptNote(candidate.seed, blob)));
    } catch {
      continue; // not this seed's blob, try the next derivation
    }
    try {
      const pool = typeof note.pool === 'string' ? note.pool : null;
      const leafIndex = Number(note.leafIndex);
      if (!pool || !Number.isInteger(leafIndex) || leafIndex < 0) return null;
      return {
        pool,
        leafIndex,
        secret: BigInt(String(note.secret)),
        nullifierPreimage: BigInt(String(note.nullifier_preimage)),
      };
    } catch {
      return null; // decrypted, but the shape is not a stored note
    }
  }
  return null;
}

/**
 * Resolve `spent` for the local notes against the chain: one nullifier-PDA
 * existence read per note. Read-only; see `PoolResolveSpentRequest`.
 *
 * A single note's failed read must not sink the rest: it lands in
 * `unresolved` and stays absent from the map, which callers treat as unknown.
 */
async function handlePoolResolveSpent(
  req: PoolResolveSpentRequest,
  onProgress?: (step: string) => void,
): Promise<PoolResolveSpentResponse> {
  const conn = requireConnection();
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));

  const spent: Record<string, boolean> = {};
  let checked = 0;
  let skipped = 0;
  let unresolved = 0;
  const seen = new Set<string>();

  for (const blob of req.blobs ?? []) {
    const note = decryptOwnedBlob(candidates, blob);
    if (!note) {
      skipped += 1;
      continue;
    }
    const key = `${note.pool}:${note.leafIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const pool = ALL_POOLS_V3.find((p) => p.poolPDA.toBase58() === note.pool);
    if (!pool) {
      skipped += 1;
      continue;
    }

    onProgress?.(`Checking note ${checked + unresolved + 1} against the chain...`);
    try {
      spent[key] = await isNullifierSpent(conn, pool.poolPDA, note.nullifierPreimage, note.secret);
      checked += 1;
    } catch {
      // RPC hiccup for this one note: report it unresolved rather than guess.
      unresolved += 1;
    }
  }

  return { kind: 'poolResolveSpent', spent, checked, skipped, unresolved };
}

/**
 * Re-derive a subscription's license key from the local note that paid for it.
 * Same derivation `handlePoolSubscribeExecute` performs at purchase time, on
 * the same secret, scoped by the same tag. See `PoolLicenseKeyRequest`.
 *
 * ⛔ The key must never be logged and never appear in an error message.
 */
function handlePoolLicenseKey(req: PoolLicenseKeyRequest): PoolLicenseKeyResponse {
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));

  for (const blob of req.blobs ?? []) {
    const note = decryptOwnedBlob(candidates, blob);
    if (!note || note.pool !== req.pool || note.leafIndex !== req.leafIndex) continue;

    const licenseKey = encodeLicenseKey(deriveLicenseSecret(note.secret, req.serviceTag));
    return { kind: 'poolLicenseKey', licenseKey, serviceTag: req.serviceTag };
  }

  throw new Error(
    'This browser does not hold the note that paid for this subscription, so the key ' +
      'cannot be re-derived here. Any device holding that note secret can.',
  );
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
    case 'poolScanLocal':
      return handlePoolScanLocal(req as PoolScanLocalRequest) as never;
    case 'poolScan':
      res = await handlePoolScan(req, onProgress);
      break;
    case 'poolShieldPrepare':
      res = await handlePoolShieldPrepare(req, onProgress);
      break;
    case 'poolShieldExecute':
      res = await handlePoolShieldExecute(req, onProgress);
      break;
    case 'poolExportNote':
      res = await handlePoolExportNote(req, onProgress);
      break;
    case 'poolImportNote':
      res = await handlePoolImportNote(req, onProgress);
      break;
    case 'poolNoteAddress':
      res = handlePoolNoteAddress(req);
      break;
    case 'poolRecover':
      res = await handlePoolRecover(req, onProgress);
      break;
    case 'poolSetPassphrase':
      res = handlePoolSetPassphrase(req);
      break;
    case 'poolResolveSpent':
      res = await handlePoolResolveSpent(req, onProgress);
      break;
    case 'poolLicenseKey':
      res = handlePoolLicenseKey(req);
      break;
    case 'poolSubscribePrepare':
      res = await handlePoolSubscribePrepare(req, onProgress);
      break;
    case 'poolSubscribeExecute':
      res = await handlePoolSubscribeExecute(req, onProgress);
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
