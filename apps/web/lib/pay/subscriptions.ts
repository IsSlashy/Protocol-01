/**
 * Subscriptions on /pay, the READ side: decode a `SubscriptionVault` account,
 * summarize where a subscription stands in words a subscriber can use, and
 * remember which vaults belong to this browser.
 *
 * ## Why the DECODE half imports (almost) nothing
 *
 * The main web test suite mocks `@solana/web3.js` wholesale for component
 * rendering, so everything decode/summary-side that a test must exercise is
 * pure bytes and bigints. Its one import is the CANONICAL period arithmetic,
 * `packages/merchant-sdk/src/period-math.ts`, pulled in by relative path
 * exactly as `lib/privacy/serviceRegistry.ts` already pulls the specter-sdk
 * decoder: that module deliberately imports nothing, so it costs the bundle
 * nothing and this file cannot drift from the arithmetic every other client is
 * pinned to. Do not port those functions here; a fifth copy is how the mobile
 * "shows ACTIVE forever" bug happens again.
 *
 * The STORE half (bottom of the file) does import: the shared sealed-store
 * machinery and the worker bridge, since L5b encrypted the records. Decode
 * tests are unaffected — only the store functions touch the worker, and they
 * degrade to the v1 cleartext view when none exists.
 *
 * The account DECODER itself now lives in
 * `lib/privacy/pool/subscriptionVaultAccount.ts` (moved verbatim 2026-08-12 so
 * the Worker's vault-recovery scan can decode enumerated vaults without
 * bundling the worker BRIDGE this file imports) and is re-exported below, so
 * every historical import path through this module still works. The
 * three-sizes warning travels with it — read it there before touching any
 * vault read.
 *
 * ## What is deliberately NOT here
 *
 * The license key. It derives from the note secret, which never leaves the
 * pool Worker, and nothing anywhere stores the derived key. `recordSubscription`
 * below accepts only public fields for the same reason: a subscription record
 * is a convenience for drawing the list, never a place a bearer credential
 * could leak from.
 */

import {
  entitlementStatus,
  fundedPeriodsRemaining,
  periodsElapsed,
  periodsPaidFor,
  slotsUntilSubscriptionEnds,
  claimablePeriods,
  NOMINAL_SLOT_MS,
  type EntitlementStatus,
  type VaultPeriodState,
} from '../../../../packages/merchant-sdk/src/period-math';

import { poolRequest } from '../privacy/workerClient';
import {
  openSealedRecords,
  readMap,
  sealRecord,
  StaleWorkerError,
  storeSession,
  writeMap,
  type StoreSession,
} from '../privacy/sealedStore';
import {
  NATIVE_SOL_MINT_BASE58,
  type DecodedSubscriptionVault,
} from '../privacy/pool/subscriptionVaultAccount';
import { licenseServiceTag } from '../privacy/license';

export type { EntitlementStatus, VaultPeriodState };

// ---------------------------------------------------------------------------
// Account decoding + base58 — moved to lib/privacy/pool/subscriptionVaultAccount.ts
// (see the header); re-exported verbatim so no import path changes.
// ---------------------------------------------------------------------------

export {
  NATIVE_SOL_MINT_BASE58,
  NotASubscriptionVaultError,
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  ZK_SHIELDED_PROGRAM_ID_BASE58,
  base58Decode,
  base58Encode,
  bytesToHex,
  decodeSubscriptionVault,
  isBase58Address,
} from '../privacy/pool/subscriptionVaultAccount';
export type { DecodedSubscriptionVault } from '../privacy/pool/subscriptionVaultAccount';

/** The slice of a decoded vault the canonical period arithmetic reads. */
export function toPeriodState(v: DecodedSubscriptionVault): VaultPeriodState {
  return {
    isActive: v.isActive,
    isPaused: v.isPaused,
    startSlot: v.startSlot,
    totalPausedSlots: v.totalPausedSlots,
    intervalSlots: v.intervalSlots,
    claimedPeriods: v.claimedPeriods,
    totalDeposited: v.totalDeposited,
    rate: v.rate,
  };
}

// ---------------------------------------------------------------------------
// Summary: the words the screen says
// ---------------------------------------------------------------------------

export interface SubscriptionSummary {
  status: EntitlementStatus;
  /** Periods the deposit paid for, total. */
  totalPeriods: bigint;
  /** Periods already lived through, clamped to `totalPeriods`. */
  periodsUsed: bigint;
  /** `totalPeriods - periodsUsed`. Time-based: what the subscriber has left. */
  periodsRemaining: bigint;
  /** Periods the merchant has already swept. */
  claimedPeriods: bigint;
  /** Periods the merchant could sweep right now. */
  merchantClaimableNow: bigint;
  /** Periods the merchant can still be paid for, ever. */
  merchantPeriodsUncollected: bigint;
  /**
   * Whole seconds of entitlement left, from the nominal 400 ms slot. Real slots
   * run slower, so this understates; an early estimate is the safe direction.
   * `null` when the clock is not trustworthy (status `unknown`, `paused`,
   * `inactive`).
   */
  secondsRemaining: number | null;
}

/**
 * Everything the UI says about where a subscription stands.
 *
 * The primary numbers are TIME-based (paid periods minus elapsed periods):
 * entitlement runs on the clock whether or not the merchant claims, so
 * "periods remaining" from `claimed_periods` would overstate what the
 * subscriber still has whenever the merchant is slow to collect. The
 * merchant-side counters are carried separately, for the technical detail.
 */
export function summarizeSubscription(
  vault: VaultPeriodState,
  currentSlot: bigint,
): SubscriptionSummary {
  const status = entitlementStatus(vault, currentSlot);
  const totalPeriods = periodsPaidFor(vault);
  const elapsed = periodsElapsed(vault, currentSlot);
  const periodsUsed = status === 'unknown' ? 0n : elapsed < totalPeriods ? elapsed : totalPeriods;
  const periodsRemaining = totalPeriods - periodsUsed;

  let secondsRemaining: number | null = null;
  if (status === 'current') {
    secondsRemaining = Number(
      (slotsUntilSubscriptionEnds(vault, currentSlot) * NOMINAL_SLOT_MS) / 1000n,
    );
  } else if (status === 'ended') {
    secondsRemaining = 0;
  }

  return {
    status,
    totalPeriods,
    periodsUsed,
    periodsRemaining,
    claimedPeriods: vault.claimedPeriods,
    merchantClaimableNow: claimablePeriods(vault, currentSlot),
    merchantPeriodsUncollected: fundedPeriodsRemaining(vault),
    secondsRemaining,
  };
}

/** "about 3 days", "about an hour", "less than a minute". */
export function formatApproxDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 60) return 'less than a minute';
  if (seconds < 3600) {
    const m = Math.round(seconds / 60);
    return m <= 1 ? 'about a minute' : `about ${m} minutes`;
  }
  if (seconds < 172_800) {
    const h = Math.round(seconds / 3600);
    return h <= 1 ? 'about an hour' : `about ${h} hours`;
  }
  return `about ${Math.round(seconds / 86_400)} days`;
}

/** Atomic units to a display string, trailing zeros trimmed. Pure bigint math. */
export function formatAtomic(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

/** Decimals for a vault's mint: SOL is the zero-key sentinel, SPLs are 6 here. */
export function decimalsForVaultMint(tokenMintBase58: string): number {
  return tokenMintBase58 === NATIVE_SOL_MINT_BASE58 ? 9 : 6;
}

/** Display symbol for a vault's mint, same rule the registry helpers use. */
export function symbolForVaultMint(tokenMintBase58: string): string {
  return tokenMintBase58 === NATIVE_SOL_MINT_BASE58 ? 'SOL' : 'USDC';
}

// ---------------------------------------------------------------------------
// Local subscription records
//
// NOT the same contract as `recordPayout` in `lib/privacy/shieldClient.ts`,
// though the gap narrowed on 2026-08-12. A payout record is a convenience:
// wipe it and a rescan re-derives every address. A subscription record used to
// be the ONLY practical enumeration: a private vault's address is seeded on a
// commitment derived from the note secret, which lives in the Worker, so the
// main thread cannot discover vaults it never recorded — and
// `deriveSubscriptionLicenseKey` takes (pool, leafIndex, serviceTag) FROM this
// record. Since #11 landed, `recoverSubscriptions` below re-discovers every
// vault this identity's notes opened straight from the chain (vaultPDA,
// retailer, rate, intervalSlots, pool, leafIndex — hence the license key), so
// a lost record now degrades to a recovery scan that loses only cosmetics
// (serviceName, openTxSig, openedAt). Tracking a vault by address remains the
// escape hatch for a vault whose paying note this identity does not hold.
//
// STORAGE (leak L5b). The v1 store put {vaultPDA, retailer, pool, leafIndex,
// openTxSig} per WALLET PUBKEY in cleartext — (wallet -> note -> vault ->
// merchant), the subscription flavour of the linkage table L5 closed, plus the
// merchant's name. v2 seals records with the shared machinery
// (`lib/privacy/sealedStore.ts`; design header in `shieldClient.ts`), with ONE
// deliberate difference:
//
// SEALED TO THE V1 (LEGACY) ADDRESS, NOT THE ACTIVE ONE — founder-lead ruling
// 2026-08-12. For this store availability outranks the marginal
// confidentiality of passphrase-scoping, because what a lost record costs is
// unrecoverable proof of a purchase the user already paid for. The v1 seed
// exists for every identity forever (it IS the active seed until a passphrase
// is adopted, and stays in the set as `legacy` afterwards), so passphrase
// arm/disarm cannot orphan a record here the way it may orphan a payout or
// spent record — those degrade to a rescan; these degraded to NOTHING when the
// ruling was made. The #11 recovery scan has since made these records
// rebuildable too (minus cosmetics), which is what would eventually permit
// re-keying this store to the active seed — deliberately NOT done in the same
// change, so the sealing flip gets its own review.
//
// THE REGRESSION, STATED PLAINLY: a browser with an intact store but a
// PERMANENTLY lost wallet can read this list today (cleartext) and will not be
// able to after the change — decryption needs a session derived from the
// wallet's signature. It is bounded: without the wallet the license key is
// underivable and the vault untouchable, so what is lost is the ability to SEE
// what one had, not the ability to use it. And a wallet that is merely
// re-imported restores decryption, because the seed is reproducible from its
// signature.
//
// Migration discipline, same as every v2 store: v2 write lands before the v1
// delete in the same synchronous turn; reads UNION the v1 leftovers until they
// are provably empty; no session at all serves the v1 view untouched; a
// sealed write that fails falls back to WRITING v1 rather than dropping the
// record — for this store above all, a worse index beats a lost record.
// ---------------------------------------------------------------------------

/** One subscription, as remembered locally. Public fields ONLY. */
export interface StoredSubscription {
  /** Base58 vault PDA, the record's identity. */
  vaultPDA: string;
  /** Merchant address, base58. */
  retailer: string;
  /** What the license key is scoped to: registry slug, else retailer address. */
  serviceTag: string;
  /** Merchant display name, cosmetic. */
  serviceName?: string;
  /** Pool token symbol, e.g. "SOL". */
  token: string;
  /** Whole-token size of the escrowed note. */
  denomination: number;
  /** Per-period price in atomic units, decimal string. */
  rate: string;
  /** Billing period in slots, decimal string. */
  intervalSlots: string;
  /** The opening transaction, for the explorer link. */
  openTxSig?: string;
  /** Pool PDA the note came from, base58. */
  pool?: string;
  /** Leaf index of the spent note. */
  leafIndex?: number;
  /** `Date.now()` when recorded. */
  openedAt: number;
}

const SUB_STORE_KEY = 'p01_pay_subscriptions_v2';
/** The pre-L5b store, keyed by wallet pubkey. Read as fallback forever;
 *  written only when the sealed write fails. */
const SUB_STORE_KEY_V1 = 'p01_pay_subscriptions_v1';

/** Field-by-field copy on purpose: whatever else the caller's object carries
 *  (a license key, say) never reaches storage — the same discipline the
 *  worker's whitelist applies on the way back out. */
function cleanRecord(rec: StoredSubscription): StoredSubscription {
  const clean: StoredSubscription = {
    vaultPDA: rec.vaultPDA,
    retailer: rec.retailer,
    serviceTag: rec.serviceTag,
    token: rec.token,
    denomination: rec.denomination,
    rate: rec.rate,
    intervalSlots: rec.intervalSlots,
    openedAt: rec.openedAt,
  };
  if (rec.serviceName !== undefined) clean.serviceName = rec.serviceName;
  if (rec.openTxSig !== undefined) clean.openTxSig = rec.openTxSig;
  if (rec.pool !== undefined) clean.pool = rec.pool;
  if (rec.leafIndex !== undefined) clean.leafIndex = rec.leafIndex;
  return clean;
}

/** Seal one record. `legacyAddress`, NOT `address` — see the header above. */
function sealSubscription(session: StoreSession, rec: StoredSubscription): string {
  return sealRecord(session.legacyAddress, {
    p01store: 1,
    kind: 'subscription',
    ...cleanRecord(rec),
  });
}

/**
 * Seal one wallet's v1 records into the v2 store and delete the v1 bucket.
 * Same fund-safety order as every other migration: v2 write lands BEFORE the
 * v1 delete, in the same synchronous turn, so a throw leaves v1 intact and
 * the union reads below still serve it.
 */
function migrateSubscriptionStore(session: StoreSession, walletPubkey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const old = readMap<StoredSubscription>(SUB_STORE_KEY_V1);
    const mine = old[walletPubkey];
    if (!mine || mine.length === 0) return;
    const all = readMap<string>(SUB_STORE_KEY);
    const list = all[session.label] ?? [];
    for (const rec of mine) list.push(sealSubscription(session, rec));
    all[session.label] = list;
    writeMap(SUB_STORE_KEY, all);
    delete old[walletPubkey];
    writeMap(SUB_STORE_KEY_V1, old);
  } catch {
    // Quota or private-mode failure: the fallback read below still serves v1.
  }
}

/** Decrypt this label's sealed records in the worker. */
async function openSubscriptions(
  meta: string,
  session: StoreSession,
): Promise<{ records: StoredSubscription[]; opened: number; staleWorker: boolean }> {
  const blobs = readMap<string>(SUB_STORE_KEY)[session.label] ?? [];
  if (blobs.length === 0) return { records: [], opened: 0, staleWorker: false };
  const res = await openSealedRecords(meta, blobs);
  // A version-skewed worker (tab open across a deploy) answers WITHOUT the
  // `subscriptions` array — it predates the kind and filed our blobs under
  // `skipped`. The blobs stay intact either way and a fresh worker reads them
  // again; what must NOT happen is the absence reading as "no records", so
  // `staleWorker` carries the distinction out. The early return above means
  // the flag can never be raised for a genuinely empty store. See
  // sealedStore.SealedRecordsAnswer for the presence contract.
  //
  // `opened` is how many blobs the snapshot held. Any caller that REWRITES the
  // bucket after this await must carry everything past that index over — see
  // the tail-preservation note in `recordSubscription` — and must not rewrite
  // AT ALL under `staleWorker`, which blinds the whole snapshot, not a tail.
  return {
    records: (res.subscriptions ?? []).map((r) => cleanRecord(r)),
    opened: blobs.length,
    staleWorker: res.subscriptions === undefined,
  };
}

/**
 * Rewrite this label's bucket from `keep`, preserving anything appended while
 * the worker round trip was in flight.
 *
 * 🚨 THE BUG THIS EXISTS TO PREVENT. `openSubscriptions` awaits the worker, and
 * both writers below are reachable concurrently — "Track" in SubscriptionsPanel
 * and the per-row "Untrack this vault" are on screen together and neither is
 * disabled while the other runs, and the panels stay mounted across tabs so a
 * subscribe started elsewhere is still in flight. Rewriting the bucket from the
 * pre-await snapshot silently ate whatever landed in between.
 *
 * Appends only ever go to the end, so everything from `opened` onward is
 * untouched by what we opened. The residual race is writer-vs-writer, which can
 * at worst drop a REMOVAL or a replacement — recoverable by re-clicking. Losing
 * a record is not recoverable: this store is the only practical enumeration of
 * a private vault (see the header), so it can only be allowed to fail in the
 * safe direction.
 */
function writeKeptSubscriptions(
  session: StoreSession,
  keep: StoredSubscription[],
  opened: number,
): void {
  const all = readMap<string>(SUB_STORE_KEY);
  const tail = (all[session.label] ?? []).slice(opened);
  const next = [...keep.map((r) => sealSubscription(session, r)), ...tail];
  if (next.length === 0) delete all[session.label];
  else all[session.label] = next;
  writeMap(SUB_STORE_KEY, all);
}

/**
 * Remember a subscription so the list can draw it. Re-recording the same
 * vault replaces the record exactly — the sealed store is opened, filtered on
 * `vaultPDA` and re-sealed, since randomized ciphertext has no equality of
 * its own. Records number in the single digits; the cost is unmeasurable.
 */
export async function recordSubscription(
  meta: string,
  walletPubkey: string,
  rec: StoredSubscription,
): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  try {
    const session = await storeSession(meta);
    migrateSubscriptionStore(session, walletPubkey);
    const { records, opened, staleWorker } = await openSubscriptions(meta, session);
    if (staleWorker) {
      // 🚨 A skew-blinded snapshot must never drive the rewrite: `records` is
      // empty while `opened` covers every blob, so the filter-and-rewrite
      // below would re-seal ONLY the new record and destroy every existing
      // one — the exact records that are "the only pointer to a vault nothing
      // can re-discover" (header above; #11 recovers most of it now, minus
      // cosmetics, but recovery must stay the parachute, not the plan).
      // Append instead: the store is append-only ciphertext anyway, and the
      // read side keeps the LAST record per vault, so the replace semantics
      // land the moment a current worker opens the bucket.
      const all = readMap<string>(SUB_STORE_KEY);
      const list = all[session.label] ?? [];
      list.push(sealSubscription(session, rec));
      all[session.label] = list;
      writeMap(SUB_STORE_KEY, all);
    } else {
      const keep = records.filter((r) => r.vaultPDA !== rec.vaultPDA);
      keep.push(cleanRecord(rec));
      writeKeptSubscriptions(session, keep, opened);
    }
  } catch {
    // No session or quota failure. This record is the only pointer to a vault
    // nothing can re-discover (see the header), so dropping it silently is the
    // one unacceptable outcome; the v1 store is the last resort, and every
    // read path still unions it.
    try {
      const clean = cleanRecord(rec);
      const all = readMap<StoredSubscription>(SUB_STORE_KEY_V1);
      const list = (all[walletPubkey] ?? []).filter((r) => r.vaultPDA !== clean.vaultPDA);
      list.push(clean);
      all[walletPubkey] = list;
      writeMap(SUB_STORE_KEY_V1, all);
    } catch {
      // Quota failure on both. The vault is still on chain and still
      // trackable by address — but only if the user kept the address.
    }
  }
  announceSubscriptionsChanged();
}

/**
 * Name of the event a writer raises so an already-rendered list can catch up.
 *
 * WHY IT EXISTS. Visited panels are no longer unmounted, only hidden with CSS,
 * so a progress bar survives a tab switch. The cost is that a panel which reads
 * its data once on mount now reads it once per SESSION: a subscription opened
 * on the Subscribe tab never reached the Subscriptions list, which had already
 * loaded an empty one and had no reason to look again. Measured on the founder's
 * second subscription.
 *
 * A `storage` event would not do: the browser fires it in OTHER documents, never
 * in the one that wrote. This covers the same document; the `storage` listener
 * next to it covers a second tab.
 */
export const SUBSCRIPTIONS_CHANGED_EVENT = 'p01:subscriptions-changed';

function announceSubscriptionsChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(SUBSCRIPTIONS_CHANGED_EVENT));
  } catch {
    // An environment without CustomEvent is not worth failing a write over.
  }
}

/**
 * This wallet's recorded subscriptions, newest first. `meta: null` (no
 * session yet) serves the v1 cleartext view, so pre-L5b records never
 * disappear — and neither does their contribution to `knownSpentNoteKeys`,
 * which is what keeps a subscribed note out of the pickers.
 *
 * `staleWorker: true` means a version-skewed worker could not open the sealed
 * records: `records` is missing every sealed one, and the caller must say so
 * (one reload heals it) instead of painting the shortfall as an empty list. A
 * missing session is NOT skew — nothing migrated, v1 serves in full.
 */
export async function loadSubscriptions(
  meta: string | null,
  walletPubkey: string,
): Promise<{ records: StoredSubscription[]; staleWorker: boolean }> {
  let sealed: StoredSubscription[] = [];
  let staleWorker = false;
  if (meta) {
    try {
      const session = await storeSession(meta);
      migrateSubscriptionStore(session, walletPubkey);
      ({ records: sealed, staleWorker } = await openSubscriptions(meta, session));
    } catch {
      // No worker session: the v1 leftovers below still serve.
    }
  }
  // Read v1 AFTER the migration above, so a migrated row is not counted twice.
  const left = readMap<StoredSubscription>(SUB_STORE_KEY_V1)[walletPubkey] ?? [];
  const byVault = new Map<string, StoredSubscription>();
  // Sealed records: LAST write wins. Append order is chronological, and the
  // stale-append path in `recordSubscription` relies on the newest append
  // being the one that counts for its replace semantics.
  for (const rec of sealed) byVault.set(rec.vaultPDA, rec);
  // v1 leftovers only fill vaults the sealed store does not know.
  for (const rec of left) {
    if (!byVault.has(rec.vaultPDA)) byVault.set(rec.vaultPDA, rec);
  }
  return { records: [...byVault.values()].sort((a, b) => b.openedAt - a.openedAt), staleWorker };
}

/**
 * Drop one record. The vault itself is untouched; this forgets, not closes.
 * The v1 bucket is filtered too, unconditionally: a leftover record there
 * must not resurrect a row the user just dismissed.
 */
export async function forgetSubscription(
  meta: string,
  walletPubkey: string,
  vaultPDA: string,
): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  try {
    const old = readMap<StoredSubscription>(SUB_STORE_KEY_V1);
    if (old[walletPubkey]?.length) {
      old[walletPubkey] = old[walletPubkey]!.filter((r) => r.vaultPDA !== vaultPDA);
      if (old[walletPubkey]!.length === 0) delete old[walletPubkey];
      writeMap(SUB_STORE_KEY_V1, old);
    }
  } catch {
    // Same contract as recordSubscription.
  }
  try {
    const session = await storeSession(meta);
    migrateSubscriptionStore(session, walletPubkey);
    const { records, opened, staleWorker } = await openSubscriptions(meta, session);
    // 🚨 Same guard as `recordSubscription`: under a skew-blinded snapshot the
    // rewrite would delete every sealed record, not the one row. The forget
    // stays one click away — from a reloaded tab, which the panel's stale
    // notice is already asking for.
    if (!staleWorker) {
      writeKeptSubscriptions(
        session,
        records.filter((r) => r.vaultPDA !== vaultPDA),
        opened,
      );
    }
  } catch {
    // No session: the sealed record stays and the row with it. The forget is
    // still one click away next session.
  }
  announceSubscriptionsChanged();
}

// ---------------------------------------------------------------------------
// Recovery (#11) — rebuild the records from the chain, so the store above is
// a cache rather than the only pointer to a paid-for vault.
// ---------------------------------------------------------------------------

/** A registry listing, reduced to the strings recovery needs. Plain strings on
 *  purpose: this module stays free of web3 imports (see the header), so the
 *  caller converts its `ServiceEntry` keys with `.toBase58()`. */
export interface RecoverServiceEntry {
  /** Registry slug — the string a license key is scoped to. */
  slug: string;
  /** Display name, cosmetic. */
  name?: string;
  /** Payment recipient, base58 — the join key to a vault. */
  retailer: string;
  /** Mint of the listing, base58; `NATIVE_SOL_MINT_BASE58` for SOL. A retailer
   *  may list a SOL plan and an SPL plan, so the join is (retailer, mint). */
  tokenMint?: string;
}

export interface RecoverSubscriptionsResult {
  /** Records newly written by this call, in wire order. */
  recovered: StoredSubscription[];
  /** Vaults the scan found that this browser already tracked (left untouched,
   *  so their cosmetics — serviceName, openTxSig, openedAt — survive). */
  alreadyTracked: number;
  /** SubscriptionVault accounts the program-wide enumeration returned —
   *  everyone's, not this wallet's. Context for the caller's messaging. */
  vaultsScanned: number;
}

/**
 * Find this identity's subscription vaults on chain and record the ones this
 * browser forgot. The scan itself runs in the Worker
 * (`lib/privacy/pool/subscriptionRecovery.ts` — its header carries the leak
 * analysis: ONE program-wide enumeration, never a per-note probe), because the
 * note secrets the matching needs must not leave it; only whitelisted public
 * fields come back.
 *
 * `blobs` are the encrypted note blobs from local storage — optional, but a
 * RECEIVED note's secrets exist only there, so without them a subscription
 * paid with a received note cannot be recovered. `services` resolves each
 * vault's registry slug into the serviceTag the license key is scoped to;
 * without a match the tag falls back to the retailer address, exactly as
 * `licenseServiceTag` defines and as the subscribe path would have written.
 *
 * A vault already tracked is NOT overwritten: the recovered record carries no
 * cosmetics, and replacing a richer record with a sparser one would turn a
 * recovery into a small loss.
 */
export async function recoverSubscriptions(
  meta: string,
  walletPubkey: string,
  opts: { blobs?: string[]; services?: RecoverServiceEntry[] } = {},
): Promise<RecoverSubscriptionsResult> {
  let res;
  try {
    res = await poolRequest({ kind: 'poolRecoverSubscriptions', meta, blobs: opts.blobs });
  } catch (e) {
    // A worker so old it predates the handler rejects with the dispatcher's
    // "Unknown pool request". That is version skew, not a scan result — say so
    // in the user's words rather than surfacing dispatcher internals.
    if (/unknown pool request/i.test((e as Error).message ?? '')) throw new StaleWorkerError();
    throw e;
  }
  // A version-skewed worker that knows the handler but answers without the
  // field would be the same condition. This must THROW, not read as "nothing
  // found": the panel turns an empty result into "no open subscription vault
  // on chain belongs to this wallet's notes", which would be a false claim —
  // the worker never scanned for this page's benefit at all.
  const wire = (res as Partial<typeof res>).subscriptions;
  if (wire === undefined) throw new StaleWorkerError();
  const vaultsScanned = res.vaultsScanned ?? 0;
  if (wire.length === 0) return { recovered: [], alreadyTracked: 0, vaultsScanned };

  const known = new Set(
    (await loadSubscriptions(meta, walletPubkey)).records.map((r) => r.vaultPDA),
  );
  const services = opts.services ?? [];

  const recovered: StoredSubscription[] = [];
  let alreadyTracked = 0;
  for (const w of wire) {
    if (known.has(w.vaultPDA)) {
      alreadyTracked += 1;
      continue;
    }
    // (retailer, mint) join, the same rule the panel's `serviceForVault`
    // applies — one retailer may list a SOL and an SPL plan.
    const svc =
      services.find(
        (s) => s.retailer === w.retailer && (s.tokenMint === undefined || s.tokenMint === w.tokenMint),
      ) ?? null;
    const rec: StoredSubscription = {
      vaultPDA: w.vaultPDA,
      retailer: w.retailer,
      serviceTag: licenseServiceTag(svc?.slug ?? null, w.retailer),
      token: w.token,
      denomination: w.denomination,
      rate: w.rate,
      intervalSlots: w.intervalSlots,
      pool: w.pool,
      leafIndex: w.leafIndex,
      // The one unrecoverable non-cosmetic-looking field, and it IS cosmetic:
      // it only orders the list. The recovery moment is the honest value.
      openedAt: Date.now(),
    };
    if (svc?.name !== undefined) rec.serviceName = svc.name;
    await recordSubscription(meta, walletPubkey, rec);
    known.add(w.vaultPDA);
    recovered.push(rec);
  }
  return { recovered, alreadyTracked, vaultsScanned };
}
