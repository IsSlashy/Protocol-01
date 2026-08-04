/**
 * Subscriptions on /pay, the READ side: decode a `SubscriptionVault` account,
 * summarize where a subscription stands in words a subscriber can use, and
 * remember which vaults belong to this browser.
 *
 * ## Why this module imports (almost) nothing
 *
 * The main web test suite mocks `@solana/web3.js` wholesale for component
 * rendering, so everything here that a test must exercise is pure bytes and
 * bigints. The one import is the CANONICAL period arithmetic,
 * `packages/merchant-sdk/src/period-math.ts`, pulled in by relative path
 * exactly as `lib/privacy/serviceRegistry.ts` already pulls the specter-sdk
 * decoder: that module deliberately imports nothing, so it costs the bundle
 * nothing and this file cannot drift from the arithmetic every other client is
 * pinned to. Do not port those functions here; a fifth copy is how the mobile
 * "shows ACTIVE forever" bug happens again.
 *
 * ## The vault account comes in THREE sizes. Never read it by a LEN.
 *
 * Live devnet vaults are 263 bytes (created before `client_stealth_meta`),
 * 328 bytes (before `license_commitment`) or 361 bytes (current). Worse, the
 * allocation reserves every `Option` at its `Some` size while Borsh writes the
 * compact form, so the serialized content is SHORTER than the account and the
 * tail is zero padding. The only correct read is sequential: walk the tag
 * bytes, guard every access against `data.length`, and let a truncated or
 * zero-padded tail decode as `None`. This mirrors
 * `apps/mobile/services/subscriptionVault/index.ts:fetchVault` and was checked
 * against the real 361-byte vault 7WaBm7Kq5WDYa5ykFgaUes1ZCXHXqkyfquJEkmBxzyqw
 * on devnet (2026-08-05).
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

export type { EntitlementStatus, VaultPeriodState };

// ---------------------------------------------------------------------------
// Constants pinned to the chain
// ---------------------------------------------------------------------------

/**
 * `zk_shielded` on devnet, as a string so this module stays free of web3
 * imports. Must match `ZK_SHIELDED_PROGRAM_ID` in
 * `lib/privacy/pool/denominatedPool.ts:83`; the decoder test pins the account
 * fixture fetched from this program.
 */
export const ZK_SHIELDED_PROGRAM_ID_BASE58 = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

/**
 * Anchor account discriminator: `sha256("account:SubscriptionVault")[..8]`.
 * Hardcoded so decoding costs no hash; the test recomputes it independently.
 */
export const SUBSCRIPTION_VAULT_DISCRIMINATOR = new Uint8Array([
  0x60, 0x5a, 0xf7, 0xca, 0x9d, 0x10, 0x56, 0xbe,
]);

/** The mint field a native-SOL vault carries: the system program, 32 zero bytes. */
export const NATIVE_SOL_MINT_BASE58 = '11111111111111111111111111111111';

// ---------------------------------------------------------------------------
// Base58 (self-contained, so display needs no web3 PublicKey)
// ---------------------------------------------------------------------------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INV: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]!] = i;
  return m;
})();

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58_INV[s[i]!];
    if (v === undefined) throw new Error(`invalid base58 character: ${s[i]}`);
    let carry = v;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 58;
      digits[j] = carry % 256;
      carry = (carry / 256) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 256);
      carry = (carry / 256) | 0;
    }
  }
  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) out[zeros + i] = digits[digits.length - 1 - i]!;
  return out;
}

/** Whether `s` is a plausible Solana address: base58 decoding to 32 bytes. */
export function isBase58Address(s: string): boolean {
  try {
    return base58Decode(s.trim()).length === 32;
  } catch {
    return false;
  }
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Account decoding
// ---------------------------------------------------------------------------

/** Thrown when the bytes are not a `SubscriptionVault` account. */
export class NotASubscriptionVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotASubscriptionVaultError';
  }
}

export interface DecodedSubscriptionVault {
  /** Set only on LEGACY normal-mode vaults; no live instruction writes it. */
  subscriberPubkey: string | null;
  /** The commitment the PDA is seeded on (private mode). */
  subscriberCommitment: Uint8Array | null;
  /** Merchant who claims each period, base58. */
  retailer: string;
  /** `NATIVE_SOL_MINT_BASE58` for SOL vaults. */
  tokenMint: string;
  totalDeposited: bigint;
  rate: bigint;
  intervalSlots: bigint;
  startSlot: bigint;
  claimedPeriods: bigint;
  isActive: boolean;
  isPaused: boolean;
  pauseSlot: bigint | null;
  totalPausedSlots: bigint;
  sourcePool: string | null;
  /** `blake3(licenseSecret)`, stored verbatim, verified only off chain. */
  licenseCommitment: Uint8Array | null;
  /** `data.length` of the account: 263, 328 or 361 on devnet today. */
  accountLen: number;
}

/** Sequential little-endian reader with hard bounds. */
class ByteReader {
  private off = 0;
  constructor(private readonly data: Uint8Array) {}
  get offset(): number {
    return this.off;
  }
  get remaining(): number {
    return this.data.length - this.off;
  }
  private need(n: number, what: string): void {
    if (this.off + n > this.data.length) {
      throw new NotASubscriptionVaultError(
        `account truncated: needed ${n} byte(s) for ${what} at offset ${this.off}, ` +
          `have ${this.data.length}`,
      );
    }
  }
  u8(what: string): number {
    this.need(1, what);
    return this.data[this.off++]!;
  }
  bytes(n: number, what: string): Uint8Array {
    this.need(n, what);
    const out = this.data.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  u64(what: string): bigint {
    const b = this.bytes(8, what);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }
  i64(what: string): bigint {
    const u = this.u64(what);
    return u >= 1n << 63n ? u - (1n << 64n) : u;
  }
}

/**
 * Decode a `SubscriptionVault` account's data.
 *
 * Layout: `programs/zk_shielded/src/state/subscription_vault.rs`. Fields up to
 * and including `vk_hash_subscriber` and `source_pool` exist in every vault
 * generation; `bump`, `client_stealth_meta` and `license_commitment` are read
 * softly because a 263-byte vault ends early and zero padding must decode as
 * `None`, never as garbage.
 */
export function decodeSubscriptionVault(data: Uint8Array): DecodedSubscriptionVault {
  if (data.length < 8) {
    throw new NotASubscriptionVaultError(`account data is ${data.length} bytes, no discriminator`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== SUBSCRIPTION_VAULT_DISCRIMINATOR[i]) {
      throw new NotASubscriptionVaultError(
        'account discriminator does not match SubscriptionVault, this address holds something else',
      );
    }
  }

  const r = new ByteReader(data.slice(8));

  const subscriberPubkey =
    r.u8('subscriber_pubkey tag') === 1 ? base58Encode(r.bytes(32, 'subscriber_pubkey')) : null;
  const subscriberCommitment =
    r.u8('subscriber_commitment tag') === 1 ? r.bytes(32, 'subscriber_commitment') : null;
  const retailer = base58Encode(r.bytes(32, 'retailer'));
  const tokenMint = base58Encode(r.bytes(32, 'token_mint'));
  const totalDeposited = r.u64('total_deposited');
  const rate = r.u64('rate');
  const intervalSlots = r.u64('interval_slots');
  const startSlot = r.i64('start_slot');
  const claimedPeriods = r.u64('claimed_periods');
  const isActive = r.u8('is_active') === 1;
  const isPaused = r.u8('is_paused') === 1;
  const pauseSlot = r.u8('pause_slot tag') === 1 ? r.i64('pause_slot') : null;
  const totalPausedSlots = r.i64('total_paused_slots');
  r.bytes(32, 'vk_hash_subscriber');
  const sourcePool = r.u8('source_pool tag') === 1 ? base58Encode(r.bytes(32, 'source_pool')) : null;

  // Soft region. A 263-byte account may end anywhere in here, and what is left
  // of the allocation is zero padding, whose tag bytes read as None.
  if (r.remaining >= 1) r.u8('bump');
  let stealthTagWasSome = false;
  if (r.remaining >= 1) stealthTagWasSome = r.u8('client_stealth_meta tag') === 1;
  if (stealthTagWasSome && r.remaining >= 64) r.bytes(64, 'client_stealth_meta');
  let licenseCommitment: Uint8Array | null = null;
  if (r.remaining >= 1 && r.u8('license_commitment tag') === 1 && r.remaining >= 32) {
    licenseCommitment = r.bytes(32, 'license_commitment');
  }

  return {
    subscriberPubkey,
    subscriberCommitment,
    retailer,
    tokenMint,
    totalDeposited,
    rate,
    intervalSlots,
    startSlot,
    claimedPeriods,
    isActive,
    isPaused,
    pauseSlot,
    totalPausedSlots,
    sourcePool,
    licenseCommitment,
    accountLen: data.length,
  };
}

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
// Same contract as `recordPayout` in `lib/privacy/shieldClient.ts`: a
// CONVENIENCE for drawing the list without an on-chain sweep, public values
// only, and losing the store loses nothing the chain does not still hold. It
// is also the only practical enumeration: a private vault's address is seeded
// on a commitment derived from the note secret, which lives in the Worker, so
// the main thread cannot discover vaults it never recorded. The escape hatch
// for records made elsewhere (or wiped) is tracking a vault by its address.
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

const SUB_STORE_KEY = 'p01_pay_subscriptions_v1';

/**
 * Remember a subscription so the list can draw it. Field-by-field copy on
 * purpose: whatever else the caller's object carries (a license key, say)
 * never reaches storage. Re-recording the same vault replaces the record.
 */
export function recordSubscription(walletPubkey: string, rec: StoredSubscription): void {
  if (typeof localStorage === 'undefined') return;
  try {
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

    const all = readSubStore();
    const list = (all[walletPubkey] ?? []).filter((r) => r.vaultPDA !== clean.vaultPDA);
    list.push(clean);
    all[walletPubkey] = list;
    localStorage.setItem(SUB_STORE_KEY, JSON.stringify(all));
    announceSubscriptionsChanged();
  } catch {
    // Quota or private-mode failure. The vault is still on chain and still
    // trackable by address, so this loss is cosmetic.
  }
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

/** This wallet's recorded subscriptions, newest first. */
export function loadSubscriptions(walletPubkey: string): StoredSubscription[] {
  const list = readSubStore()[walletPubkey] ?? [];
  return [...list].sort((a, b) => b.openedAt - a.openedAt);
}

/** Drop one record. The vault itself is untouched; this forgets, not closes. */
export function forgetSubscription(walletPubkey: string, vaultPDA: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = readSubStore();
    const list = (all[walletPubkey] ?? []).filter((r) => r.vaultPDA !== vaultPDA);
    all[walletPubkey] = list;
    localStorage.setItem(SUB_STORE_KEY, JSON.stringify(all));
    announceSubscriptionsChanged();
  } catch {
    // Same contract as recordSubscription.
  }
}

function readSubStore(): Record<string, StoredSubscription[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SUB_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, StoredSubscription[]>)
      : {};
  } catch {
    return {};
  }
}
