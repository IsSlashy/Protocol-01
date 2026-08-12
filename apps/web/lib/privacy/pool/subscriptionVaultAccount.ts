/**
 * `SubscriptionVault` account decoding — the pure-bytes half that used to live
 * at the top of `lib/pay/subscriptions.ts`, moved here (verbatim, 2026-08-12)
 * so the stealth Worker's vault-recovery scan can decode enumerated vault
 * accounts without importing the main-thread store module (which pulls in the
 * worker BRIDGE — a main-thread artifact the worker must not bundle).
 * `lib/pay/subscriptions.ts` re-exports everything here, so every existing
 * import path still works.
 *
 * ## Why this module imports NOTHING
 *
 * The main web test suite mocks `@solana/web3.js` wholesale for component
 * rendering, so everything here is pure bytes and bigints — that is what lets
 * the Subscriptions panel decode a vault fixture in jsdom. Keep it that way:
 * base58 is hand-rolled below precisely so no web3 `PublicKey` is needed to
 * display an address.
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
 */

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
