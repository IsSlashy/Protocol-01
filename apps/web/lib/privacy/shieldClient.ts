import type { PoolToken } from './pool/denominatedPool';
/**
 * shieldClient — main-thread driver for a denominated-pool shield.
 *
 * The worker does everything secret; this file exists only because the user's
 * wallet lives on the main thread and must sign the ONE transaction that funds
 * the ephemeral depositor. Order matters:
 *
 *   prepare (worker, proves C6)  →  fund the ephemeral (wallet, 1 signature)
 *   →  execute (worker, ~150 chunk uploads + shield + sweep)
 *
 * If `prepare` throws, nothing has moved. If the pre-fund lands but `execute`
 * never completes, the ephemeral is derived from the wallet seed and is
 * therefore re-derivable on any device — the funds are recoverable, not lost.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { poolRequest } from './workerClient';

/** Sign one transaction with the connected wallet. */
export type SignOne = (tx: Transaction) => Promise<Transaction>;

export interface ShieldParams {
  /** Session key from `deriveMeta`. */
  meta: string;
  token: PoolToken;
  denomination: number;
  owner: PublicKey;
  connection: Connection;
  signOne: SignOne;
  onProgress?: (step: string) => void;
}

export interface ShieldOutcome {
  txSig: string;
  commitment: string;
  leafIndex: number;
  denomination: number;
  /** Already encrypted to the user's own PQ address — safe to persist as-is. */
  encryptedNote: string;
  /** Lamports the wallet moved onto the ephemeral (most of it comes back). */
  fundedLamports: number;
}

export async function shieldToPool(params: ShieldParams): Promise<ShieldOutcome> {
  const { meta, token, denomination, owner, connection, signOne, onProgress } = params;

  const prep = await poolRequest(
    { kind: 'poolShieldPrepare', meta, token, denomination },
    onProgress,
  );

  onProgress?.('Approve the funding transaction in your wallet...');
  const ephemeral = new PublicKey(prep.ephemeralPubkey);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ephemeral,
      lamports: prep.requiredLamports,
    }),
  );
  fundTx.recentBlockhash = blockhash;
  fundTx.feePayer = owner;

  const signed = await signOne(fundTx);
  const fundSig = await connection.sendRawTransaction(signed.serialize());
  const conf = await connection.confirmTransaction(
    { signature: fundSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`Funding transaction failed: ${JSON.stringify(conf.value.err)}`);
  }

  const done = await poolRequest(
    { kind: 'poolShieldExecute', jobId: prep.jobId, ownerPubkey: owner.toBase58() },
    onProgress,
  );

  return {
    txSig: done.txSig,
    commitment: done.commitment,
    leafIndex: done.leafIndex,
    denomination: done.denomination,
    encryptedNote: done.encryptedNote,
    fundedLamports: prep.requiredLamports,
  };
}

export interface UnshieldParams {
  meta: string;
  token: PoolToken;
  denomination: number;
  /** Which note to spend, by the leaf index it occupies. */
  leafIndex: number;
  /** Address that receives the funds. */
  recipient: PublicKey;
  /** Wallet paying the proof float; receives the swept residual. */
  owner: PublicKey;
  /** Note blobs stored at shield time. The worker picks the one matching this
   *  note and uses its Merkle path, skipping the history rebuild. */
  encryptedNotes?: string[];
  connection: Connection;
  signOne: SignOne;
  onProgress?: (step: string) => void;
}

/**
 * Withdraw one note. Same two-phase shape as a shield: the worker proves and
 * prices, the wallet signs a single pre-fund, the worker uploads both proofs
 * and withdraws.
 */
export async function unshieldFromPool(
  params: UnshieldParams,
): Promise<{ txSig: string; denomination: number }> {
  const { meta, token, denomination, leafIndex, recipient, owner, connection, signOne, onProgress } =
    params;

  const prep = await poolRequest(
    {
      kind: 'poolUnshieldPrepare',
      meta,
      token,
      denomination,
      leafIndex,
      encryptedNotes: params.encryptedNotes,
    },
    onProgress,
  );

  onProgress?.('Approve the funding transaction in your wallet...');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: new PublicKey(prep.ephemeralPubkey),
      lamports: prep.requiredLamports,
    }),
  );
  fundTx.recentBlockhash = blockhash;
  fundTx.feePayer = owner;

  const signed = await signOne(fundTx);
  const fundSig = await connection.sendRawTransaction(signed.serialize());
  const conf = await connection.confirmTransaction(
    { signature: fundSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`Funding transaction failed: ${JSON.stringify(conf.value.err)}`);
  }

  const done = await poolRequest(
    {
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: recipient.toBase58(),
      ownerPubkey: owner.toBase58(),
    },
    onProgress,
  );

  return { txSig: done.txSig, denomination: done.denomination };
}

export interface SubscribeParams {
  meta: string;
  token: PoolToken;
  denomination: number;
  /** Which note pays for the subscription, by the leaf index it occupies. */
  leafIndex: number;
  /** Merchant who can claim each period. */
  retailer: PublicKey;
  /** Per-period amount, in the pool token's smallest unit. */
  rate: bigint;
  /** Slots between claimable periods. Must be > 0; the program rejects 0. */
  intervalSlots: bigint;
  /** Registry `serviceId`. Omitted, the key is scoped to the retailer address. */
  serviceId?: string | null;
  /** Wallet paying the proof float; receives the swept residual. */
  owner: PublicKey;
  /** Note blobs stored at shield time; the worker uses the matching Merkle path. */
  encryptedNotes?: string[];
  connection: Connection;
  signOne: SignOne;
  onProgress?: (step: string) => void;
}

export interface SubscribeOutcome {
  txSig: string;
  /** Base58 subscription vault PDA. */
  vaultPDA: string;
  /** The "P01-…" key to show the user. Reproducible from the note, so losing it
   *  is recoverable — but nothing else stores it, so show it. */
  licenseKey: string;
  /** The string the key is scoped to; a merchant needs it to verify. */
  serviceTag: string;
  denomination: number;
  fundedLamports: number;
}

/**
 * Open a subscription vault from one shielded note. Same two-phase shape as a
 * withdrawal, and for the same reason: the worker proves C1 + C3 and prices the
 * job, the wallet signs a single pre-fund, the worker uploads ~150 proof chunks
 * and sends the subscribe.
 *
 * The pre-fund is larger than a withdrawal's by the subscription vault's rent
 * (361 bytes), and that part does NOT come back — the vault stays open until the
 * merchant's final `claim_period` closes it.
 *
 * No secret crosses this boundary in either direction. The license key comes
 * back derived; the note secret it came from does not.
 */
export async function subscribeFromPool(params: SubscribeParams): Promise<SubscribeOutcome> {
  const {
    meta, token, denomination, leafIndex, retailer, rate, intervalSlots,
    owner, connection, signOne, onProgress,
  } = params;

  const prep = await poolRequest(
    {
      kind: 'poolSubscribePrepare',
      meta,
      token,
      denomination,
      leafIndex,
      encryptedNotes: params.encryptedNotes,
    },
    onProgress,
  );

  onProgress?.('Approve the funding transaction in your wallet...');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: new PublicKey(prep.ephemeralPubkey),
      lamports: prep.requiredLamports,
    }),
  );
  fundTx.recentBlockhash = blockhash;
  fundTx.feePayer = owner;

  const signed = await signOne(fundTx);
  const fundSig = await connection.sendRawTransaction(signed.serialize());
  const conf = await connection.confirmTransaction(
    { signature: fundSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`Funding transaction failed: ${JSON.stringify(conf.value.err)}`);
  }

  const done = await poolRequest(
    {
      kind: 'poolSubscribeExecute',
      jobId: prep.jobId,
      ownerPubkey: owner.toBase58(),
      retailer: retailer.toBase58(),
      // u64 decimal strings — the worker boundary carries JSON-safe primitives.
      rate: rate.toString(),
      intervalSlots: intervalSlots.toString(),
      serviceId: params.serviceId ?? null,
    },
    onProgress,
  );

  return {
    txSig: done.txSig,
    vaultPDA: done.vaultPDA,
    licenseKey: done.licenseKey,
    serviceTag: done.serviceTag,
    denomination: done.denomination,
    fundedLamports: prep.requiredLamports,
  };
}

/**
 * Reclaim SOL left on ephemerals by earlier failed runs. Proof-buffer rent can
 * only be released by the ephemeral that created it, so this is the only way
 * that money comes back.
 */
export function recoverStuckFunds(
  meta: string,
  denomination: number,
  owner: PublicKey,
  onProgress?: (step: string) => void,
) {
  return poolRequest(
    { kind: 'poolRecover', meta, token: 'SOL', denomination, ownerPubkey: owner.toBase58() },
    onProgress,
  );
}

/** Read the shielded balance + note list for this identity. */
export function scanPool(
  meta: string,
  token: PoolToken,
  onProgress?: (step: string) => void,
) {
  return poolRequest({ kind: 'poolScan', meta, token }, onProgress);
}

/**
 * The caller's notes, instantly, from the blobs written at shield time.
 *
 * `scanPool` walks every denomination's on-chain history and re-derives per seed
 * candidate — tens of seconds against the public devnet RPC, during which the UI
 * can only say "Scanning the 0.1 SOL pool...". Everything needed to DRAW the
 * list is already in local storage, encrypted under the pool seed. This reads it
 * without touching the network.
 *
 * 🚨 The returned notes carry `spentKnown: false`. Whether a note has been spent
 * lives in an on-chain nullifier PDA and nothing here has seen one. Show these
 * as provisional and follow with a real `scanPool`; presenting a spent note as
 * available would invite the user to spend money that is gone, which is worse
 * than the wait this removes.
 *
 * Notes shielded on another device are absent — the blob is local. That is why
 * this is a fast FIRST paint, never a replacement.
 */
export function scanPoolLocal(meta: string, walletPubkey: string) {
  return poolRequest({ kind: 'poolScanLocal', meta, blobs: loadEncryptedNotes(walletPubkey) });
}

// ---------------------------------------------------------------------------
// Note persistence (opaque blobs only)
// ---------------------------------------------------------------------------

const NOTE_STORE_KEY = 'p01_pay_notes_v1';

/**
 * Persist an encrypted note blob. The main thread cannot read these — only the
 * worker, holding the pool seed, can decrypt them.
 *
 * NOTE ON WHAT THIS IS AND IS NOT: nothing currently reads these blobs back.
 * `loadEncryptedNotes` is used only to show a count, and `decryptNote` has no
 * caller. Discovery and withdrawal both work from the pool seed plus on-chain
 * event history (`pool/poolNotes.ts`), so the blob is a forward-looking record,
 * not a recovery path — and it could not be one anyway while withdrawal needs
 * event history to rebuild the Merkle proof. Do not describe it as a fallback.
 */
export function storeEncryptedNote(walletPubkey: string, blob: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = readNoteStore();
    const list = all[walletPubkey] ?? [];
    if (!list.includes(blob)) list.push(blob);
    all[walletPubkey] = list;
    localStorage.setItem(NOTE_STORE_KEY, JSON.stringify(all));
  } catch {
    // Quota or private-mode failure — recovery-by-scan still covers the user.
  }
}

export function loadEncryptedNotes(walletPubkey: string): string[] {
  return readNoteStore()[walletPubkey] ?? [];
}

const SPENT_STORE_KEY = 'p01_pay_spent_notes_v1';

/**
 * Notes this browser has withdrawn, keyed `pool:leafIndex`.
 *
 * WHY THIS EXISTS. Whether a note is spent lives in an on-chain nullifier PDA,
 * and reading it means the full pool scan — which enumerates candidate epochs
 * per note per denomination and runs for minutes on devnet. Until it answers,
 * every list is drawn from the local blobs, whose `spent` is a default and not
 * a reading, so a note withdrawn ten minutes ago comes back offering Withdraw.
 * Measured on devnet 2026-08-04: leaf #18 survived its own withdrawal, the
 * sweep, and a page reload.
 *
 * Acting on one of those rows locks ~1 SOL of proof-buffer rent and spends
 * minutes uploading before it can only fail on a nullifier collision.
 *
 * APPEND-ONLY AND NON-DESTRUCTIVE ON PURPOSE. The note blob is left alone, so
 * nothing is lost if this record is wrong; and since a spent note cannot become
 * unspent, an entry here can only ever correct a stale read, never hide a live
 * note. It is a local memory of our own actions, not a substitute for the chain.
 */
export function recordSpentNote(walletPubkey: string, noteKey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = readSpentStore();
    const list = all[walletPubkey] ?? [];
    if (!list.includes(noteKey)) list.push(noteKey);
    all[walletPubkey] = list;
    localStorage.setItem(SPENT_STORE_KEY, JSON.stringify(all));
  } catch {
    // Quota or private-mode failure. The chain scan still resolves it, slowly.
  }
}

export function loadSpentNotes(walletPubkey: string): string[] {
  return readSpentStore()[walletPubkey] ?? [];
}

/**
 * Every note this browser knows it has spent, keyed `pool:leafIndex`.
 *
 * Unions the explicit record above with the payout history, because a payout
 * record is written only when a withdrawal has succeeded — it is already proof
 * of a spend, and it exists for withdrawals made before the explicit record was
 * introduced. Without that second source the fix would only protect notes spent
 * from this version onward, and would leave exactly the note that exposed the
 * bug still sitting in the list.
 */
export function knownSpentNoteKeys(walletPubkey: string): Set<string> {
  const keys = new Set(loadSpentNotes(walletPubkey));
  for (const p of loadPayouts(walletPubkey)) keys.add(`${p.pool}:${p.leafIndex}`);
  return keys;
}

function readSpentStore(): Record<string, string[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SPENT_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function readNoteStore(): Record<string, string[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(NOTE_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Withdrawal payout addresses
// ---------------------------------------------------------------------------

/**
 * WHY A WITHDRAWAL NO LONGER PAYS THE CONNECTED WALLET
 * ───────────────────────────────────────────────────
 * `unshield_denominated_stark_v3` takes the recipient as a plain account, and
 * /pay used to pass the connected wallet (`PoolPanel.tsx:125`, `recipient: owner`).
 * That put the user's wallet in the withdrawal transaction by name, which is the
 * one thing a shielded pool exists to avoid. The withdrawal now pays a fresh
 * address, one per note, and the user moves the funds on afterwards at a time
 * and to a destination they choose.
 *
 * THE DERIVATION, AND THE MOBILE BUG IT DELIBERATELY DOES NOT COPY
 * ───────────────────────────────────────────────────────────────
 * Mobile derives its per-note stealth signer as
 *
 *   hmac(sha256, walletAddr, 'stealth_unshield_v3_' + noteId)
 *       — apps/mobile/stores/denominatedPoolStore.ts:1545
 *
 * Both inputs are PUBLIC, so anybody who watches the chain recomputes the
 * private key. "Each note id is used only once" is a collision argument, not a
 * secrecy argument. Do not port that.
 *
 * Here the root is a wallet SIGNATURE over a fixed, origin-bound, version-tagged
 * message — the same class of secret `seedDerivation.ts` already builds the pool
 * seed from, and the same recoverability property: deterministic Ed25519, so the
 * same wallet reaches the same payout addresses on any device, forever, with
 * nothing stored.
 *
 *   payoutRoot = HKDF-SHA256(ikm = signature, salt = ∅, info = <root info>)
 *   payoutKey(pool, leaf) = Ed25519(HKDF-SHA256(ikm = payoutRoot, salt = ∅,
 *                                   info = <key info> ‖ poolPDA ‖ u32le(leaf)))
 *
 * The message is NOT `buildDerivationMessage`. That is load-bearing: this root
 * lives on the MAIN THREAD, and the pool seed must stay derivable only inside
 * the Worker. A different message means a leak of this signature yields payout
 * keys and nothing else — no note secret, no nullifier, no stealth spend key.
 *
 * WHAT THIS DOES **NOT** BUY — read before writing any copy
 * ────────────────────────────────────────────────────────
 * The wallet still publicly funds the withdrawal ephemeral E before the
 * withdrawal runs (`unshieldFromPool` above builds `owner -> E` and the wallet
 * signs it), and E is the withdrawal's own signer. So an observer still reads
 * "wallet funded E, E withdrew note X". Moving the RECIPIENT off the wallet stops
 * the note's value from landing in the wallet and stops the wallet appearing as
 * the pool's payee; it does not unlink the wallet from the withdrawal. Closing
 * that needs the pre-fund to stop coming from the wallet, which is not built.
 *
 * And sweeping a payout address straight back to the wallet re-establishes the
 * link, exactly as the measured mobile withdrawal did (stealth recipient
 * C4MqLbEx… forwarded 0.994995 SOL to the user's wallet 8 seconds later, slot
 * 481027703). That is why the sweep is a separate, user-initiated action with a
 * free-text destination, and never automatic.
 *
 * QUANTUM: the root is an Ed25519 signature, so a CRQC adversary who recovers
 * the wallet key re-signs this message and reproduces every payout key. Same
 * exposure `seedDerivation.ts:17-25` documents for the pool seed. Payout
 * addresses are meant to be swept promptly, not used as storage.
 */
export const POOL_PAYOUT_DERIVATION_VERSION = 'pool-payout-v1';

/** HKDF info for the root. Distinct from every pool-seed info string. */
const PAYOUT_ROOT_INFO = utf8ToBytes('p01:web:pool-payout-root:v1');

/** HKDF info prefix for one note's payout key. */
const PAYOUT_KEY_INFO = utf8ToBytes('p01:web:pool-payout-key:v1');

/**
 * The string the wallet signs to unlock its payout addresses.
 *
 * Origin-bound and version-tagged for the same reasons `buildDerivationMessage`
 * is (see `message.ts`), and deliberately different from it so the two roots
 * cannot be derived from one another.
 */
export function buildPoolPayoutMessage(params: {
  walletPubkey: string;
  origin: string;
}): string {
  const { walletPubkey, origin } = params;
  return [
    'Protocol 01 — Pool Withdrawal Payout Keys',
    '',
    'Sign to derive the one-time addresses your shielded withdrawals pay out to.',
    'This does NOT send a transaction and costs no gas.',
    '',
    `ONLY sign this on ${origin}. Signing it elsewhere exposes those addresses.`,
    '',
    `Domain: ${origin}`,
    `Wallet: ${walletPubkey}`,
    `Version: ${POOL_PAYOUT_DERIVATION_VERSION}`,
  ].join('\n');
}

/** HKDF the signature into the 32-byte payout root. The caller should wipe the
 *  signature afterwards — it is the stronger secret of the two. */
export function derivePoolPayoutRoot(signature: Uint8Array): Uint8Array {
  return hkdf(sha256, signature, undefined, PAYOUT_ROOT_INFO, 32);
}

/**
 * The address one note's withdrawal pays out to.
 *
 * Keyed by (pool, leaf index) so it is fresh per note and re-derivable from the
 * note list alone — a withdrawn note keeps its leaf index forever, so a user who
 * clears local storage still recovers every payout address from a rescan.
 */
export function derivePoolPayoutKeypair(
  payoutRoot: Uint8Array,
  poolPDA: PublicKey | string,
  leafIndex: number,
): Keypair {
  if (!Number.isInteger(leafIndex) || leafIndex < 0) {
    throw new Error(`Refusing to derive a payout key for leaf index ${leafIndex}.`);
  }
  const pool = typeof poolPDA === 'string' ? new PublicKey(poolPDA) : poolPDA;
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, leafIndex, true);
  const info = concatBytes(PAYOUT_KEY_INFO, pool.toBytes(), idx);
  return Keypair.fromSeed(hkdf(sha256, payoutRoot, undefined, info, 32));
}

/** One withdrawal's payout address, as remembered locally. */
export interface PayoutRecord {
  /** Pool PDA, base58. */
  pool: string;
  leafIndex: number;
  /** The derived payout address, base58. Public — no secret is stored. */
  address: string;
  /** Withdrawal signature, for the explorer link. */
  txSig: string;
  denomination: number;
}

const PAYOUT_STORE_KEY = 'p01_pay_pool_payouts_v1';

/**
 * Remember a payout address so the UI can list it without a full rescan.
 *
 * This is a CONVENIENCE, not the recovery path: the address is a pure function
 * of (wallet signature, pool, leaf index), so a wiped store costs a rescan and
 * nothing else. Only public values are written.
 */
export function recordPayout(walletPubkey: string, rec: PayoutRecord): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = readPayoutStore();
    const list = all[walletPubkey] ?? [];
    if (!list.some((r) => r.pool === rec.pool && r.leafIndex === rec.leafIndex)) {
      list.push(rec);
    }
    all[walletPubkey] = list;
    localStorage.setItem(PAYOUT_STORE_KEY, JSON.stringify(all));
  } catch {
    // Quota or private-mode failure — re-derivation from the note list still
    // finds every payout address.
  }
}

export function loadPayouts(walletPubkey: string): PayoutRecord[] {
  return readPayoutStore()[walletPubkey] ?? [];
}

function readPayoutStore(): Record<string, PayoutRecord[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PAYOUT_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, PayoutRecord[]>) : {};
  } catch {
    return {};
  }
}

/** Exactly the sweep transaction's own fee, so the payout account lands on zero.
 *  Any smaller residue leaves a 0-data system account rent-paying, which the
 *  runtime rejects outright — the same trap documented in `unshieldEphemeral.ts`. */
const PAYOUT_SWEEP_FEE = 5_000;

/**
 * Move a payout address's whole balance to `destination`, signed by the derived
 * key alone. The user's wallet is not involved and approves nothing.
 *
 * `destination` is whatever the caller passes. Sweeping to the wallet that
 * funded the withdrawal is allowed and is sometimes what the user wants; it also
 * re-links the two on-chain, so whatever surfaces this MUST say so.
 */
export async function sweepPayout(params: {
  connection: Connection;
  payout: Keypair;
  destination: PublicKey;
}): Promise<{ txSig: string; lamports: number }> {
  const { connection, payout, destination } = params;
  const balance = await connection.getBalance(payout.publicKey, 'confirmed');
  const lamports = balance - PAYOUT_SWEEP_FEE;
  if (lamports <= 0) {
    throw new Error('This payout address is empty — nothing to sweep.');
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payout.publicKey,
      toPubkey: destination,
      lamports,
    }),
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payout.publicKey;
  tx.sign(payout);
  const txSig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(
    { signature: txSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`Sweep failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }
  return { txSig, lamports };
}

// ---------------------------------------------------------------------------
// Spent resolution for locally stored notes
// ---------------------------------------------------------------------------

export interface ResolveSpentOutcome {
  /** Note keys ("pool:leafIndex") the chain confirms SPENT, now recorded. */
  confirmedSpent: string[];
  /** Notes checked against the chain. */
  checked: number;
  /** Blobs that decrypted under no seed this identity holds. */
  skipped: number;
  /** Notes whose nullifier read failed; their status is unchanged. */
  unresolved: number;
}

/**
 * Ask the chain which of this browser's notes are actually spent, and record
 * the confirmations.
 *
 * Closes the gap `scanPoolLocal` documents: the locally painted list carries
 * `spentKnown: false`, and the full `poolScan` that would reconcile it walks
 * candidate epochs across six denominations first: it does not finish in a
 * time a user waits. This resolves ONLY the notes already known locally, one
 * nullifier-PDA read each, a few seconds total. It catches spends nothing
 * recorded: a subscription made before `recordSubscription` existed, a spend
 * from another device, a wiped session.
 *
 * One-directional on purpose: confirmations are written through
 * `recordSpentNote`, so a note only ever moves from unspent to spent. A note
 * the chain reports unspent is left exactly as it was, because the chain saying "no
 * nullifier yet" must never resurrect a note something else knows is gone.
 *
 * Callers should re-read `knownSpentNoteKeys` afterwards and re-filter.
 */
export async function resolveSpentNotes(
  meta: string,
  walletPubkey: string,
  onProgress?: (step: string) => void,
): Promise<ResolveSpentOutcome> {
  const res = await poolRequest(
    { kind: 'poolResolveSpent', meta, blobs: loadEncryptedNotes(walletPubkey) },
    onProgress,
  );
  const confirmedSpent = Object.entries(res.spent)
    .filter(([, isSpent]) => isSpent)
    .map(([key]) => key);
  for (const key of confirmedSpent) recordSpentNote(walletPubkey, key);
  return {
    confirmedSpent,
    checked: res.checked,
    skipped: res.skipped,
    unresolved: res.unresolved,
  };
}

// ---------------------------------------------------------------------------
// License key re-derivation
// ---------------------------------------------------------------------------

/**
 * Re-derive the license key of a subscription paid for by one of this
 * browser's notes. Derived on demand in the worker from the note secret, which
 * is why no store anywhere has to hold it; the same key the subscribe flow
 * showed once. Throws when this browser does not hold the paying note's blob
 * (spent from another device, or storage wiped); the key is then only
 * re-derivable on a device that does.
 *
 * ⛔ The returned key is a bearer credential. Show it, let the user copy it,
 * and never log or persist it.
 */
export async function deriveSubscriptionLicenseKey(params: {
  meta: string;
  walletPubkey: string;
  /** Pool PDA (base58) + leaf index of the note that paid, from the record. */
  pool: string;
  leafIndex: number;
  /** The tag the key is scoped to: registry slug, else retailer address. */
  serviceTag: string;
}): Promise<string> {
  const res = await poolRequest({
    kind: 'poolLicenseKey',
    meta: params.meta,
    blobs: loadEncryptedNotes(params.walletPubkey),
    pool: params.pool,
    leafIndex: params.leafIndex,
    serviceTag: params.serviceTag,
  });
  return res.licenseKey;
}
