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
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  buildMerkleProofFromLeavesV3,
  bytesEqual,
  fetchPoolCommitments,
  findPoolV3,
  getPoolsForTokenV3,
  getPoolsToScanByDefault,
  type OnChainCommitment,
  type PoolConfig,
  fetchSpentNullifierSet,
  isNullifierSpent,
  isNullifierSpentInSet,
  readPoolUnspentCount,
  type PoolToken,
  type ShareableNote,
  shareableNoteToReceipt,
  ALL_POOLS_V3,
  depositBlockFor,
  PoolClosedToDepositsError,
} from '../pool/denominatedPool';
import {
  assertPassphraseAcceptable,
  derivePoolSeeds,
  normalizePassphrase,
  seedForDerivation,
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
import { recoverStuckFloat, refusalSentence, type SweepRefusal } from '../pool/recoverFloat';
import { createPacedFetch } from './pacedFetch';
import { usePollingConfirmation } from './pollingConfirm';
import {
  executeUnshield,
  executeUnshieldV4,
  prepareUnshieldJob,
  prepareUnshieldJobV4,
  executeUnshieldV4Relayed,
  type PreparedUnshield,
  type PreparedUnshieldV4,
} from '../pool/unshieldEphemeral';
import {
  executeShield,
  prepareShield,
  prepareContribution,
  type PreparedContribution,
  executeContribution,
  readTreeLeafCount,
  recordShieldBreadcrumb,
  type PreparedShield,
} from '../pool/shieldEphemeral';
import {
  executeSubscribe,
  executeSubscribeV4,
  prepareSubscribeJob,
  prepareSubscribeJobV4,
  type PreparedSubscribe,
  type PreparedSubscribeV4,
} from '../pool/subscribeEphemeral';
import {
  recoverSubscriptionVaults,
  type CandidateNoteSecret,
} from '../pool/subscriptionRecovery';
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
  /** Wallet that pre-funded the ephemeral. */
  ownerPubkey: string;
  /**
   * Where the ephemeral's residual goes.
   *
   * 🚨 NOT ALWAYS `ownerPubkey`, and assuming it was cost the whole point of
   * the relayed deposit. When the deployment funds the ephemeral, the residual
   * is the deployment's refundable rent, and sweeping it to the wallet both
   * takes money that is not the wallet's AND rebuilds the `ephemeral → wallet`
   * edge the relay exists to remove — the exact edge P9 walked on 2026-08-18.
   *
   * MEASURED 2026-08-18, 05:19:42: the payment leg relayed correctly and the
   * sweep still went home, because this field did not exist and the withdrawal
   * path was the only leg that had one.
   *
   * Omitted means `ownerPubkey`, which is right for a wallet-funded deposit.
   */
  sweepTo?: string;
}

/**
 * Deposit a leaf the TREASURY owns, and be owed a different one.
 *
 * \U0001f3af THE SAME FLOW THE BUYER ALREADY DOES, WITH ONE THING CHANGED. A
 * shield pays the till, the float arms an ephemeral, and the ephemeral deposits
 * a commitment derived from the BUYER's seed -- so the buyer spends the note
 * their own money created, and deposit and spend are the same object. MEASURED
 * 2026-08-31: a subscription spent leaf 93, deposited by the same person thirty
 * minutes earlier, while the treasury's leaf 21 sat untouched.
 *
 * A contribution changes only WHOSE commitment lands: the treasury's. The buyer
 * never learns its opening, so there is nothing for them to double-spend, and
 * they are paid in a note out of stock instead -- necessarily an OLDER one,
 * because `issue-note`'s maturity gate refuses a leaf deposited moments ago.
 * The gate is not a workaround here, it IS the mixing.
 *
 * Same payment, same clicks, one leaf in and one leaf out.
 */
export interface PoolContributePrepareRequest {
  kind: 'poolContributePrepare';
  /** Session key — the encoded meta returned by `deriveMeta`. */
  meta: string;
  token: PoolToken;
  denomination: number;
  /**
   * The commitment `/api/contribute-note` reserved, as a decimal string.
   *
   * \u26d4 THE CALLER DOES NOT GET TO CHOOSE IT. It is derived from the treasury
   * seed at the reserved index and only the commitment crosses the wire, never
   * the opening; a commitment is public the instant it is deposited.
   */
  commitment: string;
  /** The index the treasury reserved for that commitment. */
  leafIndex: number;
}

export interface PoolContributeExecuteRequest {
  kind: 'poolContributeExecute';
  jobId: string;
  /** Wallet that pre-funded the ephemeral. */
  ownerPubkey: string;
  /** Where the residual goes — the float on a relayed deposit. See the shield. */
  sweepTo?: string;
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
  /**
   * THE TWO FIELDS THAT PICK THE CIRCUIT. BOTH present routes this note through
   * circuit 7 (`prepareUnshieldJobV4`); NEITHER present is the unchanged C1+C3
   * path. There is no `version` field on the way IN on purpose — the router is
   * the DATA the circuit needs, so a caller cannot ask for v4 and then fail to
   * supply what v4 requires.
   *
   * Why the payee is an input here and not at execute time: `sha256(recipient)`
   * is four of circuit 7's six public inputs, so the proof is bound to ONE payee
   * before it is built. The v3 job does not know the payee at prepare time and
   * must not — its proof does not name one.
   *
   * ⛔ THE SUBSCRIBE PATH SENDS NEITHER, and that is load-bearing rather than
   * incidental: `poolSubscribePrepare` is a different request kind entirely, and
   * it carries its OWN circuit-7 fields — `retailer`, `rate`, `intervalSlots` —
   * which this handler never reads.
   *
   * 🚨 UPDATED 2026-08-27. This used to say "there is no
   * `subscribe_private_stark_v4` on chain". THERE NOW IS: it is registered at
   * `programs/zk_shielded/src/lib.rs:549` and reached through
   * `prepareSubscribeJobV4`. The conclusion is unchanged and the REASON is now
   * stronger, so do not restore the old sentence as though it still argued
   * anything. A subscription must not reach the v4 branch below because the two
   * v4 instructions bind DIFFERENT digests: the withdrawal binds
   * `sha256(recipient)`, while subscribe rebuilds a 132-byte
   * `"P01:C7:SUBSCRIBE:v1" || vault || rate || interval_slots || vk_hash ||
   * license` composite. A buffer minted here would fail the subscribe handler's
   * public-inputs-hash check at the END of a ~78-chunk upload. The domain tag is
   * that separation by construction, rather than by the accident that two
   * hashes are unlikely to collide.
   *
   * 🚨 EXACTLY ONE OF THE TWO IS REFUSED, and it did NOT used to be. It fell
   * through to the C1 + C3 pair silently, which republishes this note's
   * commitment in cleartext with nothing raised anywhere: the withdrawal still
   * lands, and the only symptom is a privacy claim that has stopped being true.
   * No caller legitimately holds one and not the other — the payee is a circuit
   * input and the wallet arms the payee refusal — so a request carrying one is a
   * programming error, and a programming error must not succeed by publishing
   * MORE than it was asked to. NEITHER field is still the v3 path, untouched,
   * and neither is what the subscribe path sends.
   */
  recipient?: string;
  /** The user's WALLET, base58. Identity only. Present with `recipient` it both
   *  selects circuit 7 and arms the payee refusal at PROVE time — ~5.5s and a
   *  real upload earlier than the v3 path can refuse it. */
  ownerPubkey?: string;
}

export interface PoolUnshieldExecuteRequest {
  kind: 'poolUnshieldExecute';
  jobId: string;
  /**
   * Address that receives the withdrawn funds.
   *
   * REQUIRED for a v3 job, which is why it is still sent by every caller today:
   * a C1+C3 proof names no payee, so this is the only place the payee exists.
   *
   * OPTIONAL for a v4 job, where the stored recipient wins because the proof is
   * bound to it. Passing one that DIFFERS throws — see `handlePoolUnshieldExecute`.
   *
   * 🚨 SEND IT ANYWAY ON v4, and `unshieldFromPool` does. It was briefly omitted
   * on the reasoning that "a matching one is redundant and a differing one is a
   * bug, so the only value that can never be wrong is none" — which is circular:
   * sending nothing is exactly what makes a differing payee invisible. It costs
   * nothing, it is checked against the job the worker actually stored, and it is
   * the only caller-side signal that a prepare was replaced in between.
   */
  recipient?: string;
  /** The user's WALLET. Identity only — see `sweepTo` for where money goes.
   *  `executeUnshield` refuses `recipient === ownerPubkey`, and that refusal is
   *  justified by this field meaning the wallet and nothing else. */
  ownerPubkey: string;
  /**
   * Hand the whole withdrawal to a relayer at this base URL instead of paying
   * for it from a pre-funded ephemeral.
   *
   * 🚨 THIS IS THE ONLY FIELD THAT CHANGES WHO APPEARS ON CHAIN. Present, the
   * buyer signs nothing and pays nothing: the relayer uploads the proof, submits
   * `unshield_denominated_stark_v4_relayed` and is reimbursed out of the
   * protocol fee the pool already charges. Absent, this is exactly the path it
   * has always been.
   *
   * ⚠️ v4 ONLY. A C1+C3 proof binds no payee, so a stranger submitting it could
   * re-point the payout — which is why v3 relaying needed a trusted operator and
   * this does not. Sending it on a v3 job is refused rather than ignored.
   *
   * ⚠️ No pre-fund is needed on this path, so `requiredLamports` from prepare
   * does not apply and nothing should be sent to the ephemeral.
   */
  relayerUrl?: string;
  /**
   * Base58 address that receives the residual rent, when it is not the wallet.
   *
   * Set by the page when a third party pre-funded the ephemeral. Omitted means
   * "sweep home", which is correct for a wallet-funded job and wrong for any
   * other kind — see `PoolSubscribeExecuteRequest.sweepTo` for why sweeping
   * home after someone else paid is worse than not using a funder at all.
   */
  sweepTo?: string;
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

  // -------------------------------------------------------------------------
  // THE TERMS. Present = prove on circuit 7; absent = prove on the C1 + C3 pair.
  //
  // 🚨 THEY ARE ON THE PREPARE BECAUSE THEY ARE PROOF INPUTS, NOT BECAUSE IT IS
  // TIDIER. `subscribe_private_stark_v4` binds
  // `sha256("P01:C7:SUBSCRIBE:v1" || vault || rate || interval_slots ||
  // vk_hash_subscriber || license)` into four of circuit 7's six public inputs.
  // A proof cannot exist before they are known, and one built against different
  // values is discovered wrong only as `InvalidProof`, after a ~78-chunk upload.
  //
  // They REMAIN on `PoolSubscribeExecuteRequest`, where the v3 path still reads
  // them and the v4 path only CHECKS them. Dropping them there would break the
  // C1 + C3 subscription, which names none of them until send time.
  // -------------------------------------------------------------------------

  /** Merchant who can claim each period. A vault seed, so it is in the digest. */
  retailer?: string;
  /** u64 decimal strings — the worker boundary carries JSON-safe primitives. */
  rate?: string;
  intervalSlots?: string;
  /**
   * Registry `serviceId` the license key is scoped to, exactly as on the execute
   * message. It reaches the digest INDIRECTLY: it selects the service tag, the
   * tag derives the license secret from the note secret, and `blake3` of that is
   * the 33-byte license slot. So it must be identical on both messages or the
   * digest moves.
   */
  serviceId?: string | null;
  /** 32 bytes of inert vault metadata. Defaults to zeros, as the extension does. */
  vkHashSubscriber?: number[];
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
  /** The user's wallet. Identity only — see `sweepTo` for where money goes. */
  ownerPubkey: string;
  /**
   * Base58 address that receives the residual rent, when it is not the wallet.
   *
   * Set by the page when a third party pre-funded the ephemeral. Omitted means
   * "sweep home", which is correct for a wallet-funded job and wrong for any
   * other kind — see `SubscribeExecuteParams.sweepTo` for why sweeping home
   * after someone else paid is worse than not using a funder at all.
   */
  sweepTo?: string;
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

/**
 * Hand the ACTIVE pool seed back to the page, as hex.
 *
 * ⛔ THIS IS THE MOST DANGEROUS REQUEST IN THIS FILE AND IT EXISTS FOR ONE JOB.
 * The seed is every note this identity will ever own: whoever holds it derives
 * every secret, every nullifier, every commitment, and can spend every note —
 * including ones not yet created. Nothing else in this worker returns it, and
 * the whole worker boundary exists to keep it here.
 *
 * It exists because a deployment that ISSUES notes needs its treasury's seed in
 * `P01_TREASURY_POOL_SEED`, and that seed is derivable only from a wallet
 * signature made in a browser. Without this the issuance path cannot be
 * configured at all, and the operator's alternative is worse: pasting a wallet
 * private key into a server, or hand-porting an HKDF chain and getting it
 * subtly wrong.
 *
 * `confirm` must be the exact string below. It is not security — a caller who
 * can post this message can post that string too — it is a guard against this
 * being reached by a refactor, an autocomplete, or a helpful abstraction that
 * "just forwards every request kind". A value that must be typed out is a value
 * somebody had to mean.
 */
export interface PoolExportSeedRequest {
  kind: 'poolExportSeed';
  meta: string;
  confirm: 'I am configuring a note-issuing treasury and accept that this seed can spend every note it derives';
}

export interface PoolExportSeedResponse {
  kind: 'poolExportSeed';
  /** 64 lowercase hex characters — the format `P01_TREASURY_POOL_SEED` expects. */
  seedHex: string;
  derivation: DerivationVersion;
  /** True when this identity also has a legacy seed. Notes shielded before a
   *  passphrase was adopted derive from THAT one, so a treasury configured with
   *  the active seed alone would fail to reproduce them — and the issuance
   *  route's on-chain check would refuse, which is the right failure but an
   *  opaque one without this flag. */
  hasLegacySeed: boolean;
}

/**
 * Register a SECOND pool identity from a signature, alongside the wallet's own.
 *
 * WHY A BUYER SHOULD NOT BE A WALLET
 * ──────────────────────────────────
 * Nothing about subscribing needs a browser wallet. A pool identity is 32 bytes;
 * the wallet was only ever there to do two jobs — produce a seed that is
 * recoverable without stored state, and sign the pre-fund. The funder does the
 * second one now, and the first is just "sign a string", which any wallet can do
 * for any string.
 *
 * So the buyer can be an identity this browser makes on the spot: it holds the
 * note, it spends it, and it is in no transaction because the funder pays. The
 * connected wallet never touches the chain, and there is no second Phantom, no
 * second profile, no second seed phrase to keep.
 *
 * 🚨 THE SIGNATURE MUST BE OVER A DIFFERENT MESSAGE, AND THAT IS THE WHOLE
 * DESIGN. Handing this the same signature the wallet's own identity uses would
 * make the two identities THE SAME KEYS — same notes, same addresses — which is
 * not an ephemeral buyer, it is the wallet under another name. Worse in this
 * app specifically: the issuing treasury may be that same wallet, so the note it
 * received would be one it deposited, and the self-deposit guard would refuse
 * it. A per-subscription message keeps them cryptographically unrelated while
 * staying deterministic, so the buyer identity is re-derivable from the wallet
 * forever with nothing stored.
 *
 * ⚠️ WHAT IS LOST IF THE MESSAGE IS NOT REPRODUCIBLE. The license key of a
 * subscription is derived from the note secret, and that secret lives only under
 * this identity. An identity built from randomness cannot be re-derived, so
 * losing the browser loses the proof of subscription. Callers must build the
 * message from values they can reconstruct — never from a random nonce they
 * throw away.
 */
export interface PoolDeriveIdentityRequest {
  kind: 'poolDeriveIdentity';
  /** Label for the new identity. Any string; scoped to this worker session. */
  meta: string;
  /** Signature bytes over the per-subscription message. */
  signature: number[];
}

export interface PoolDeriveIdentityResponse {
  kind: 'poolDeriveIdentity';
  meta: string;
  /** The `p01pq:` address a note is sealed to for this identity. */
  address: string;
}

export interface PoolRecoverRequest {
  kind: 'poolRecover';
  meta: string;
  token: PoolToken;
  denomination: number;
  /** The user's WALLET. One of the two addresses a sweep may land on. */
  ownerPubkey: string;
  /**
   * This deployment's funder address, when the page could learn it.
   *
   * Omitted means "no third-party money can be on these keys", which is the
   * pre-funder assumption and is only safe when it is TRUE. The page fetches it
   * from `/api/fund-ephemeral`; a network failure there omits it, and
   * `recoverStuckFloat` then sweeps as it always did. That is deliberate: a
   * deployment with no funder must not have its recoveries broken by a
   * defensive rule aimed at money that cannot exist there.
   */
  funderPubkey?: string;
  /**
   * The page could not establish whether this deployment has a funder.
   *
   * 🚨 DIFFERENT FROM omitting `funderPubkey`, and collapsing the two costs the
   * user their privacy. Omitted means "there is definitively no funder here", so
   * no third-party money can be on these keys and a sweep home is correct.
   * `funderUnknown` means the lookup failed — treasury money MIGHT be there, and
   * sweeping it home writes the wallet onto the ephemeral that signed a
   * subscription, which is `accountKeys[0]` of that subscription. One transient
   * fetch error was enough, and it fires on a Recover click: after the
   * verification run that said the operation was clean.
   */
  funderUnknown?: boolean;
  /**
   * Leaf indices of notes this browser holds.
   *
   * A withdrawal or subscribe derives its ephemeral from the leaf index of the
   * note being SPENT, and a spend advances no tree — so its stranded float sits
   * wherever that note sits, which for an old note is far below the head-relative
   * window `recoverFloat` scans. Without these, that float is invisible to
   * Recover and its ~1 SOL of buffer rent is unreachable by anything else,
   * because `CloseProofBuffer` is `close = authority`.
   */
  unshieldLeafIndices?: number[];
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
 * The opaque label this identity's local stores are indexed under.
 *
 * WHY IT EXISTS. Every local store used to be keyed by the WALLET PUBKEY in
 * cleartext, so possession of the store proved which wallet owned how many
 * notes in which pools — readable by any XSS, any extension with `storage`
 * permission, any disk forensic (leak L5). The label replaces that index: a
 * short HKDF leg of the pool seed, meaningless without the wallet signature.
 *
 * Derived from the V1 seed ON PURPOSE, not the active one: the v1 seed exists
 * for every identity (it IS the active seed until a passphrase is adopted, and
 * stays in the set as `legacy` afterwards), so the label survives passphrase
 * adoption. Deriving from the active seed would orphan every store the moment
 * a passphrase was armed.
 *
 * Public-ish material by construction — it sits in localStorage — and one-way:
 * HKDF output says nothing about the seed. Same class as the `p01pq:` address.
 */
export interface PoolStoreLabelRequest {
  kind: 'poolStoreLabel';
  meta: string;
}

export interface PoolStoreLabelResponse {
  kind: 'poolStoreLabel';
  /** 32 hex chars. Stable per identity, across sessions and passphrases. */
  label: string;
  /**
   * The `p01pq:` address of the SAME v1 seed the label comes from. Public-key
   * material, like every note address. The subscription store seals to THIS
   * address rather than the active one (see `lib/pay/subscriptions.ts`):
   * its records are the only pointer to vaults nothing can re-discover, so
   * they must stay openable across passphrase arm/disarm — which only the v1
   * seed guarantees, since it exists for every identity forever.
   */
  legacyAddress: string;
}

/** The payout-record fields that survive the whitelist in `poolOpenRecords`.
 *  Identical to `shieldClient.PayoutRecord`; all five are public values. */
export interface StoredPayoutRecord {
  pool: string;
  leafIndex: number;
  address: string;
  txSig: string;
  denomination: number;
}

/** The handoff-record fields that survive the whitelist. Identical to
 *  `lib/pay/handoffs.HandoffRecord`; all three are public values. */
export interface StoredHandoffRecord {
  pool: string;
  leafIndex: number;
  sealedAt: number;
}

/** The subscription-record fields that survive the whitelist. Identical to
 *  `lib/pay/subscriptions.StoredSubscription`; public values only — the
 *  license key never had a field here and must never gain one. */
export interface StoredSubscriptionWire {
  vaultPDA: string;
  retailer: string;
  serviceTag: string;
  serviceName?: string;
  token: string;
  denomination: number;
  rate: string;
  intervalSlots: string;
  openTxSig?: string;
  pool?: string;
  leafIndex?: number;
  openedAt: number;
}

/**
 * Open the sealed records of the local payout/spent stores (leak L5).
 *
 * The stores persist only `p01enc1:` ciphertext; decryption needs the pool
 * seed, which never leaves this worker, so the read has to happen here. What
 * crosses back is UI data the main thread legitimately holds anyway — payout
 * records and spent-note keys, all public values.
 *
 * ⛔ THIS IS NOT A DECRYPTION ORACLE, AND MUST NEVER BECOME ONE. The note
 * store's blobs decrypt under the same seeds and contain three spendable
 * secrets each; a handler that returned arbitrary decrypted plaintext would
 * hand those secrets to any same-origin script with a live session, destroying
 * the exact boundary this worker exists to hold. So a blob only comes back if
 * its plaintext carries the `p01store: 1` envelope AND matches a whitelisted
 * record kind, and even then only the whitelisted fields are copied out.
 * A note blob (no envelope, has `secret`) is counted in `skipped` and nothing
 * of it crosses.
 */
export interface PoolOpenRecordsRequest {
  kind: 'poolOpenRecords';
  meta: string;
  /** `p01enc1:` blobs from the local record stores. Untrusted: each must open
   *  under one of this identity's seeds and carry the record envelope. */
  blobs: string[];
}

/**
 * 🚨 PRESENCE IS THE VERSION SIGNAL. Every per-kind array below is REQUIRED and
 * `handlePoolOpenRecords` initializes all of them unconditionally, so a worker
 * that knows a kind always sends it — `[]` when there are no records. A page
 * newer than its worker (tab open across a deploy) uses the ABSENCE of an array
 * to tell "this worker predates the kind" apart from "there are none", which is
 * what keeps a version skew from painting the user's lists empty after the v1
 * stores have migrated away (`sealedStore.SealedRecordsAnswer` holds the page
 * side of this contract). A new record kind MUST follow the same rule: add its
 * array as required, initialize it unconditionally, never make it optional.
 */
export interface PoolOpenRecordsResponse {
  kind: 'poolOpenRecords';
  payouts: StoredPayoutRecord[];
  /** `"<poolPDA>:<leafIndex>"` spent-note keys. */
  spentKeys: string[];
  /** Notes this browser handed over (`lib/pay/handoffs.ts`). */
  handoffs: StoredHandoffRecord[];
  /** Subscriptions this browser tracks (`lib/pay/subscriptions.ts`). */
  subscriptions: StoredSubscriptionWire[];
  /** Blobs that opened under no seed, or whose plaintext is not a record. */
  skipped: number;
}

/**
 * Recover this identity's subscription vaults from the chain (#11), so the
 * local subscription store is a cache rather than the only pointer to a vault.
 *
 * The matching needs note secrets (derived from the pool seeds, or read out of
 * the caller's encrypted blobs for RECEIVED notes), so it runs in here; the
 * scan itself is `lib/privacy/pool/subscriptionRecovery.ts`, whose header
 * carries the leak analysis. The short version: ONE program-wide
 * `getProgramAccounts` enumeration that is identical for every user, matched
 * locally — NEVER a per-note `getAccountInfo(vaultPDA)` probe, which would be
 * leak L4 in a new costume (see `fetchSpentNullifierSet`).
 *
 * Read-only: no transaction, nothing written, nothing retained.
 */
export interface PoolRecoverSubscriptionsRequest {
  kind: 'poolRecoverSubscriptions';
  meta: string;
  /** Encrypted note blobs from local storage, same contract as `poolScanLocal`.
   *  Optional, but a received note's secrets exist ONLY in its blob, so a
   *  subscription paid with one is unrecoverable without them. */
  blobs?: string[];
}

/** The recovered-subscription fields that cross back to the page. Public
 *  values only, whitelist-copied like every record in `poolOpenRecords`: the
 *  note SECRET that matched stays in here, and the license key keeps having
 *  no field anywhere. */
export interface RecoveredSubscriptionWire {
  vaultPDA: string;
  retailer: string;
  /** Base58; `NATIVE_SOL_MINT_BASE58` for SOL vaults. The page joins the
   *  registry on (retailer, mint) to resolve the serviceTag. */
  tokenMint: string;
  token: string;
  denomination: number;
  rate: string;
  intervalSlots: string;
  /** The note that paid — pool + leaf index, which is all
   *  `deriveSubscriptionLicenseKey` needs to re-derive the license key. */
  pool: string;
  leafIndex: number;
}

export interface PoolRecoverSubscriptionsResponse {
  kind: 'poolRecoverSubscriptions';
  subscriptions: RecoveredSubscriptionWire[];
  /** Vault accounts the program-wide enumeration returned — everyone's. */
  vaultsScanned: number;
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
  | PoolDeriveIdentityRequest
  | PoolExportNoteRequest
  | PoolExportSeedRequest
  | PoolImportNoteRequest
  | PoolLicenseKeyRequest
  | PoolNoteAddressRequest
  | PoolOpenRecordsRequest
  | PoolRecoverRequest
  | PoolRecoverSubscriptionsRequest
  | PoolResolveSpentRequest
  | PoolStoreLabelRequest
  | PoolShieldPrepareRequest
  | PoolContributePrepareRequest
  | PoolContributeExecuteRequest
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
  /**
   * How much of `requiredLamports` is the user's own VALUE rather than float:
   * the denomination plus the 0.3% shield fee, neither of which comes back.
   *
   * 🚨 It exists so the deposit's refusal to use the funder is STRUCTURAL rather
   * than an omission. A deposit routed through `fundEphemeralForJob` with this
   * set can never reach the treasury, and the reason is carried to the user
   * instead of the funder simply never being asked. Without it, wiring the
   * deposit leg to the funder is a one-line mistake that looks like consistency
   * — and it would mean the deployment buying the user's note.
   */
  valueLamports: number;
  denomination: number;
  counter: number;
}

export interface PoolContributePrepareResponse {
  kind: 'poolContributePrepare';
  jobId: string;
  /** Base58 — the main thread funds THIS address, then calls execute. */
  ephemeralPubkey: string;
  requiredLamports: number;
  /** The denomination plus the shield fee: the part that does not come back. */
  valueLamports: number;
  denomination: number;
  /** The reserved index, echoed so the caller can confirm against it. */
  leafIndex: number;
}

export interface PoolContributeExecuteResponse {
  kind: 'poolContributeExecute';
  txSig: string;
  leafIndex: number;
  commitment: string;
  /**
   * \u26d4 NO `encryptedNote`, AND THAT IS THE POINT. The shield's twin returns a
   * note blob because the buyer owns what it deposited. Here they do not: the
   * opening belongs to the treasury, and handing back anything shaped like a
   * receipt would be handing over a note that cannot be spent.
   */
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
  /**
   * Notes still unspent, from `DenominatedPoolV3.note_count`. **This is the
   * anonymity set, and `totalNotes` is not.** A withdrawn note hides nobody.
   * Measured 2026-08-12: 34 leaves / 8 unspent in the 0.1 SOL pool, 25 / 6 in
   * the 1 SOL pool — quoting leaves would overstate the set by over 4x.
   */
  unspentNotes: number;
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
  /**
   * Whether every pass has run. The scan is two-phase: the blinded single-hash
   * pass identifies current-scheme notes in milliseconds and is emitted as an
   * INTERIM response (`complete: false`) so the page can paint immediately; the
   * legacy epoch search — ~41 s of pure hashing per derivation on the measured
   * pools, the only way a pre-blinding note can be found — then runs and the
   * terminal response carries `complete: true`. A consumer of an incomplete
   * response must say the list is still being checked for older notes, and must
   * never present it as the full picture: on this product a hidden note reads
   * as lost money.
   */
  complete: boolean;
}

export interface PoolUnshieldPrepareResponse {
  kind: 'poolUnshieldPrepare';
  jobId: string;
  ephemeralPubkey: string;
  requiredLamports: number;
  denomination: number;
  /** Seed derivation the note was found under, resolved in the worker. */
  derivation: DerivationVersion;
  /**
   * WHICH CIRCUIT ACTUALLY PROVED THIS JOB — told, never guessed.
   *
   * The caller could infer it from the `jobId` prefix (`unshield:` vs
   * `unshield-v4:`), and that is exactly why this field exists: an inference off
   * a string is one rename away from silently reporting v4 for a v3 spend, and
   * the two differ in whether the note's commitment is published in cleartext.
   * A page that shows the user a privacy claim must read this, not the id.
   *
   * ⛔ `'v4'` means the COMMITMENT is off the wire. It does NOT mean unlinkable:
   * the pre-fund transfer still names the wallet, and so do the RPC routes
   * recorded in the 2026-08-25 session note. Do not upgrade the disclosure copy
   * on the strength of this field alone.
   */
  version: 'v3' | 'v4';
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
  /**
   * Who paid for the DEPOSIT that created the note about to be spent, base58.
   *
   * 🚨 THE ONE FACT THAT DECIDES WHETHER ANY OF THE REST IS WORTH ANYTHING.
   * Spending republishes the deposit's commitment in cleartext, so a stranger
   * walks spend → commitment → deposit in one hop and lands on this address. If
   * it is the wallet doing the spending, routing the spend through a funder
   * buys NOTHING — the wallet is still one hop away, through the deposit.
   *
   * Costs no RPC call: the pool scan already fetches every insert transaction
   * to read its event log, and this is `accountKeys[0]` of what it holds.
   *
   * `null` when the leaf was not found in the scanned window or its transaction
   * carried no readable header. Callers must treat `null` as UNKNOWN, never as
   * safe — an unread channel reported clean is the failure this whole effort
   * exists to refuse.
   */
  depositPayer: string | null;
  /**
   * Who funded that payer — the address one hop behind the deposit.
   *
   * 🚨 THIS, NOT `depositPayer`, IS WHAT A CALLER MUST COMPARE THE WALLET
   * AGAINST. A deposit is signed by a fresh ephemeral, so `depositPayer` is
   * always a key nobody has heard of and never equals the wallet — a guard
   * built on it cannot fire in the case it exists for. The human is one
   * transfer behind: an ephemeral cannot pay a fee from nothing.
   *
   * `null` = could not be established. UNKNOWN, never safe.
   */
  depositFunder: string | null;
  /** The deposit's signature, so a caller can show or verify the claim. */
  depositSignature: string | null;
  /**
   * Which circuit the prepared job proved on. REPORTED, never guessed: a caller
   * that asked for circuit 7 can be answered with the C1 + C3 pair when the
   * rebuild could not place the note, and it must be able to say so on screen
   * rather than claim a privacy property the transaction does not have.
   */
  version: 'v3' | 'v4';
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
  /** Total lamports swept to the WALLET. */
  lamports: number;
  /**
   * Total lamports returned to the deployment's funder, because it — and not
   * the wallet — paid for the crashed job. Reported separately because it is
   * not money the user gets back, and a single total would say it was.
   */
  repaidToFunder: number;
  closedBuffers: number;
  keys: number;
  /**
   * Ephemerals that held a balance and were deliberately NOT swept, because
   * who funded them could not be established safely.
   *
   * 🚨 The caller MUST surface these. Nothing is lost — every key here is
   * re-derivable from the seed forever, and its proof buffer was still closed —
   * but a Recover that silently leaves ~1 SOL behind and reports success reads
   * as "there was nothing to recover", which is the one reading that stops the
   * user from ever coming back for it.
   */
  refused: Array<{
    ephemeral: string;
    leafIndex: number;
    lamports: number;
    reason: SweepRefusal;
    /** Human sentence, already written — render it rather than re-deriving one. */
    sentence: string;
    sources: string[];
  }>;
}

export type PoolResponse =
  | PoolDeriveIdentityResponse
  | PoolExportNoteResponse
  | PoolExportSeedResponse
  | PoolImportNoteResponse
  | PoolLicenseKeyResponse
  | PoolNoteAddressResponse
  | PoolOpenRecordsResponse
  | PoolRecoverResponse
  | PoolRecoverSubscriptionsResponse
  | PoolResolveSpentResponse
  | PoolStoreLabelResponse
  | PoolShieldPrepareResponse
  | PoolContributePrepareResponse
  | PoolContributeExecuteResponse
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

/**
 * In-flight withdrawals, awaiting their pre-fund.
 *
 * A DISCRIMINATED UNION, not a widened record. The two contexts are not
 * interchangeable — a `PreparedUnshieldV4` carries the payee that circuit 7 was
 * proved against and a `PreparedUnshield` has no payee at all — so the execute
 * handler must know which it holds before it can decide whether the caller is
 * even allowed to name one. Tagging it here rather than sniffing `'recipient' in
 * ctx` at execute time is deliberate: a structural test would answer "v4" for
 * any future v3 context that happens to grow the field.
 *
 * ⛔ SAME LIFETIME, SAME SCOPE AS BEFORE. Still one map, still keyed by job id,
 * still cleared by `clearPoolState` and deleted in the execute handler's
 * `finally`. The jobIds cannot collide across VERSIONS — `prepareUnshieldJobV4`
 * prefixes `unshield-v4:` where `prepareUnshieldJob` prefixes `unshield:` — but
 * nothing here depends on that, because the tag is stored, not parsed.
 *
 * 💰 THEY COULD COLLIDE WITHIN v4, AND THAT WAS A FUND-LOSS BUG. The id
 * `prepareUnshieldJobV4` returns is `unshield-v4:<pool>:<leaf>`
 * (unshieldEphemeral.ts:445) — it names no payee — while the job it identifies
 * is BOUND to one. Two prepares of the same note for two payees therefore landed
 * on one key and the second replaced the first: proof, context and payee
 * together. The ephemeral does not vary with the payee either (it is
 * deterministic in pool seed, pool and leaf), so the first caller's pre-fund sat
 * on exactly the signer the second caller's proof would spend from, and
 * executing the FIRST job id paid the SECOND payee with no error anywhere. The
 * v3 path was never exposed to this: its payee travels on the execute message,
 * so an overwritten v3 context still pays the address the caller named.
 *
 * So `handlePoolUnshieldPrepare` QUALIFIES the v4 key with the payee. The v3 key
 * is left alone — a v3 prepare does not know a payee, and qualifying it would
 * key the map on `undefined` and make every v3 job collide with every other.
 */
type PreparedUnshieldJob =
  | { version: 'v3'; ctx: PreparedUnshield; meta: string }
  | { version: 'v4'; ctx: PreparedUnshieldV4; meta: string };

const preparedUnshields = new Map<string, PreparedUnshieldJob>();

/**
 * In-flight subscriptions, awaiting their pre-fund.
 *
 * `subscriberCommitment` is carried here rather than recomputed at execute time:
 * it is a wasm call, and a wasm failure must land in PREPARE, before the wallet
 * has moved the float, not after ~150 chunk uploads.
 *
 * A DISCRIMINATED UNION, not a widened record, for the same reason
 * `preparedUnshields` is one. The two contexts are not interchangeable: a
 * `PreparedSubscribeV4` carries the TERMS circuit 7 was proved against, and a
 * `PreparedSubscribe` carries none of them — so the execute handler must know
 * which it holds before it can decide whether the caller is allowed to name any.
 * Tagging it here rather than sniffing `'binding' in ctx` at execute time is
 * deliberate: a structural test would answer "v4" for any future v3 context that
 * happens to grow the field.
 *
 * 💰 THE v4 KEY IS QUALIFIED BY THE VAULT, AND THAT IS A FUND-LOSS FIX.
 * `prepareSubscribeJobV4` returns `subscribe-v4:<pool>:<leaf>:<vault>` while the
 * v3 job returns `subscribe:<pool>:<leaf>`, which names no terms at all. Two v4
 * prepares of the same note for two different retailers would otherwise collide
 * on one key and the second would replace the first — and the ephemeral is
 * deterministic in (seed, pool, leaf), so the first caller's pre-fund would sit
 * on exactly the signer the second caller's proof spends from. Executing the
 * first job id would open the second caller's vault, with no error anywhere.
 * This is the same shape already paid for once on the v4 withdrawal.
 *
 * The v3 key is left alone: a v3 prepare does not know a vault, and qualifying
 * it would key the map on `undefined` and make every v3 job collide with every
 * other one.
 *
 * `licenseSecret` is carried on the v4 side because the license commitment is
 * INSIDE the digest, so it has to be derived at prepare — and the same bytes
 * must reach the encoder at send time. The v3 side derives it at execute, which
 * is still correct there because nothing binds it.
 */
type PreparedSubscribeJob =
  | { version: 'v3'; ctx: PreparedSubscribe; meta: string; subscriberCommitment: bigint }
  | {
      version: 'v4';
      ctx: PreparedSubscribeV4;
      meta: string;
      subscriberCommitment: bigint;
      /** The 16-byte HKDF leg. Never leaves this worker; only its encoding does. */
      licenseSecret: Uint8Array;
      serviceTag: string;
    };

const preparedSubscribes = new Map<string, PreparedSubscribeJob>();

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

/**
 * Resolve a pool, or say which denominations exist.
 *
 * ⛔ NEVER REFUSE A CLOSED POOL HERE. This is shared by scan, unshield,
 * subscribe and recover — every exit. The 0.1 SOL pool is closed to new
 * deposits and held 10 unspent notes (1.0 SOL) on 2026-08-20; a closure check
 * in this function would strand them. The deposit refusal lives in
 * `handlePoolShieldPrepare`, which is the only caller that opens the entrance.
 */
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

/**
 * Two-phase scan, so the page paints in the time the FAST pass takes.
 *
 * Phase 1 walks every pool once (history + spent markers, the RPC cost that
 * exists either way) and matches notes with the blinded single hash — one
 * `createCommitmentV3` per leaf per derivation, milliseconds of CPU. Each
 * pool's cumulative result is pushed through `onInterim` with
 * `complete: false` the moment it exists.
 *
 * Phase 2 is the legacy epoch search: MEASURED 2026-08-12 at 0.1158 ms per
 * hash, a 6000-epoch window for every leaf the blinded pass did not claim —
 * 41 s per derivation on the 59-leaf pools, 82 s with a passphrase. That used
 * to run before anything was shown; now it runs after the paint, reusing the
 * phase-1 fetches so it costs zero additional RPC, and only its terminal
 * response says `complete: true`.
 *
 * ⛔ Phase 2 is not optional and not skippable per leaf. Whether a foreign-
 * looking leaf is actually a pre-blinding note of ours is EXACTLY what the
 * epoch search decides; there is a known unspent legacy note at leaf 30 of
 * the 0.1 SOL pool, and an "optimisation" that can hide a note is worse than
 * the delay it removes.
 */
async function handlePoolScan(
  req: PoolScanRequest,
  onProgress?: (step: string) => void,
  onInterim?: (partial: PoolScanResponse) => void,
): Promise<PoolScanResponse> {
  const conn = requireConnection();
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));
  // A named denomination is honoured exactly as before — 0.1 included, which is
  // closed to deposits and stays fully readable that way. Only the DEFAULT
  // narrows. ⚠️ That default now omits 53 unspent notes; see
  // DEFAULT_SCAN_DENOMINATIONS for the measurement and the decision behind it.
  const pools = req.denomination !== undefined
    ? [requirePool(req.token, req.denomination)]
    : getPoolsToScanByDefault(req.token);

  const notes: PoolNoteView[] = [];
  const poolSizes: PoolSizeView[] = [];
  let shieldedBalance = 0;

  /** Everything phase 2 needs, saved from phase 1 so nothing is refetched. */
  const scanned: {
    pool: PoolConfig;
    commitments: Map<string, OnChainCommitment>;
    spentSet: ReadonlySet<string>;
    seenLeaves: Set<number>;
  }[] = [];

  const emitInterim = () =>
    // Snapshots, not references: the arrays keep growing after the message is
    // posted, and an interim that mutates under its consumer is a lie in slow
    // motion.
    onInterim?.({
      kind: 'poolScan',
      notes: [...notes],
      shieldedBalance,
      poolSizes: [...poolSizes],
      complete: false,
    });

  // ── Phase 1: RPC reads + blinded single-hash matching, per pool ──────────
  for (const pool of pools) {
    onProgress?.(`Scanning the ${pool.denomination} ${pool.token} pool...`);
    const commitments = await fetchPoolCommitments(conn, pool.poolPDA);
    poolSizes.push({
      denomination: pool.denomination,
      totalNotes: await readTreeLeafCount(conn, pool),
      unspentNotes: await readPoolUnspentCount(conn, pool.poolPDA),
      discoverableNotes: commitments.size,
    });

    // Every derivation this identity holds, not just the active one — a wallet
    // that adopted a passphrase still owns everything it shielded before, and a
    // note that stops appearing in the balance is a note the user believes is
    // gone. The commitment map AND the spent set are fetched once and reused
    // across derivations — both are pool-wide, derivation-independent reads,
    // and recoverNotes would otherwise re-issue the identical
    // getProgramAccounts per derivation.
    //
    // Honest sizing for the spent-set half: measured 2026-08-12 on Helius
    // devnet at 95-242 ms per call against a scan floor of ~60 s, so the
    // redundant refetch cost
    // ~2.5-5% of a scan — hoisted because it is free and because
    // `handlePoolResolveSpent` already memoizes this exact call per pool, NOT
    // because anyone could feel the difference.
    onProgress?.(`Reading spent markers for the ${pool.denomination} ${pool.token} pool...`);
    const spentSet = await fetchSpentNullifierSet(conn, pool.poolPDA);
    const seenLeaves = new Set<number>();
    for (const candidate of candidates) {
      const { notes: found } = await scanPoolForSeed(conn, pool, candidate.seed, {
        commitments,
        spentSet,
        blindedOnly: true,
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
    scanned.push({ pool, commitments, spentSet, seenLeaves });
    emitInterim();
  }

  // ── Phase 2: the legacy epoch search, per pool, reusing phase-1 reads ────
  // The full pass re-runs the blinded hash per leaf too (one hash, free); the
  // `seenLeaves` dedupe keeps phase-1 notes from being counted twice, so what
  // this loop APPENDS is exactly the legacy notes.
  for (const { pool, commitments, spentSet, seenLeaves } of scanned) {
    onProgress?.(`Checking the ${pool.denomination} ${pool.token} pool for older notes...`);
    for (const candidate of candidates) {
      const { notes: found } = await scanPoolForSeed(conn, pool, candidate.seed, {
        commitments,
        spentSet,
        onProgress,
      });
      for (const n of found) {
        if (seenLeaves.has(n.receipt.leafIndex)) continue;
        seenLeaves.add(n.receipt.leafIndex);
        notes.push(toNoteView(n, candidate.derivation));
        if (!n.spent) shieldedBalance += pool.denomination;
      }
    }
    emitInterim();
  }

  return { kind: 'poolScan', notes, shieldedBalance, poolSizes, complete: true };
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
  const pool = requirePool(req.token, req.denomination);

  // 🚨 THE ENTRANCE GATE, AND IT LIVES HERE ON PURPOSE.
  //
  // Every deposit — the panel, a script, the live devnet harness, any future
  // client — reaches the chain through this handler, so this is the only place
  // a refusal is a guarantee rather than a label. A previous round put the same
  // flag behind a React chip: the flag existed, one view honoured it, and the
  // engine was fail-OPEN for everyone else.
  //
  // FIRST, before the seed is touched, the tree is read or the ~2-minute C6
  // proof starts. A refusal that arrives after the proof is a refusal the user
  // paid for in time and in buffer rent.
  const blocked = depositBlockFor(pool);
  if (blocked) throw new PoolClosedToDepositsError(blocked);

  // Active seed only: a new note is always created under the current derivation.
  const seed = requireActiveSeed(req.meta);

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
    valueLamports: ctx.valueLamports,
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
      // The residual's destination, which is not always the wallet — see
      // `sweepTo` on the request type. A relayed deposit's residual is the
      // deployment's own rent coming back.
      new PublicKey(req.sweepTo ?? req.ownerPubkey),
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
 * Prove the insert for a commitment the TREASURY owns, and price the pre-fund.
 *
 * Deliberately the same shape as `handlePoolShieldPrepare`, in the same order,
 * for the same reasons: the deposit block is checked FIRST, before the tree is
 * read or the ~2-minute proof starts, because a refusal that arrives after the
 * proof is one the user paid for in time and in buffer rent.
 *
 * \u26d4 IT DOES NOT TOUCH THE SEED FOR THE NOTE. `prepareContribution` takes the
 * commitment ready-made and the seed only to derive the throwaway ephemeral, so
 * there is no path here that could accidentally mint a note for the buyer.
 */
async function handlePoolContributePrepare(
  req: PoolContributePrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolContributePrepareResponse> {
  const conn = requireConnection();
  const pool = requirePool(req.token, req.denomination);

  const blocked = depositBlockFor(pool);
  if (blocked) throw new PoolClosedToDepositsError(blocked);

  const seed = requireActiveSeed(req.meta);

  let commitment: bigint;
  try {
    commitment = BigInt(req.commitment);
  } catch {
    throw new Error('The reserved commitment is not a field element.');
  }

  const ctx = await prepareContribution(pool, conn, seed, commitment, req.leafIndex, onProgress);

  // Same breadcrumb discipline as the shield: written before the caller funds
  // anything, so a crash between the pre-fund and execute still leaves a record
  // pointing at a re-derivable key.
  await recordShieldBreadcrumb(ctx as unknown as Parameters<typeof recordShieldBreadcrumb>[0]);

  prepared.set(ctx.jobId, {
    ctx: ctx as unknown as PreparedShield,
    meta: req.meta,
    counter: ctx.leafIndex,
  });

  return {
    kind: 'poolContributePrepare',
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    requiredLamports: ctx.requiredLamports,
    valueLamports: ctx.valueLamports,
    denomination: pool.denomination,
    leafIndex: ctx.leafIndex,
  };
}

/**
 * Run the contribution. The caller must already have funded the ephemeral.
 *
 * \u26d4 RETURNS NO NOTE BLOB. The shield's twin encrypts a receipt to the
 * buyer's own address because the buyer owns what it deposited. Here they do
 * not, and a blob shaped like a receipt would be a note that cannot be spent.
 * What the buyer is owed arrives as a CLAIM, minted by `/api/contribute-note`
 * once this leaf is confirmed on chain, and redeemed for a different and older
 * note out of stock.
 */
async function handlePoolContributeExecute(
  req: PoolContributeExecuteRequest,
  onProgress?: (step: string) => void,
): Promise<PoolContributeExecuteResponse> {
  const conn = requireConnection();
  const job = prepared.get(req.jobId);
  if (!job) {
    throw new Error('Unknown contribution job — prepare it again (the worker was restarted).');
  }
  try {
    const done = await executeContribution(
      job.ctx as unknown as PreparedContribution,
      conn,
      new PublicKey(req.sweepTo ?? req.ownerPubkey),
      onProgress,
    );
    return {
      kind: 'poolContributeExecute',
      txSig: done.txSig,
      leafIndex: done.leafIndex,
      commitment: done.commitment,
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
/**
 * ⛔ EXPORTED FOR ONE CALLER: the live devnet v4 harness
 * (`lib/privacy/pool/liveDevnetUnshieldV4.test.ts`). Not part of the worker
 * protocol and not for app code, which must go through `handlePoolRequest`.
 *
 * The v4 spend needs a `ShieldReceipt` before it can prove anything, because
 * circuit 7 binds sha256(recipient) into the transcript and the recipient is
 * therefore a PREPARE input. The worker protocol still takes the recipient at
 * EXECUTE, which is the v3 shape; until that moves, a harness that wants to
 * exercise the real v4 path has to resolve the note itself rather than invent
 * one. An invented receipt would prove nothing: its commitment would not be a
 * leaf on chain.
 */
export async function locateOwnedNote(
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
    onProgress?.(`Still looking — ${seconds}s so far. Keep this tab open.`);
  }, 10_000);
  try {
  // ⚠️ THE HEARTBEAT COVERS THE WHOLE SEARCH, NOT JUST THE HISTORY FETCH.
  //
  // It used to be cleared the moment `fetchPoolCommitments` returned, and
  // everything after it — the spent-nullifier read, and the derivation search
  // whose legacy pass hashes ~6000 candidate epochs per derivation — ran in
  // silence. The main thread re-arms its request timeout on every progress
  // message, so a silent stretch longer than that timeout kills a job that is
  // working fine. MEASURED tonight: "The private-payment worker timed out"
  // after four minutes on a run that had not failed at anything.
  //
  // Cleared in the caller's `finally` below instead, so no path leaves the
  // interval running.
  let commitments: Awaited<ReturnType<typeof fetchPoolCommitments>>;
  commitments = await fetchPoolCommitments(conn, pool.poolPDA);
  // Pool-wide and derivation-independent, like `commitments` above, so it is
  // fetched once and shared across the candidate loop for the same reason.
  const spentSet = await fetchSpentNullifierSet(conn, pool.poolPDA);

  // ONE leaf, two passes — the caller already picked the note by leaf index,
  // so probing any other leaf is waste, and the waste was the demo-stalling
  // kind: without `onlyLeaf` each derivation ran the 6000-epoch legacy search
  // on every foreign leaf in the pool, MEASURED at ~41 s per derivation on the
  // 59-leaf pools (2026-08-13) — spent between the click on Withdraw and
  // anything happening. Probing one leaf makes that one blinded hash per
  // derivation for a current-scheme note, and at most one 6000-epoch window
  // (~0.7 s) per derivation for a legacy one.
  //
  // The blinded pass runs across ALL derivations before any legacy search
  // starts, for the same reason handlePoolScan phases its work: a v1 note's
  // blinded hash hits on the legacy seed immediately, and running the active
  // seed's epoch search first would put ~0.7 s of dead hashing in front of it.
  let owner: { candidate: SeedCandidate; note: RecoveredNote } | null = null;

  // 🚨 THE BLOB IS CONSULTED FIRST, AND IT USED TO BE CONSULTED LAST.
  //
  // A RECEIVED note's secrets come from the SENDER's seed, so the derivation
  // search below can never find it — it has to fail COMPLETELY, across every
  // derivation and both passes, before the fallback runs. That is the most
  // expensive possible ordering for the one case that already knows the answer:
  // the local blob names the leaf outright.
  //
  // MEASURED tonight on a real run: over four minutes on "Finding your note",
  // then "The private-payment worker timed out" — because the legacy epoch
  // search is silent (~41 s per derivation on a 59-leaf pool, and the main
  // thread re-arms its request timeout only on progress messages).
  //
  // Trying the blob first costs one decryption attempt per stored blob and
  // makes an issued or handed-over note resolve immediately. It cannot mask a
  // seed-owned note: `receivedNoteFromBlobs` matches on the requested leaf and
  // validates the commitment against the chain, so a blob that is not this note
  // simply does not match and the search below still runs.
  onProgress?.('Checking notes you already hold...');
  {
    const received = await receivedNoteFromBlobs(
      candidates,
      req.encryptedNotes,
      pool,
      req.leafIndex,
      commitments,
      conn,
    );
    if (received) owner = { candidate: candidates[0], note: received };
  }

  if (!owner) {
    for (const blindedOnly of [true, false] as const) {
      for (const candidate of candidates) {
        const notes = await recoverNotes(conn, pool, candidate.seed, {
          commitments,
          spentSet,
          onlyLeaf: req.leafIndex,
          blindedOnly,
          onProgress,
        });
        const hit = notes.find((n) => n.receipt.leafIndex === req.leafIndex);
        if (hit) {
          owner = { candidate, note: hit };
          break;
        }
      }
      if (owner) break;
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
  } finally {
    // Every exit, including both throws above. An interval left running in a
    // worker keeps emitting progress for a job that is over.
    clearInterval(heartbeat);
  }
}

/**
 * Failures of the circuit-7 REBUILD that the C1 + C3 prepare can still answer,
 * and therefore the only ones `handlePoolUnshieldPrepare` routes around.
 *
 * ⛔ AN ALLOW-LIST, NOT A DENY-LIST, and that is the whole safety property.
 * Anything unrecognised is rethrown, so a new failure mode fails CLOSED —
 * loudly, on circuit 7 — rather than quietly finding its way onto the path
 * that republishes the note's commitment. A prover that cannot produce a
 * circuit-7 trace is a bug to surface, not to route around; a Merkle path the
 * rebuild could not place in the pool's root ring is a note the stored path may
 * still spend.
 *
 * Both strings are produced by `prepareUnshieldV4` in denominatedPool.ts and are
 * pinned there by an anti-vacuity assertion in `poolHandlersUnshieldV4.test.ts`:
 * reword one and the fallback silently stops firing, and every behavioural test
 * would still pass, because they inject the message themselves.
 *
 * ⛔ FOUR PRODUCERS NOW, NOT TWO, and this predicate is deliberately shared
 * between the withdrawal and the subscription rather than copied. The circuit-7
 * SUBSCRIBE path emits the identical two needles from
 * `prepareSubscribeV4` (the root pre-flight and the depth check, in
 * subscribePrivateStarkV4.ts) and from `prepareSubscribeJobV4`'s
 * epoch-blinding refusal (subscribeEphemeral.ts). One list is what keeps the two
 * fallbacks from drifting apart; a second copy would go stale on the first
 * reword and the note would stop being spendable on the surface that missed it.
 * Both are pinned by anti-vacuity assertions in `subscribeV4Job.test.ts`.
 */
const V4_REBUILD_FAILURES = ['PRE-FLIGHT FAIL', 'circuit 7 needs at least'] as const;

function isV4RebuildFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return V4_REBUILD_FAILURES.some((needle) => msg.includes(needle));
}

/**
 * Prove and price ONE withdrawal, on whichever circuit the request supplies the
 * inputs for.
 *
 * THE ROUTE IS PER REQUEST, NOT A MIGRATION. `unshield_denominated_stark_v3`
 * stays registered on chain indefinitely: a note whose blinding is unknown can
 * be spent nowhere else, and `prepareUnshieldV4` has no stored-path fast path,
 * so a note whose root has aged out of the pool's 100-root ring still needs the
 * v3 rebuild. Neither is legacy.
 *
 * ⛔ THE SUBSCRIBE PATH CANNOT REACH THE v4 BRANCH, and here is the proof rather
 * than the assurance. TWO independent facts, each checkable without running
 * anything:
 *
 *   1. It is a DIFFERENT REQUEST KIND. `subscribeEphemeral.ts` and
 *      `subscribePrivateStark.ts` are reached only from
 *      `handlePoolSubscribePrepare`, dispatched on `'poolSubscribePrepare'`.
 *      This function is dispatched on `'poolUnshieldPrepare'`. The `switch` in
 *      `handlePoolRequest` is exhaustive (`const _exhaustive: never`), so the
 *      two cases cannot both run for one message. MEASURED, not assumed:
 *      rerouting the subscribe case into this handler turns the smuggle test in
 *      `poolHandlersUnshieldV4.test.ts` red.
 *   2. `prepareSubscribeJob` calls `prepareUnshieldJob` ITSELF
 *      (subscribeEphemeral.ts:52,115); it never calls this handler. Nothing in
 *      this file is on its path.
 *
 * 🚨 RETRACTED, 2026-08-26. A third fact was written here: that
 * `PoolSubscribePrepareRequest` has no `recipient` and no `ownerPubkey` field,
 * so `tsc` refuses a subscribe request carrying either. IT DOES NOT. Measured in a scratch
 * file inside this package's tsconfig: a FRESH OBJECT LITERAL of kind
 * `poolSubscribePrepare` carrying both fields, passed to `handlePoolRequest`,
 * raised nothing — while a deliberate type error in the same file DID raise,
 * proving tsc had the file in the program. The cause is that `handlePoolRequest`
 * is `<R extends PoolRequest>(req: R, …)`: excess-property checking does not
 * apply when the contextual type is a bare type parameter, and the constraint
 * check is plain assignability, which two extra string fields satisfy. The
 * subscription is still safe — 1 and 2 both hold, and 1 is measured by mutation
 * — but it is safe for two reasons, not three, and a decorative guard is worse
 * than no guard when the next reader leans on it.
 *
 * That matters because there is no `subscribe_private_stark_v4` on chain —
 * `programs/zk_shielded/src/lib.rs` exposes exactly one v4, the withdrawal — so
 * a subscription proved on circuit 7 would fail at the very end of a ~150-tx
 * upload, in the flow the 2026-09-04 demo is entirely about.
 */
async function handlePoolUnshieldPrepare(
  req: PoolUnshieldPrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolUnshieldPrepareResponse> {
  // BOTH, OR NEITHER — checked BEFORE the note is located, because a
  // malformed request should not cost an event scan first. The payee is a
  // circuit-7 input and the wallet arms the payee refusal, so one without the
  // other is not a smaller request: it is a caller that meant circuit 7 and
  // dropped a field. Answering it with the C1 + C3 pair republishes this note's
  // commitment in cleartext and reports nothing, which is the exact failure the
  // pair exists to remove. See the hazard note on
  // `PoolUnshieldPrepareRequest.recipient`.
  if ((req.recipient === undefined) !== (req.ownerPubkey === undefined)) {
    const missing = req.recipient === undefined ? 'recipient' : 'ownerPubkey';
    throw new Error(
      'A circuit-7 withdrawal needs both `recipient` and `ownerPubkey` on the prepare, and ' +
        `this request is missing \`${missing}\`. Send both to prove on circuit 7, or neither ` +
        'to prove on the C1 + C3 pair. The half-specified request used to fall through to ' +
        "C1 + C3 silently, which republishes this note's commitment in cleartext.",
    );
  }

  const { conn, pool, candidate, note, storedPath } = await locateOwnedNote(req, onProgress);

  if (req.recipient !== undefined && req.ownerPubkey !== undefined) {
    // `prepareUnshieldJobV4` is referenced ONLY inside this branch, and the
    // reason is smaller than it first looked — recorded because the bigger
    // reason was written here first and then MEASURED FALSE.
    //
    // Five suites mock `../pool/unshieldEphemeral` with a factory returning the
    // v3 pair alone (poolHandlersDerivation, poolImportNote, poolExportNote,
    // poolDepositsClosed, poolScanProgressive). vitest's factory mocks throw on
    // reading an export the factory omitted, so hoisting this to a `const fn =
    // cond ? a : b` looked like it would take all five red for a branch they
    // never enter. Probed 2026-08-26 by adding an unconditional
    // `void prepareUnshieldJobV4;` at the top of this function and running those
    // five files: 66 passed, 0 failed. It does not fire. Whatever vite's SSR
    // transform emits for that read, the proxy does not see it as a miss.
    //
    // So this is shape, not necessity: the call that needs the export sits in
    // the branch that needs the export. Do not restore the stronger claim.
    let v4: PreparedUnshieldV4 | null = null;
    try {
      v4 = await prepareUnshieldJobV4(
        note.receipt,
        new PublicKey(req.recipient),
        new PublicKey(req.ownerPubkey),
        pool,
        conn,
        candidate.seed,
        onProgress,
        // The note's own witness, the same value the v3 branch below has always
        // been handed. Passing it is what stops a stored-path note falling back
        // to the pair that republishes its commitment.
        storedPath,
      );
    } catch (err) {
      // ⛔ FALL BACK, OR THIS NOTE CANNOT BE WITHDRAWN FROM THE WEB APP AT ALL.
      // `unshieldFromPool` types both fields as required and sends them on every
      // withdrawal, so this branch is the ONLY route apps/web still has to the
      // C1 + C3 pair. Without the fallback, the v3 branch below is dead code in
      // production and a note circuit 7 cannot prove stops being spendable from
      // this client — while `spendRouting.test.ts` and four comments in this
      // tree state that v3 stays reachable indefinitely.
      //
      // The asymmetry between the two prepares is real and runs one way:
      // `prepareUnshieldJob` tries the Merkle path captured when the note was
      // shielded and rebuilds from history only if that path has aged out
      // (unshieldEphemeral.ts:163-172); `prepareUnshieldV4` has no stored-path
      // route at all and always rebuilds.
      //
      // Nothing has been spent at this point, which is what makes the retry
      // free: `prepareUnshieldV4` refuses before it proves and long before it
      // uploads — its own message says "Aborting before proof rent is spent" —
      // so the second attempt costs one event scan and no rent. The v3 rebuild
      // pre-flights the root too (denominatedPool.ts:2132), so a note neither
      // can place gets the same refusal from the other side rather than a doomed
      // upload.
      if (!isV4RebuildFailure(err)) throw err;
      console.warn(
        '[pool/unshield] circuit 7 could not prove this note; falling back to the C1 + C3 ' +
          'pair, which publishes the note commitment:',
        err instanceof Error ? err.message : String(err),
      );
      onProgress?.('Circuit 7 cannot prove this note — falling back to the C1 + C3 pair...');
    }

    if (v4) {
      // 💰 KEYED BY (JOB, PAYEE), NOT BY JOB. `v4.jobId` is
      // `unshield-v4:<pool>:<leaf>` and names no payee, while the job is bound
      // to one — see the note on `preparedUnshields` for the fund-loss that
      // caused. The prefix survives so job ids stay readable by eye in logs.
      const jobId = `${v4.jobId}:${v4.recipient.toBase58()}`;
      preparedUnshields.set(jobId, { version: 'v4', ctx: v4, meta: req.meta });

      return {
        kind: 'poolUnshieldPrepare',
        jobId,
        ephemeralPubkey: v4.ephemeral.publicKey.toBase58(),
        // Materially smaller than the v3 figure and that is the circuit, not a
        // saving: C1 and C3 are held open together so the v3 float is their sum,
        // and circuit 7 has nothing to pair with. Reported, never assumed —
        // `prepareUnshieldJobV4` prices its one buffer against the RPC.
        requiredLamports: v4.requiredLamports,
        denomination: pool.denomination,
        derivation: candidate.derivation,
        version: 'v4',
      };
    }
  }

  // ── The v3 path. Byte for byte what it was before circuit 7 existed, except
  // for the `version` tag the caller is now told instead of guessing — and it is
  // reached two ways now: a request that named no payee at all, and a circuit-7
  // request whose rebuild could not produce a usable Merkle path.
  const ctx = await prepareUnshieldJob(
    note.receipt, pool, conn, candidate.seed, onProgress, storedPath,
  );
  preparedUnshields.set(ctx.jobId, { version: 'v3', ctx, meta: req.meta });

  return {
    kind: 'poolUnshieldPrepare',
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    requiredLamports: ctx.requiredLamports,
    denomination: pool.denomination,
    derivation: candidate.derivation,
    version: 'v3',
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

    // Sanctioned single-note lookup: this runs inside the withdrawal flow, on the
    // one note about to be spent, so its nullifier is published on chain moments
    // later and the RPC learns nothing it is not about to see anyway. Every
    // caller that runs on page load or over a LIST of unspent notes uses
    // `fetchSpentNullifierSet` instead — see its header.
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

/**
 * Finish a prepared withdrawal.
 *
 * WHO OWNS THE PAYEE DIFFERS BY CIRCUIT, and that is the whole reason this
 * handler branches:
 *
 *   v3   the proof names no payee, so the payee arrives HERE and is required.
 *   v4   `sha256(recipient)` is four of circuit 7's six public inputs. The payee
 *        was fixed at prove time; the stored one wins.
 *
 * A v4 job handed a DIFFERENT recipient throws instead of quietly preferring
 * one. Both choices "work" on chain — `unshieldDenominatedStarkV4` would refuse
 * the mismatch itself, at the end of the upload — but a caller that names payee
 * B for a proof bound to payee A is confused about who it is paying, and the two
 * silent options are a wrong receipt shown to the user or ~150 transactions of
 * rent burned to reach the same answer. Refusing here costs nothing and says so.
 *
 * ⚠️ WHAT A REFUSAL COSTS, SAID OUT LOUD. Every throw in here happens AFTER the
 * wallet's pre-fund has landed on the ephemeral, and the `finally` drops the job
 * — the same rule the v3 handler has always had: an execute attempt consumes its
 * job. So a refused execute leaves the pre-fund sitting on the ephemeral with no
 * sweep. That float is NOT lost: the ephemeral is deterministic in (pool seed,
 * pool, leaf) and `poolRecover` sweeps exactly this, which is also why the throw
 * stays inside the `try` rather than keeping the job alive — a retained job makes
 * `handlePoolRecover` refuse ("still in progress") and locks the user out of the
 * one path that returns the money.
 */
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
    if (job.version === 'v4') {
      // Compare BASE58, not PublicKey identity: `new PublicKey(x).equals(y)` is
      // the same comparison but throws on a malformed string before it can be
      // reported as a mismatch, and a caller sending garbage should hear that it
      // sent garbage. Skipped entirely when no recipient is passed — that is the
      // normal v4 call, not an omission to warn about.
      if (req.recipient !== undefined && req.recipient !== job.ctx.recipient.toBase58()) {
        throw new Error(
          `This withdrawal was proved for ${job.ctx.recipient.toBase58()} and cannot pay ` +
            `${req.recipient}. Circuit 7 binds the payee into the proof, so the payee cannot ` +
            'be changed after preparing — prepare the withdrawal again for the payee you want. ' +
            'Nothing was sent; the pre-fund is still on the withdrawal signer and Recover funds ' +
            'returns it.',
        );
      }
      if (req.relayerUrl) {
        const relayed = await executeUnshieldV4Relayed(
          job.ctx,
          conn,
          req.relayerUrl,
          onProgress,
        );
        return {
          kind: 'poolUnshieldExecute',
          txSig: relayed.txSig,
          denomination: job.ctx.poolConfig.denomination,
        };
      }

      const { txSig } = await executeUnshieldV4(
        job.ctx,
        conn,
        new PublicKey(req.ownerPubkey),
        onProgress,
        req.sweepTo ? new PublicKey(req.sweepTo) : undefined,
      );
      return {
        kind: 'poolUnshieldExecute',
        txSig,
        denomination: job.ctx.poolConfig.denomination,
      };
    }

    // ⛔ A v3 job cannot be relayed, and saying so beats ignoring the field.
    // The C1+C3 pair binds no payee, so a stranger holding that proof can point
    // the payout anywhere — the defect v4 closed and the reason v3 relaying
    // required a trusted operator.
    if (req.relayerUrl) {
      throw new Error(
        'This withdrawal was proved on the C1 + C3 pair, which binds no payee, so it ' +
          'cannot be handed to a relayer — a stranger holding it could re-point the ' +
          'payout. Prepare it on circuit 7 (send both `recipient` and `ownerPubkey`).',
      );
    }

    // v3, unchanged: the payee exists nowhere but this message, so its absence
    // is a caller bug and not a default to invent. Guessing one — the wallet, a
    // derived address — is how `owner` reached `recipient` in PoolPanel.tsx:125
    // and shipped the wallet as the pool payee until 2026-08-04.
    if (req.recipient === undefined) {
      throw new Error(
        'This withdrawal was proved on the C1 + C3 pair, which names no payee, so a recipient ' +
          'must be supplied to send it.',
      );
    }
    const { txSig } = await executeUnshield(
      job.ctx,
      conn,
      new PublicKey(req.recipient),
      new PublicKey(req.ownerPubkey),
      onProgress,
      req.sweepTo ? new PublicKey(req.sweepTo) : undefined,
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
    // Pool-wide read, not a lookup of this note's nullifier PDA. An import is
    // nowhere near a spend, so asking the RPC about this specific nullifier
    // would hand it a secret identifier months before it is published.
    spent = isNullifierSpentInSet(
      await fetchSpentNullifierSet(requireConnection(), pool.poolPDA),
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
/**
 * Who put the lamports on `payer` — one hop, from the oldest end of its life.
 *
 * WHY THIS HOP IS THE WHOLE POINT. A pool deposit is signed by a fresh
 * ephemeral, so the deposit transaction names a key nobody has ever heard of.
 * The address that matters is one transfer behind it: an ephemeral cannot pay a
 * fee from nothing, and whoever funded it is the human. Probe P9 walks exactly
 * this, and a client that decides "was this my own deposit?" without walking it
 * is asking a question it cannot answer.
 *
 * Reads the OLDEST transactions of the payer's life, because that is where a
 * funding transfer is: the key is created by being funded. Bounded to one small
 * page — this runs on the subscribe path and must not turn into a history walk.
 *
 * Returns null when nothing can be established. Callers must treat null as
 * UNKNOWN and never as safe: an unfunded-looking payer is far more likely to be
 * a pruned history than a key that materialised with lamports.
 */
/**
 * How far back to look for the payer's first transaction. A shield ephemeral
 * lives ~158 signatures; 1000 clears that with room and is the same ceiling
 * `recoverFloat` uses for the same walk. An address busier than this returns
 * null rather than a guess.
 */
const FUNDER_SIGNATURE_LIMIT = 1000;
/** How many of the oldest to actually fetch. The funding transfer is the first. */
const FUNDER_OLDEST_SAMPLE = 5;
/**
 * How far the source's loss may sit from the payer's gain and still be called
 * the source: the difference is that transaction's fee. Generous next to any
 * real transfer, and far tighter than the 5000-lamport fee that used to win.
 */
const FUNDER_AMOUNT_TOLERANCE_LAMPORTS = 1_000_000;

export async function resolveFunderOfPayer(
  conn: Connection,
  payer: string,
): Promise<string | null> {
  try {
    const key = new PublicKey(payer);
    // 🚨 THE PAGE HAS TO REACH THE PAYER'S FIRST TRANSACTION, AND `limit: 50`
    // DID NOT.
    //
    // `getSignaturesForAddress` returns the NEWEST first, so reversing a page of
    // 50 reaches the oldest of the newest 50 — the true beginning only when the
    // address has lived 50 signatures or fewer. A shield ephemeral signs ~150
    // proof-chunk uploads before it does anything else (see the header of
    // `handlePoolShieldExecute`), so the five entries examined were uploads from
    // the MIDDLE of its life, in which it only ever pays fees. `gained <= 0`
    // skipped all five and the function fell through to `null` — for every note
    // this client has ever deposited, treasury-issued ones included.
    //
    // MEASURED 2026-08-18: a subscription refused its own freshly issued note
    // because of this, and the refusal read as "you deposited this yourself".
    const sigs = await conn.getSignaturesForAddress(key, { limit: FUNDER_SIGNATURE_LIMIT });
    if (sigs.length === 0) return null;
    // Oldest last in the response, so the tail is the start of the key's life.
    // Nothing else is worth reading: a funding transfer is how the key comes
    // into existence, and `recoverFloat` records the same shape.
    const oldestFirst = [...sigs].reverse().slice(0, FUNDER_OLDEST_SAMPLE);
    for (const s of oldestFirst) {
      if (s.err) continue;
      const tx = await conn.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const idx = keys.indexOf(payer);
      if (idx < 0) continue;
      const gained = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
      if (gained <= 0) continue;
      // Balance deltas rather than decoded instructions, for the reason
      // `recoverFloat` documents: a transfer can arrive as `transfer`, as
      // `createAccount`, or through a CPI naming none of them, and the runtime's
      // own numbers see all three.
      //
      // ⛔ NOT "the first account that lost lamports". `accountKeys[0]` IS the
      // fee payer and its delta is always negative, so that rule returned the
      // fee payer every time and never the source of the value — right only by
      // luck, because every funding transfer this repo writes happens to set
      // `feePayer == source`. The same luck probe P6 was recorded as relying on.
      //
      // This matters more than it looks: paired with the widened page above, the
      // old rule would start returning a CONFIDENT WRONG address instead of
      // null. The wallet comparison in `shieldClient` would then measure the
      // wrong thing and let a genuinely self-deposited note through — turning a
      // guard that fails closed into one that fails silently open.
      let best: { addr: string; miss: number } | null = null;
      for (let i = 0; i < keys.length; i++) {
        if (i === idx) continue;
        const delta = (tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0);
        if (delta >= 0) continue;
        // The source loses what the payer gained, plus whatever fee it paid.
        const miss = Math.abs(-delta - gained);
        if (miss > FUNDER_AMOUNT_TOLERANCE_LAMPORTS) continue;
        if (!best || miss < best.miss) best = { addr: keys[i]!, miss };
      }
      if (best) return best.addr;
    }
  } catch {
    // Unknown, which the caller must not read as safe.
  }
  return null;
}

/**
 * The circuit-0 (`subscriber_ownership`) commitment over the note secret, as the
 * Goldilocks felt the vault PDA is seeded on.
 *
 * ⚠️ THE LAST SILENT STRETCH ON THIS PATH, AND IT IS NOT A SHORT ONE. Importing
 * the prover pulls its whole bundle and `start()` boots a nested worker; only
 * then does the commitment get computed. The main thread re-arms its 180s
 * request watchdog on every progress message, so this stretch either finishes
 * inside 180s or the job is killed for being quiet while it is working.
 *
 * That failure mode has already been paid for twice on this path, in
 * `locateOwnedNote`: same watchdog, same cause, same useless "worker timed out"
 * shown to someone whose run had not failed at anything. The heartbeat is the
 * fix that stuck. Counting elapsed seconds is honest — it is the only number
 * this step exposes from outside.
 *
 * Shared by both routes so there is ONE copy: on the v4 route it must run BEFORE
 * proving (the vault PDA is seeded on it and the vault is in the circuit-7
 * digest), and on the v3 route it runs after, exactly where it always did.
 */
async function computeSubscriberCommitment(
  noteSecret: bigint,
  onProgress?: (step: string) => void,
): Promise<bigint> {
  onProgress?.('Computing your subscriber commitment...');
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    onProgress?.(`Computing your subscriber commitment — ${seconds}s so far...`);
  }, 10_000);
  try {
    const { starkProver } = await import('../pool/starkProver');
    await starkProver.start();
    // `compute_stark_commitment` returns the Goldilocks felt as a DECIMAL string
    // (stark/src/lib.rs:129-135). `goldilocksU64To32` then puts it in bytes 0..8
    // with 24 zeroes above, which is the exact 32 bytes the vault PDA is seeded
    // on.
    return BigInt(await starkProver.computeCommitment(noteSecret.toString()));
  } finally {
    clearInterval(heartbeat);
  }
}

async function handlePoolSubscribePrepare(
  req: PoolSubscribePrepareRequest,
  onProgress?: (step: string) => void,
): Promise<PoolSubscribePrepareResponse> {
  const { conn, pool, candidate, note, storedPath, commitments } = await locateOwnedNote(
    req,
    onProgress,
  );

  // Who deposited the note we are about to spend. Looked up by the note's own
  // commitment, which is the SAME value the spend will republish in cleartext —
  // so this is exactly the address a stranger reaches in one hop from the
  // subscription. Free: `commitments` is already in hand from the scan.
  const origin = commitments.get(note.receipt.commitment.toString()) ?? null;

  // 🚨 AND THEN ONE HOP FURTHER, WHICH THE FIRST VERSION OF THIS DID NOT DO.
  //
  // `origin.depositPayer` is the fee payer of the insert transaction, and in
  // this client that is ALWAYS a fresh ephemeral — a deposit is signed by
  // `deriveShieldEphemeral`, never by the wallet. MEASURED on a real devnet
  // shield: wallet `BRop…TjNN`, deposit fee payer `8Eq1jsbB…`.
  //
  // So comparing the connected wallet against `depositPayer` compares a wallet
  // to an ephemeral, which never matches, and the guard built to catch "you
  // deposited this note yourself" could not fire in the one case it exists for.
  // The screen would then have said "your wallet did not sign or pay for this
  // subscription" — true, and read as "nobody can reach me", while the actual
  // walk is: deposit → its ephemeral → whoever funded that ephemeral → the
  // wallet. That is one getSignaturesForAddress away, and it is precisely what
  // probe P9 measures.
  //
  // So resolve the funder of the deposit's payer. Bounded: the ephemeral's
  // funding transfer is the OLDEST entry of its short life, so a small page from
  // the far end answers it. `null` stays `null` — unknown, never safe.
  // Says what it is doing, because it is a chain walk on the critical path and
  // a frozen sentence is how the last one got mistaken for a hang. Measured
  // 2026-08-18 against devnet: ~1s for a payer with 102 signatures.
  onProgress?.('Checking who deposited this note...');
  const depositFunder = origin?.depositPayer
    ? await resolveFunderOfPayer(conn, origin.depositPayer)
    : null;

  // ── Circuit 7, when the caller supplied the terms it needs ────────────────
  //
  // ALL THREE, OR NONE. Checked here rather than treated as "as much as you
  // gave me": every one of them is a circuit-7 digest input, so a request
  // carrying two of the three is not a smaller request — it is a caller that
  // meant circuit 7 and dropped a field. Answering it with the C1 + C3 pair
  // republishes this note's commitment in cleartext and reports nothing, which
  // is the exact failure the pair exists to remove. Same shape, same reason, as
  // `handlePoolUnshieldPrepare`'s recipient/ownerPubkey check.
  const termsPresent = [req.retailer, req.rate, req.intervalSlots].filter(
    (v) => v !== undefined,
  ).length;
  if (termsPresent !== 0 && termsPresent !== 3) {
    throw new Error(
      'A circuit-7 subscription needs `retailer`, `rate` and `intervalSlots` all on the ' +
        'prepare, because all three are inside the proof digest. Send all three to prove on ' +
        'circuit 7, or none to prove on the C1 + C3 pair. A half-specified request must not ' +
        "fall through to C1 + C3 silently: that republishes this note's commitment.",
    );
  }

  if (req.retailer !== undefined && req.rate !== undefined && req.intervalSlots !== undefined) {
    const retailer = new PublicKey(req.retailer);

    // Ordered so the wasm call happens BEFORE proving: the vault PDA is seeded
    // on this commitment and the vault is the first 32 bytes of the digest after
    // the domain tag, so the proof cannot be built without it.
    const subscriberCommitmentV4 = await computeSubscriberCommitment(
      note.receipt.secret,
      onProgress,
    );

    // 🚨 THE LICENSE COMMITMENT MOVES TO PREPARE ON THIS ROUTE, AND IT MUST.
    // It is the 33-byte license slot of the digest, so it has to be known before
    // the proof exists — the v3 route derives it at execute, which is still
    // correct there because nothing binds it. The SECRET stays in this worker on
    // both routes; only the encoded key ever leaves.
    const serviceTag = licenseServiceTag(req.serviceId, retailer.toBase58());
    const licenseSecret = deriveLicenseSecret(note.receipt.secret, serviceTag);
    const licenseCommitmentBytes = licenseCommitment(licenseSecret);

    // Inert on-chain metadata; zeros unless the caller has something to put
    // there. Inside the digest all the same, which is why the execute handler
    // re-derives it the identical way and refuses a mismatch.
    const vkHashSubscriber =
      req.vkHashSubscriber && req.vkHashSubscriber.length === 32
        ? Uint8Array.from(req.vkHashSubscriber)
        : new Uint8Array(32);

    let v4: PreparedSubscribeV4 | null = null;
    try {
      v4 = await prepareSubscribeJobV4(
        note.receipt,
        pool,
        conn,
        candidate.seed,
        {
          retailer,
          subscriberCommitment: subscriberCommitmentV4,
          rate: BigInt(req.rate),
          intervalSlots: BigInt(req.intervalSlots),
          vkHashSubscriber,
          licenseCommitment: licenseCommitmentBytes,
        },
        onProgress,
      );
    } catch (err) {
      // ⛔ FALL BACK, OR THIS NOTE CANNOT BE SUBSCRIBED FROM THE WEB APP AT ALL.
      // The asymmetry between the two prepares is real and runs one way:
      // `prepareSubscribeJob` inherits `prepareUnshieldJob`'s stored-Merkle-path
      // shortcut, while `prepareSubscribeV4` has no such route and always
      // rebuilds from history. A note whose root aged out of the 100-root ring,
      // or one that predates commitment blinding, has only the C1 + C3 pair.
      //
      // Nothing has been spent at this point, which is what makes the retry
      // free: `prepareSubscribeV4` refuses before it proves and long before it
      // uploads. The allow-list fails CLOSED — a prover that cannot produce a
      // circuit-7 trace, or a caller that named a vault the seeds do not derive,
      // is a bug to surface, not to route around.
      if (!isV4RebuildFailure(err)) throw err;
      console.warn(
        '[pool/subscribe] circuit 7 could not prove this note; falling back to the C1 + C3 ' +
          'pair, which publishes the note commitment:',
        err instanceof Error ? err.message : String(err),
      );
      onProgress?.('Circuit 7 cannot prove this note — falling back to the C1 + C3 pair...');
    }

    if (v4) {
      // Already qualified by the vault PDA inside `prepareSubscribeJobV4` — see
      // the note on `preparedSubscribes` for the fund-loss that qualification
      // prevents. Nothing is appended here.
      preparedSubscribes.set(v4.jobId, {
        version: 'v4',
        ctx: v4,
        meta: req.meta,
        subscriberCommitment: subscriberCommitmentV4,
        licenseSecret,
        serviceTag,
      });

      return {
        kind: 'poolSubscribePrepare',
        jobId: v4.jobId,
        ephemeralPubkey: v4.ephemeral.publicKey.toBase58(),
        // Materially smaller than the v3 figure, and that is the circuit rather
        // than a saving: C1 and C3 are held open together so the v3 float is
        // their sum, and circuit 7 has nothing to pair with. Reported, never
        // assumed — `prepareSubscribeJobV4` prices its one buffer and the
        // vault's rent against the RPC.
        requiredLamports: v4.requiredLamports,
        denomination: pool.denomination,
        derivation: candidate.derivation,
        depositPayer: origin?.depositPayer ?? null,
        depositFunder,
        depositSignature: origin?.signature ?? null,
        version: 'v4',
      };
    }
  }

  // ── The v3 path. Byte for byte what it was before circuit 7 existed, except
  // for the `version` tag the caller is now told instead of guessing — and it is
  // reached two ways now: a request that named no terms at all, and a circuit-7
  // request whose rebuild could not produce a usable Merkle path.
  const ctx = await prepareSubscribeJob(
    note.receipt, pool, conn, candidate.seed, onProgress, storedPath,
  );

  // `compute_stark_commitment` returns the Goldilocks felt as a DECIMAL string
  // (stark/src/lib.rs:129-135). `goldilocksU64To32` then puts it in bytes 0..8
  // with 24 zeroes above, which is the exact 32 bytes the vault PDA is seeded on.
  // ⚠️ THE LAST SILENT STRETCH ON THIS PATH, AND IT IS NOT A SHORT ONE.
  //
  // Importing the prover pulls its whole bundle and `start()` boots a nested
  // worker; only then does the commitment get computed. All of it happens
  // behind ONE progress message. The main thread re-arms its 180s request
  // watchdog on every progress message, so this stretch either finishes inside
  // 180s or the job is killed for being quiet — while it is working.
  //
  // That failure mode has already been paid for twice on this path, in
  // `locateOwnedNote`: same watchdog, same cause, same useless "worker timed
  // out" shown to someone whose run had not failed at anything. The heartbeat
  // there is the fix that stuck, so use it here rather than discover it a third
  // time. Counting elapsed seconds is honest: it is the only number this step
  // exposes from outside.
  const subscriberCommitment = await computeSubscriberCommitment(note.receipt.secret, onProgress);

  preparedSubscribes.set(ctx.jobId, {
    version: 'v3',
    ctx,
    meta: req.meta,
    subscriberCommitment,
  });

  return {
    kind: 'poolSubscribePrepare',
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    requiredLamports: ctx.requiredLamports,
    denomination: pool.denomination,
    derivation: candidate.derivation,
    depositPayer: origin?.depositPayer ?? null,
    depositFunder,
    depositSignature: origin?.signature ?? null,
    version: 'v3',
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

    if (job.version === 'v4') {
      // ⛔ THE TERMS ARE CHECK-ONLY HERE. They already went into the proof at
      // prepare, so this branch may not APPLY anything the caller sends — it may
      // only refuse a disagreement. A stale-terms split is otherwise silent
      // until the very end: the digest moves, the buffer's `public_inputs_hash`
      // stops matching, and the failure lands after a ~78-chunk upload with only
      // `InvalidProof` to read.
      //
      // Refusing here rather than letting `subscribePrivateStarkV4` catch it is
      // not redundancy — that check runs after the pre-fund has been spent and
      // the ephemeral is holding the float. This one runs before anything moves.
      if (!job.ctx.retailer.equals(retailer)) {
        throw new Error(
          `This subscription was proved for retailer ${job.ctx.retailer.toBase58()} and cannot ` +
            `open a vault for ${retailer.toBase58()}. The retailer is a vault seed and the vault ` +
            'is inside the circuit-7 digest, so prepare it again for the new retailer.',
        );
      }
      if (job.ctx.binding.rate !== BigInt(req.rate)) {
        throw new Error(
          `This subscription was proved at a rate of ${job.ctx.binding.rate} and cannot be sent ` +
            `at ${req.rate}. The terms are inside the circuit-7 digest precisely so they cannot ` +
            'be changed after the proof exists.',
        );
      }
      if (job.ctx.binding.intervalSlots !== BigInt(req.intervalSlots)) {
        throw new Error(
          `This subscription was proved at an interval of ${job.ctx.binding.intervalSlots} slots ` +
            `and cannot be sent at ${req.intervalSlots}.`,
        );
      }
      // Re-derived the identical way the prepare derived it, then compared —
      // rather than trusted — because a caller that changes `serviceId` between
      // the two messages moves the license secret, and the license commitment is
      // 33 of the digest's 132 bytes.
      const executeTag = licenseServiceTag(req.serviceId, retailer.toBase58());
      if (executeTag !== job.serviceTag) {
        throw new Error(
          `This subscription's licence key was proved against service tag "${job.serviceTag}" ` +
            `and cannot be sent against "${executeTag}": the licence commitment is inside the ` +
            'circuit-7 digest.',
        );
      }
      const executeVk =
        req.vkHashSubscriber && req.vkHashSubscriber.length === 32
          ? Uint8Array.from(req.vkHashSubscriber)
          : new Uint8Array(32);
      if (!bytesEqual(executeVk, job.ctx.binding.vkHashSubscriber)) {
        throw new Error(
          'This subscription was proved against a different vkHashSubscriber. It is inert on ' +
            'chain but it is inside the circuit-7 digest, so it cannot change after the proof.',
        );
      }

      const { txSig, vaultPDA } = await executeSubscribeV4(
        job.ctx,
        conn,
        {
          ownerPubkey: new PublicKey(req.ownerPubkey),
          sweepTo: req.sweepTo ? new PublicKey(req.sweepTo) : undefined,
        },
        onProgress,
      );

      return {
        kind: 'poolSubscribeExecute',
        txSig,
        vaultPDA: vaultPDA.toBase58(),
        // Encoded from the secret derived at PREPARE, so the key the user is
        // handed is the one whose blake3 is actually on chain.
        licenseKey: encodeLicenseKey(job.licenseSecret),
        serviceTag: job.serviceTag,
        denomination: job.ctx.poolConfig.denomination,
      };
    }

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
        sweepTo: req.sweepTo ? new PublicKey(req.sweepTo) : undefined,
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
/**
 * Register a second identity and hand back only its public receive address.
 *
 * The signature crosses in and the seeds never come back out — same boundary
 * `setPoolSeed` holds for the wallet's own identity. What returns is the
 * `p01pq:` address, which is public key material and is exactly what an issuer
 * needs in order to seal a note to it.
 */
function handlePoolDeriveIdentity(req: PoolDeriveIdentityRequest): PoolDeriveIdentityResponse {
  if (!req.meta || req.signature.length < 32) {
    throw new Error('An identity needs a label and at least 32 bytes of signature.');
  }
  const signature = Uint8Array.from(req.signature);
  setPoolSeed(req.meta, signature);
  // Wipe the copy this frame made. The worker keeps the derived seeds, not the
  // signature they came from — that is the stronger secret of the two.
  signature.fill(0);
  return {
    kind: 'poolDeriveIdentity',
    meta: req.meta,
    address: createNoteEncryptionAddress(requireActiveSeed(req.meta)),
  };
}

/**
 * The one place the seed leaves this worker. See `PoolExportSeedRequest`.
 *
 * Returns the ACTIVE seed only. A legacy seed is reported as a flag rather than
 * returned: an operator who needs it has a passphrase-era treasury and a
 * decision to make about which notes they are issuing, and handing back two
 * secrets to a caller who asked for one is how the wrong one ends up in an env
 * var.
 */
function handlePoolExportSeed(req: PoolExportSeedRequest): PoolExportSeedResponse {
  if (
    req.confirm !==
    'I am configuring a note-issuing treasury and accept that this seed can spend every note it derives'
  ) {
    throw new Error('Seed export refused: the confirmation string does not match.');
  }
  const seeds = requireSeeds(req.meta);
  return {
    kind: 'poolExportSeed',
    seedHex: Array.from(seeds.active)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    derivation: seeds.activeVersion,
    hasLegacySeed: seeds.legacy !== undefined,
  };
}

async function handlePoolRecover(
  req: PoolRecoverRequest,
  onProgress?: (step: string) => void,
): Promise<PoolRecoverResponse> {
  const conn = requireConnection();
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));
  const pool = requirePool(req.token, req.denomination);

  /**
   * 🚨 A PREPARE THAT NEVER EXECUTED MUST NOT LOCK RECOVERY. MEASURED
   * 2026-08-31: a contribution prepared, the funding step then refused because
   * the ephemeral already held float from an earlier attempt, and the job stayed
   * in `prepared`. Shield said "run Recover first"; Recover said "a job is still
   * in progress". The two guards pointed at each other and the buyer could do
   * NEITHER — with their money sitting on the ephemeral both were talking about.
   *
   * The comment above `handlePoolShieldExecute` already names this exact trap:
   * "a retained job makes handlePoolRecover refuse and locks the user out". It
   * was written about the execute path and the deadlock arrived through prepare.
   *
   * ⛔ SO THE JOBS ARE DROPPED, NOT REFUSED OVER. A prepare holds no lamports
   * — it is a proof and a price. Recovery sweeps the ephemeral by DERIVATION,
   * not by job, so discarding the record loses nothing and the buyer can prepare
   * again afterwards. Refusing, by contrast, loses the only way to reach the
   * float.
   */
  if (prepared.size > 0 || preparedUnshields.size > 0 || preparedSubscribes.size > 0) {
    onProgress?.('Discarding unfinished attempts so their float can be swept...');
    prepared.clear();
    preparedUnshields.clear();
    preparedSubscribes.clear();
  }

  onProgress?.('Looking for funds left on earlier attempts...');
  // Sweep every derivation. Float stranded on an ephemeral derived before the
  // wallet adopted a passphrase is only reachable through the legacy seed, and
  // that float is often ~1 SOL of proof-buffer rent.
  const owner = new PublicKey(req.ownerPubkey);
  const funderPubkey = req.funderPubkey ? new PublicKey(req.funderPubkey) : undefined;
  const found = [];
  for (const candidate of candidates) {
    found.push(
      ...(await recoverStuckFloat(conn, pool, candidate.seed, owner, {
        onProgress,
        funderPubkey,
        funderUnknown: req.funderUnknown,
        unshieldLeafIndices: req.unshieldLeafIndices,
      })),
    );
  }

  // Split the totals by destination. A single figure would report the funder's
  // repayment as money the user got back, and the point of the repayment is
  // that they did not.
  const ownerB58 = owner.toBase58();
  return {
    kind: 'poolRecover',
    lamports: found.reduce((n, f) => (f.destination === ownerB58 ? n + f.lamports : n), 0),
    repaidToFunder: found.reduce(
      (n, f) => (f.destination !== null && f.destination !== ownerB58 ? n + f.lamports : n),
      0,
    ),
    closedBuffers: found.reduce((n, f) => n + f.closedBuffers, 0),
    keys: found.length,
    refused: found
      .filter((f): f is typeof f & { refused: SweepRefusal } => f.refused !== undefined)
      .map((f) => ({
        ephemeral: f.ephemeral,
        leafIndex: f.leafIndex,
        lamports: f.strandedLamports ?? 0,
        reason: f.refused,
        sentence: refusalSentence(f.refused),
        sources: f.sources ?? [],
      })),
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
 * Resolve `spent` for the local notes against the chain. Read-only; see
 * `PoolResolveSpentRequest`.
 *
 * 🚨 ONE POOL-WIDE READ PER DISTINCT POOL, never one read per note. Asking the
 * RPC about each unspent note's nullifier PDA is a deanonymisation channel — the
 * full reasoning is in `fetchSpentNullifierSet`'s header, and it is the reason
 * this handler no longer takes the obvious shape.
 *
 * A failed read must not sink the rest: the affected notes land in `unresolved`
 * and stay absent from the map, which callers treat as unknown. The failure is
 * remembered per pool so a dead RPC costs one attempt, not one per note.
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
  /**
   * Pool base58 -> its spent-nullifier PDA set, or `null` when that pool's read
   * failed. One RPC round trip per pool, success or failure.
   */
  const spentSetsByPool = new Map<string, ReadonlySet<string> | null>();

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

    // `null` is a REMEMBERED FAILURE, not "absent". Without it a dead RPC would
    // be retried once per note in the pool, which is both slow and a burst the
    // provider reads as one client hammering one pool.
    let spentSet = spentSetsByPool.get(note.pool);
    if (spentSet === undefined) {
      onProgress?.(`Reading spent markers for the ${pool.denomination} ${pool.token} pool...`);
      try {
        spentSet = await fetchSpentNullifierSet(conn, pool.poolPDA);
      } catch {
        spentSet = null;
      }
      spentSetsByPool.set(note.pool, spentSet);
    }

    if (spentSet === null) {
      unresolved += 1;
      continue;
    }

    spent[key] = isNullifierSpentInSet(
      spentSet,
      pool.poolPDA,
      note.nullifierPreimage,
      note.secret,
    );
    checked += 1;
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

/**
 * Recover this identity's subscription vaults from the chain. See
 * `PoolRecoverSubscriptionsRequest` and the module header of
 * `subscriptionRecovery.ts` — the RPC shape there is the whole point.
 *
 * The commitment function handed down is `starkProver.computeCommitment`, the
 * SAME wasm call `handlePoolSubscribePrepare` makes when it opens a vault. A
 * second implementation that drifted by a bit would find nothing and look
 * exactly like data loss, so none exists.
 */
async function handlePoolRecoverSubscriptions(
  req: PoolRecoverSubscriptionsRequest,
  onProgress?: (step: string) => void,
): Promise<PoolRecoverSubscriptionsResponse> {
  const conn = requireConnection();
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));

  // Blob-held notes. A note shielded here is ALSO derivable from the seeds, so
  // blobs only add information for received notes — but passing all of them is
  // free and keeps the contract identical to `poolResolveSpent`.
  const blobCandidates: CandidateNoteSecret[] = [];
  const seen = new Set<string>();
  for (const blob of req.blobs ?? []) {
    const note = decryptOwnedBlob(candidates, blob);
    if (!note) continue;
    const key = `${note.pool}:${note.leafIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blobCandidates.push({ pool: note.pool, leafIndex: note.leafIndex, secret: note.secret });
  }

  // The wasm boots lazily, on the first candidate that actually needs hashing:
  // a program with no private vaults must cost zero prover start-up.
  let proverStarted = false;
  const { recovered, vaultsScanned } = await recoverSubscriptionVaults(
    conn,
    candidates.map((c) => c.seed),
    {
      blobCandidates,
      computeSubscriberCommitment: async (secretDecimal) => {
        const { starkProver } = await import('../pool/starkProver');
        if (!proverStarted) {
          await starkProver.start();
          proverStarted = true;
        }
        return starkProver.computeCommitment(secretDecimal);
      },
      onProgress,
    },
  );

  // Whitelist copy, the same discipline as `handlePoolOpenRecords`: exactly
  // these nine public fields cross, whatever else the scan result carries.
  return {
    kind: 'poolRecoverSubscriptions',
    vaultsScanned,
    subscriptions: recovered.map((r) => ({
      vaultPDA: r.vaultPDA,
      retailer: r.retailer,
      tokenMint: r.tokenMint,
      token: r.token,
      denomination: r.denomination,
      rate: r.rate,
      intervalSlots: r.intervalSlots,
      pool: r.pool,
      leafIndex: r.leafIndex,
    })),
  };
}

/** HKDF info for the local-store label. Distinct from every seed info string. */
const STORE_LABEL_INFO = utf8ToBytes('p01:web:store-label:v1');

/** See `PoolStoreLabelRequest` for why this reads the V1 seed. */
function handlePoolStoreLabel(req: PoolStoreLabelRequest): PoolStoreLabelResponse {
  const set = requireSeeds(req.meta);
  // `?? set.active` is unreachable by construction (the v1 seed is either
  // active or legacy), kept so a future derivation version cannot turn this
  // into a crash that locks the user out of their stores.
  const seed = seedForDerivation(set, 1) ?? set.active;
  return {
    kind: 'poolStoreLabel',
    label: bytesToHex(hkdf(sha256, seed, undefined, STORE_LABEL_INFO, 16)),
    legacyAddress: createNoteEncryptionAddress(seed),
  };
}

/**
 * Open the sealed payout/spent records. See `PoolOpenRecordsRequest` — the
 * envelope + whitelist below are what keep this from being a decryption
 * oracle over the note store, and both checks are load-bearing.
 */
function handlePoolOpenRecords(req: PoolOpenRecordsRequest): PoolOpenRecordsResponse {
  const candidates = seedsInSearchOrder(requireSeeds(req.meta));
  const payouts: StoredPayoutRecord[] = [];
  const spentKeys: string[] = [];
  const handoffs: StoredHandoffRecord[] = [];
  const subscriptions: StoredSubscriptionWire[] = [];
  let skipped = 0;

  for (const blob of req.blobs ?? []) {
    let rec: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
      try {
        rec = JSON.parse(new TextDecoder().decode(decryptNote(candidate.seed, blob)));
        break;
      } catch {
        // Not this derivation's blob. Try the next.
      }
    }
    // The envelope check. A note blob decrypts fine but carries no `p01store`
    // marker, so it lands here — counted, never returned, secrets never cross.
    if (!rec || typeof rec !== 'object' || rec.p01store !== 1) {
      skipped += 1;
      continue;
    }
    if (
      rec.kind === 'payout' &&
      typeof rec.pool === 'string' &&
      Number.isInteger(rec.leafIndex) &&
      (rec.leafIndex as number) >= 0
    ) {
      // Whitelist copy: exactly the five public fields, nothing the blob may
      // have smuggled alongside them.
      payouts.push({
        pool: rec.pool,
        leafIndex: rec.leafIndex as number,
        address: String(rec.address ?? ''),
        txSig: String(rec.txSig ?? ''),
        denomination: Number(rec.denomination ?? 0),
      });
    } else if (rec.kind === 'spent' && typeof rec.key === 'string') {
      spentKeys.push(rec.key);
    } else if (
      rec.kind === 'handoff' &&
      typeof rec.pool === 'string' &&
      Number.isInteger(rec.leafIndex) &&
      (rec.leafIndex as number) >= 0
    ) {
      handoffs.push({
        pool: rec.pool,
        leafIndex: rec.leafIndex as number,
        sealedAt: Number(rec.sealedAt ?? 0),
      });
    } else if (
      rec.kind === 'subscription' &&
      typeof rec.vaultPDA === 'string' &&
      typeof rec.retailer === 'string' &&
      typeof rec.serviceTag === 'string'
    ) {
      // Field-by-field copy, mirroring `recordSubscription`'s own discipline:
      // whatever else the blob carries never crosses. Optionals stay optional
      // so a record tracked by vault address keeps contributing NO note key.
      const sub: StoredSubscriptionWire = {
        vaultPDA: rec.vaultPDA,
        retailer: rec.retailer,
        serviceTag: rec.serviceTag,
        token: String(rec.token ?? ''),
        denomination: Number(rec.denomination ?? 0),
        rate: String(rec.rate ?? '0'),
        intervalSlots: String(rec.intervalSlots ?? '0'),
        openedAt: Number(rec.openedAt ?? 0),
      };
      if (typeof rec.serviceName === 'string') sub.serviceName = rec.serviceName;
      if (typeof rec.openTxSig === 'string') sub.openTxSig = rec.openTxSig;
      if (typeof rec.pool === 'string') sub.pool = rec.pool;
      if (Number.isInteger(rec.leafIndex) && (rec.leafIndex as number) >= 0) {
        sub.leafIndex = rec.leafIndex as number;
      }
      subscriptions.push(sub);
    } else {
      skipped += 1;
    }
  }

  return { kind: 'poolOpenRecords', payouts, spentKeys, handoffs, subscriptions, skipped };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handlePoolRequest<R extends PoolRequest>(
  req: R,
  onProgress?: (step: string) => void,
  /**
   * Streamed partial results for jobs that can honestly produce them — today
   * only `poolScan`, whose blinded pass finishes ~4 orders of magnitude before
   * the legacy epoch search does. Every payload says `complete: false` itself;
   * the terminal return value is the only complete answer.
   */
  onInterim?: (partial: PoolResponse) => void,
): Promise<PoolResponseFor<R>> {
  let res: PoolResponse;
  switch (req.kind) {
    case 'poolScanLocal':
      return handlePoolScanLocal(req as PoolScanLocalRequest) as never;
    case 'poolScan':
      res = await handlePoolScan(req, onProgress, onInterim);
      break;
    case 'poolShieldPrepare':
      res = await handlePoolShieldPrepare(req, onProgress);
      break;
    case 'poolShieldExecute':
      res = await handlePoolShieldExecute(req, onProgress);
      break;
    case 'poolContributePrepare':
      res = await handlePoolContributePrepare(req, onProgress);
      break;
    case 'poolContributeExecute':
      res = await handlePoolContributeExecute(req, onProgress);
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
    case 'poolDeriveIdentity':
      res = handlePoolDeriveIdentity(req);
      break;
    case 'poolExportSeed':
      res = handlePoolExportSeed(req);
      break;
    case 'poolRecover':
      res = await handlePoolRecover(req, onProgress);
      break;
    case 'poolRecoverSubscriptions':
      res = await handlePoolRecoverSubscriptions(req, onProgress);
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
    case 'poolStoreLabel':
      res = handlePoolStoreLabel(req);
      break;
    case 'poolOpenRecords':
      res = handlePoolOpenRecords(req);
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
