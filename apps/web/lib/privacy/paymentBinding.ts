/**
 * The keys that tie one payment to one claim, in ONE place.
 *
 * Three routes share these strings: `/api/relay-to-buyer` writes the binding
 * once the float has funded a deposit, `/api/contribute-note` confirm requires
 * it before it pays for a leaf, and `/api/claim-for-payment` reads it to tell a
 * plain sale from the fallback of a relayed deposit that never landed.
 *
 * A key format written in three files and moved in one is the failure
 * `treasurySeeds.ts` documents. So the format is written here and imported.
 *
 * THE RULE THE KEYS ENFORCE: one claim per payment signature, and
 * `p01:note:paid:<sig>` is the only mint gate, used by every route that mints.
 *
 *   p01:relay:payment:<sig>                the relay's one-shot claim (incr)
 *   p01:relay:payment:<sig>:contribution   `<poolKey>:<leaf>` the relay funded
 *   p01:relay:payment:<sig>:buyer          the ephemeral it funded
 *   p01:note:paid:<sig>                    the mint gate (incr; 1 mints)
 *   p01:note:paid:<sig>:code               the code that payment earned
 *   p01:note:contrib-reserved:<pool>:<leaf>
 *   p01:note:contrib-confirmed:<pool>:<leaf>
 *   p01:relay:contribution-hold:<pool>:<leaf>   the SEALED holder of a leaf
 *   p01:note:contrib-abandoned              free reservations that died unpaid (F73)
 *
 * ⛔ ONE ROW PAIRS A LEAF WITH A PAYMENT, AND IT IS THE BINDING ABOVE. A copy
 * of this store is read by whoever takes a backup, and a payment signature
 * resolves publicly to the wallet that made it — so a row holding a leaf and a
 * signature, or a leaf and a claim code, names the buyer of that leaf for as
 * long as the row exists.
 *
 *   - `contrib-claim:<pool>:<leaf>` held the code a confirmed leaf earned and
 *     was read by NOTHING: both routes replay off `paid:<sig>:code`. Dropped
 *     by KV-1.
 *   - `claim-minted:<code>` holds `payment:<sig>` and no leaf.
 *   - the binding is kept because confirm and the fallback need it, carries no
 *     expiry (a TTL would refuse a paying buyer their own leaf), and is
 *     deleted at redemption by `issue-note`'s sweep.
 *
 * Pinned by `__tests__/api/contribute-note.test.ts` "writes no leaf-to-code
 * row", `__tests__/api/relay-to-buyer.test.ts` "the contribution binding
 * carries no expiry", and measured across worlds by
 * `__tests__/lib/kvRowsAtRest.test.ts`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';

import { getPoolsForTokenV3, type PoolConfig } from '@/lib/privacy/pool/denominatedPool';

export type ContributionToken = 'SOL' | 'USDC';

export interface ContributionRef {
  token: ContributionToken;
  leafIndex: number;
}

const RELAY_PAYMENT_PREFIX = 'p01:relay:payment:';
const NOTE_PAID_PREFIX = 'p01:note:paid:';

/** The relay's one-shot claim on a payment. Present means "this payment funded a relayed deposit". */
export function relayPaymentClaimKey(signature: string): string {
  return `${RELAY_PAYMENT_PREFIX}${signature}`;
}

/** The `<poolKey>:<leaf>` the relay funded with this payment. Written only after the lamports moved. */
export function relayPaymentContributionKey(signature: string): string {
  return `${RELAY_PAYMENT_PREFIX}${signature}:contribution`;
}

/** The ephemeral the relay funded with this payment. Same timing as the contribution key. */
export function relayPaymentBuyerKey(signature: string): string {
  return `${RELAY_PAYMENT_PREFIX}${signature}:buyer`;
}

/** The mint gate. `incr` returns 1 for exactly one caller per payment. */
export function notePaidKey(signature: string): string {
  return `${NOTE_PAID_PREFIX}${signature}`;
}

/** The claim code a payment earned, so a retry returns the same one. */
export function notePaidCodeKey(signature: string): string {
  return `${NOTE_PAID_PREFIX}${signature}:code`;
}

/** A leaf handed to a contributor, so two of them never get the same index. */
export function contribReservedKey(poolKey: string, leafIndex: number): string {
  return `p01:note:contrib-reserved:${poolKey}:${leafIndex}`;
}

/** One key per confirmed leaf. `incr` on it is the one-claim-per-deposit rule. */
export function contribConfirmedKey(poolKey: string, leafIndex: number): string {
  return `p01:note:contrib-confirmed:${poolKey}:${leafIndex}`;
}

/** The value the relay records and the confirm compares against. */
export function contributionBinding(poolKey: string, leafIndex: number): string {
  return `${poolKey}:${leafIndex}`;
}

/**
 * The denomination this deployment deals in. Mirrors `issue-note`'s reader,
 * which is the authority: a contribution is reserved in the pool issuance can
 * serve from, or the leaf can never be sold.
 */
export function inventoryDenomination(): number {
  const raw = Number(process.env.P01_TREASURY_NOTE_DENOMINATION);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

/** The pool a contribution in `token` lands in, or undefined when none is configured. */
export function resolveContributionPool(token: ContributionToken): PoolConfig | undefined {
  const denomination = inventoryDenomination();
  return getPoolsForTokenV3(token).find((p) => p.denomination === denomination);
}

/**
 * Read `{ token, leafIndex }` off an untrusted body. `null` when it is not a
 * contribution reference at all; the caller decides whether that is a 400 or
 * "no contribution was sent".
 */
export function parseContributionRef(raw: unknown): ContributionRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const { token, leafIndex } = raw as { token?: unknown; leafIndex?: unknown };
  const leaf = Number(leafIndex);
  if (!Number.isInteger(leaf) || leaf < 0) return null;
  return { token: token === 'USDC' ? 'USDC' : 'SOL', leafIndex: leaf };
}

/** A counter read back through `get`: Upstash hands back a number, the dev shim whatever was stored. */
export function counterValue(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// The hold on a leaf (relay-to-buyer writes it, contribute-note reads it)
// ---------------------------------------------------------------------------

/**
 * How long a hold on a leaf is exclusive on the clock alone: the reservation
 * window of `/api/contribute-note` (20 minutes). Past it, a hold is taken over
 * only when its holder can be shown unable to deposit (`holdIsLive`).
 */
export const LEAF_HOLD_STALE_MS = 20 * 60 * 1000;

/**
 * # 🚨 THE HARD CEILING ON A PAID HOLD (close-v1 verify round 1)
 *
 * Rule 4 below keeps a hold live while its funded key holds lamports. Without
 * a ceiling that stall had no end: a payer who paid the till DENOM + 1% got
 * DENOM relayed back to its own key and, by never depositing and never
 * emptying the key, held the pool's contribution edge for ever, for about 1%
 * of a denomination plus fees. So did an honest buyer whose tab died between
 * the relay and the deposit. Every default Shield then met reserve's 409.
 *
 * Past this ceiling a hold that has not landed is evictable whatever its key
 * holds, and whether or not that balance can be read. The second tree read in
 * `/api/relay-to-buyer` still protects a deposit that DID land.
 *
 * ⚖️ THE TRADE AT THE BOUND, STATED. A holder whose deposit lands more than
 * the ceiling after its relay, AND after another payer's relay took the leaf
 * over, fills that leaf for the other payer: the other payer confirms it and
 * collects the claim. An honest client proves and sends its deposit within
 * minutes of the relay, so three hours is far past any live session; what it
 * gives up is a tab that dies after the relay and resumes the SAME deposit
 * hours later (the old 20-minute clock gave up a deposit 21 minutes late).
 * In the other direction, one payment now holds the edge for at most the
 * ceiling, and holding it continuously costs a new payment per ceiling:
 * about 1% of a denomination every 3 h (~0.08 SOL a day on the 1 SOL pool),
 * against ~0.72 SOL a day when a paid hold went stale at 20 minutes.
 *
 * `P01_LEAF_HOLD_MAX_MS` sets it, clamped to [20 min, 24 h]; 0, a negative or
 * malformed value is the default. Never off, never unbounded.
 */
export const LEAF_HOLD_MAX_MS_DEFAULT = 3 * 60 * 60 * 1000;
export const LEAF_HOLD_MAX_MS_CAP = 24 * 60 * 60 * 1000;

export function leafHoldMaxMs(): number {
  const raw = Number(process.env.P01_LEAF_HOLD_MAX_MS ?? '');
  if (!Number.isFinite(raw) || raw <= 0) return LEAF_HOLD_MAX_MS_DEFAULT;
  return Math.min(LEAF_HOLD_MAX_MS_CAP, Math.max(LEAF_HOLD_STALE_MS, Math.floor(raw)));
}

/** The hold on a leaf: `<poolKey>:<leaf>` -> the sealed holder. */
export function leafHoldKey(binding: string): string {
  return `p01:relay:contribution-hold:${binding}`;
}

/** The one-shot lock that decides who takes a hold of generation `token`. */
export function leafHoldLockKey(binding: string, token: string): string {
  return `p01:relay:contribution-hold:${binding}:lock:${token}`;
}

export interface LeafHolder {
  /** The payment holding the leaf, so a takeover can delete its binding. */
  s: string;
  /** When the hold was taken, ms. */
  t: number;
  /** This generation's lock token. */
  n: string;
  /**
   * The ephemeral the relay funded for this payment: the key that signs the
   * deposit. Absent on holds written before audit v1 F72.
   */
  e?: string;
}

/**
 * ⛔ THE HOLDER IS SEALED, NEVER STORED IN THE CLEAR.
 *
 * A row keyed by a leaf and holding the payment signature is exactly the
 * leaf-to-buyer join KV-1 removed from this store: a payment signature resolves
 * publicly to the wallet that paid, and the ephemeral is the deposit's signer.
 * The value is AES-256-GCM under a key derived from the float's secret, which a
 * copy of the store does not carry. Pinned by `relayLeafBinding.test.ts` "the
 * row that holds a leaf names no payment signature in the clear".
 */
function holdSealKey(funder: Keypair): Buffer {
  return createHash('sha256')
    .update('p01:relay:contribution-hold:v1\0')
    .update(Buffer.from(funder.secretKey))
    .digest();
}

export function sealHolder(funder: Keypair, holder: LeafHolder): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', holdSealKey(funder), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(holder), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    body.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function unsealHolder(funder: Keypair, raw: unknown): LeafHolder | null {
  try {
    if (typeof raw !== 'string') return null;
    const [v, iv, body, tag] = raw.split('.');
    if (v !== 'v1' || !iv || !body || !tag) return null;
    const decipher = createDecipheriv('aes-256-gcm', holdSealKey(funder), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const text = Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const h = JSON.parse(text) as Partial<LeafHolder>;
    if (typeof h.s !== 'string' || typeof h.t !== 'number' || typeof h.n !== 'string') return null;
    return { s: h.s, t: h.t, n: h.n, ...(typeof h.e === 'string' ? { e: h.e } : {}) };
  } catch {
    return null;
  }
}

/** The float's keypair, the one the hold is sealed under. `null` when unset or unparseable. */
export function holdSealingKeypair(): Keypair | null {
  const raw = process.env.P01_FUNDER_SECRET_KEY?.trim();
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(
      raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw),
    );
  } catch {
    return null;
  }
}

/**
 * # 🚨 A HOLD ENDS WHEN ITS LEAF IS DECIDED, NOT WHEN A CLOCK SAYS (audit v1 F72)
 *
 * The hold used to go stale 20 minutes after the relay, and the payment that
 * took the leaf over deleted the holder's binding. A holder whose deposit was
 * merely SLOW (a proof that took long, a tab reopened later) then landed the
 * treasury's commitment at that leaf, which is the same commitment whoever
 * deposits it, and the stranger who had taken the leaf over confirmed it and
 * collected the claim; the holder was refused for ever. Measured:
 * scratchpad audit-v1-opus/r4-verify1/probe-residual.log, R1.
 *
 * So past the clock a hold is still LIVE while its holder can still deposit:
 * the ephemeral the relay funded still holds lamports. It is dead only when
 * that key is empty, which is what a completed job, a Recover, or a key
 * emptied some other way leaves behind. The caller must then read the tree
 * AGAIN, after this answer: a deposit that landed and swept its residue has an
 * empty key and its leaf on the tree, and only the second read tells the two
 * apart (the tree read is incremental from the chain, not cached).
 *
 * An unreadable balance is LIVE: taking a leaf over on an unknown is the theft
 * this closes. A hold written before `e` existed falls back to the clock.
 *
 * ⚠️ WHAT THIS COSTS, AND ITS BOUND. A holder who keeps lamports on its key
 * keeps the leaf, so a payer who never deposits holds the pool's contribution
 * edge, but no longer than `leafHoldMaxMs()` (3 h by default): past it the
 * hold is dead whatever the key holds. See the ceiling above for the
 * theft-versus-stall trade at that bound.
 */
export async function holdIsLive(
  connection: Connection,
  holder: LeafHolder,
  nowMs: number,
): Promise<boolean> {
  const age = nowMs - holder.t;
  if (age < LEAF_HOLD_STALE_MS) return true;
  if (age >= leafHoldMaxMs()) return false;
  if (!holder.e) return false;
  try {
    return (await connection.getBalance(new PublicKey(holder.e), 'confirmed')) > 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Free reservations (contribute-note reserve), audit v1 F73
// ---------------------------------------------------------------------------

/**
 * Counts free reservations that died without a payment behind them, across
 * every caller, per rolling day. Past `FREE_RESERVATIONS_ABANDONED_LIMIT`, a
 * free reservation stops being exclusive (see `/api/contribute-note`).
 */
export const CONTRIB_ABANDONED_KEY = 'p01:note:contrib-abandoned';
export const CONTRIB_ABANDONED_WINDOW_SECONDS = 86_400;
export const FREE_RESERVATIONS_ABANDONED_LIMIT = 3;
