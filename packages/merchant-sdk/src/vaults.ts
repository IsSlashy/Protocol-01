import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { type MerchantSdkConfig, resolveProgramIds, ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';
import { subscriptionIsCurrent } from './claim';
import { type ServiceScopedOptions, vaultMatchesService } from './service-scope';

/**
 * Default `zk_shielded` program ID (devnet, v0.9.9+ / V4 pool seed).
 *
 * @deprecated Use `MerchantSdkConfig.programIds.zkShielded` instead so
 *   mainnet merchants can supply the correct ID without editing this file.
 *   This constant remains here as a convenience alias for the devnet value.
 */
export const ZK_SHIELDED_PROGRAM_ID = ZK_SHIELDED_PROGRAM_ID_DEVNET;

/**
 * Anchor account discriminator for `SubscriptionVault`
 * (`sha256("account:SubscriptionVault")[..8]`).
 */
export const SUBSCRIPTION_VAULT_DISCRIMINATOR = Buffer.from([
  96, 90, 247, 202, 157, 16, 86, 190,
]);

/**
 * Offset where `retailer: Pubkey` starts within the account body.
 *
 * Borsh serializes `Option<T>` VARIABLE-width: `None` is a single `0` tag byte
 * (NO value bytes), `Some` is a `1` tag byte + `sizeof(T)`. The two leading
 * options — `subscriber_pubkey: Option<Pubkey>` and
 * `subscriber_commitment: Option<[u8;32]>` — are MUTUALLY EXCLUSIVE: exactly one
 * is `Some(33 bytes)` and the other is `None(1 byte)`, in BOTH vault modes:
 *   • normal  : pubkey Some(33) + commitment None(1) = 34
 *   • private : pubkey None(1)  + commitment Some(33) = 34
 * So `retailer` sits at a mode-INVARIANT offset:
 *   8 (disc) + 34 = 42.
 *
 * The old value `74` assumed both options were FIXED 33-byte fields
 * (8 + 33 + 33), which is wrong for Borsh — it read 32 bytes of zero padding
 * for `retailer` on every real account, so the memcmp filter never matched and
 * `listVaultsForRetailer` returned 0 vaults. Verified empirically against 15
 * live devnet vaults (both modes) — `retailer` is valid at 42, all-zero at 74.
 */
export const SUBSCRIPTION_VAULT_RETAILER_OFFSET = 42;

/** PDA seed prefix — `SubscriptionVault::SEED_PREFIX`. */
export const SUBSCRIPTION_VAULT_SEED_PREFIX = Buffer.from('subscription_vault', 'utf8');

/** Decoded `SubscriptionVault` snapshot. */
export interface SubscriptionVaultAccount {
  pda: PublicKey;
  /** `null` in private mode. */
  subscriberPubkey: PublicKey | null;
  /** `null` in normal mode. */
  subscriberCommitment: Uint8Array | null;
  retailer: PublicKey;
  tokenMint: PublicKey;
  totalDeposited: bigint;
  rate: bigint;
  intervalSlots: bigint;
  startSlot: bigint;
  claimedPeriods: bigint;
  isActive: boolean;
  isPaused: boolean;
  pauseSlot: bigint | null;
  totalPausedSlots: bigint;
  vkHashSubscriber: Uint8Array;
  sourcePool: PublicKey | null;
  bump: number;
  /**
   * v1 stealth meta address (`[spending_pub(32) | viewing_pub(32)]`), or `null`
   * for vaults created before the field existed. Appended after `bump`.
   */
  clientStealthMeta: Uint8Array | null;
  /**
   * `license_commitment = blake3(licenseSecret)` (32 bytes), or `null` for
   * vaults created before license keys existed. Appended at the very end. Used
   * by `verifyLicenseKey` to match a presented key without any merchant secret.
   */
  licenseCommitment: Uint8Array | null;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

class VaultReader {
  constructor(
    private readonly buf: Buffer,
    private offset = 0,
  ) {}
  readU8(): number { const v = this.buf.readUInt8(this.offset); this.offset += 1; return v; }
  readU64(): bigint { const v = this.buf.readBigUInt64LE(this.offset); this.offset += 8; return v; }
  readI64(): bigint { const v = this.buf.readBigInt64LE(this.offset); this.offset += 8; return v; }
  readBool(): boolean { return this.readU8() === 1; }
  readPubkey(): PublicKey {
    const pk = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }
  readBytes(n: number): Uint8Array {
    const out = new Uint8Array(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return out;
  }
  // Borsh `Option<T>` is VARIABLE-width: `None` is exactly ONE byte (the `0`
  // tag, no value bytes); `Some` is `1` tag + `sizeof(T)`. The previous decoder
  // advanced past `sizeof(T)` on `None` too (fixed-width), which desynced every
  // field after the first `None` — reading `retailer`/`token_mint` from the
  // wrong offset (zeros). These readers only consume value bytes on `Some`.
  readOptionPubkey(): PublicKey | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    return this.readPubkey();
  }
  readOption32(): Uint8Array | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    return this.readBytes(32);
  }
  readOptionI64(): bigint | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    return this.readI64();
  }
  /** Remaining unread bytes in the buffer. */
  remaining(): number { return this.buf.length - this.offset; }
  /**
   * Read a trailing `Option<[u8; N]>` (Borsh: 1-byte tag, then N bytes if Some).
   *
   * Real vault accounts are init'd at a fixed `space` but Borsh-serialized
   * variable-width, so after the struct body there is trailing ZERO padding.
   * That means even a `None` trailing field is materialized as a `0` tag byte
   * (then zero padding). Legacy accounts written before a field existed simply
   * lack the tag byte — `remaining() < 1` returns `null`. On `Some` we require
   * the full N value bytes to be present.
   */
  readTrailingOptionBytes(n: number): Uint8Array | null {
    if (this.remaining() < 1) return null;
    const tag = this.readU8();
    if (tag === 0) return null; // None — variable-width: no value bytes follow
    if (this.remaining() < n) return null;
    return this.readBytes(n);
  }
}

export function decodeSubscriptionVault(
  data: Buffer | Uint8Array,
  pda: PublicKey,
): SubscriptionVaultAccount {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 8) throw new Error(`vault account data too short: ${buf.length}`);
  const disc = buf.subarray(0, 8);
  if (!disc.equals(SUBSCRIPTION_VAULT_DISCRIMINATOR)) {
    throw new Error(
      `discriminator mismatch: expected ${SUBSCRIPTION_VAULT_DISCRIMINATOR.toString('hex')}, ` +
        `got ${disc.toString('hex')}`,
    );
  }

  const r = new VaultReader(buf, 8);
  const subscriberPubkey = r.readOptionPubkey();
  const subscriberCommitment = r.readOption32();
  const retailer = r.readPubkey();
  const tokenMint = r.readPubkey();
  const totalDeposited = r.readU64();
  const rate = r.readU64();
  const intervalSlots = r.readU64();
  const startSlot = r.readI64();
  const claimedPeriods = r.readU64();
  const isActive = r.readBool();
  const isPaused = r.readBool();
  const pauseSlot = r.readOptionI64();
  const totalPausedSlots = r.readI64();
  const vkHashSubscriber = r.readBytes(32);
  const sourcePool = r.readOptionPubkey();
  const bump = r.readU8();
  // Trailing Option fields, appended in this order on the program side:
  //   client_stealth_meta: Option<[u8; 64]>   (1 tag + 64 value)
  //   license_commitment:  Option<[u8; 32]>   (1 tag + 32 value)
  // Legacy vaults written before each field existed simply lack the trailing
  // bytes; `readTrailingOptionBytes` returns null in that case (same as the
  // program reading trailing zero padding as `None`).
  const clientStealthMeta = r.readTrailingOptionBytes(64);
  const licenseCommitment = r.readTrailingOptionBytes(32);

  return {
    pda,
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
    vkHashSubscriber,
    sourcePool,
    bump,
    clientStealthMeta,
    licenseCommitment,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ListVaultsOptions {
  /** Include vaults whose `is_active` is false. Default: false. */
  includeInactive?: boolean;
  /** Include vaults whose `is_paused` is true. Default: true (they may resume). */
  includePaused?: boolean;
  /** Only return vaults created with the given `token_mint`. */
  tokenMint?: PublicKey;
  /** Commitment. Default `confirmed`. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /**
   * Override the `zk_shielded` program ID directly.
   *
   * @deprecated Prefer passing a full `MerchantSdkConfig` as the `sdkConfig`
   *   option — it supports both program overrides and cluster selection.
   */
  programId?: PublicKey;
  /**
   * SDK-level configuration (cluster + program ID overrides).
   * When provided, `programId` is ignored.
   */
  sdkConfig?: MerchantSdkConfig;
}

/**
 * Fetch every `SubscriptionVault` whose `retailer` field equals the given
 * pubkey — the merchant's whole subscriber book in one call.
 *
 * @deprecated Not for entitlement checks. Use
 *   {@link hasActiveVaultAccessForVault} (or `verifyLicenseAgainstVault`),
 *   which reads ONE account instead of the book. Two reasons, in order:
 *
 *   1. It hydrates every subscriber to answer a question about one of them.
 *      MEASURED against devnet on 2026-08-01, one access check for one
 *      subscriber of a merchant with 4 vaults:
 *
 *        hasActiveVaultAccessForVault  2 calls  309 req B    813 res B  1 account
 *        hasActiveVaultAccess          2 calls  492 req B  2,750 res B  4 accounts
 *
 *      Same call COUNT; what differs is what comes back. The single-account
 *      figure is flat in the number of subscribers, the enumerating one grows
 *      by ~650 response bytes each (raw JSON-RPC: 11,093 B for 17 accounts vs
 *      2,633 B for 4). Every extra account carries the subscriber ID, mint,
 *      deposit, rate, interval and start slot of someone the request was not
 *      about. Pass `currentSlot` and the single-account path drops to 1 call /
 *      733 response bytes.
 *   2. `getProgramAccounts` is unindexed and rate-limited on shared RPC; a
 *      per-request call is a per-request scan of the program's accounts.
 *
 *   It stays exported and supported: reconciling a merchant's books legitimately
 *   needs the whole list. Call it on a schedule, not on a request.
 *
 * NOTE — what deprecating this does NOT do. It does not stop anyone enumerating
 * a merchant's subscribers. `retailer` sits at a fixed offset in a public,
 * unencrypted account, so the same query runs from curl with no SDK at all.
 * VERIFIED on devnet 2026-08-01: a raw JSON-RPC `getProgramAccounts` against
 * `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` — plain `fetch`, no SDK, no
 * auth — filtered only on the account discriminator, returned all 17
 * `SubscriptionVault` accounts then live across 6 distinct retailers; adding
 * the retailer memcmp narrowed it to that merchant's 4, with each subscriber's
 * ID, deposit, rate, interval and start slot in the clear. Deprecating this
 * helper removes CONVENIENCE, not CAPABILITY. The only thing that would remove
 * the capability is not putting the retailer in the clear on chain.
 *
 * Implementation note: the filter uses `SUBSCRIPTION_VAULT_RETAILER_OFFSET`,
 * whose doc explains why the offset is mode-invariant.
 */
export async function listVaultsForRetailer(
  connection: Connection,
  retailer: PublicKey,
  opts: ListVaultsOptions = {},
): Promise<SubscriptionVaultAccount[]> {
  const programId = opts.sdkConfig
    ? resolveProgramIds(opts.sdkConfig).zkShielded
    : (opts.programId ?? ZK_SHIELDED_PROGRAM_ID);
  const commitment = opts.commitment ?? 'confirmed';

  const filters = [
    { memcmp: { offset: 0, bytes: bs58.encode(SUBSCRIPTION_VAULT_DISCRIMINATOR) } },
    { memcmp: { offset: SUBSCRIPTION_VAULT_RETAILER_OFFSET, bytes: retailer.toBase58() } },
  ];

  const accounts = await connection.getProgramAccounts(programId, {
    commitment,
    filters,
  });

  const out: SubscriptionVaultAccount[] = [];
  for (const acc of accounts) {
    let decoded: SubscriptionVaultAccount;
    try {
      decoded = decodeSubscriptionVault(acc.account.data, acc.pubkey);
    } catch {
      continue;
    }
    if (!opts.includeInactive && !decoded.isActive) continue;
    if (opts.includePaused === false && decoded.isPaused) continue;
    if (opts.tokenMint && !decoded.tokenMint.equals(opts.tokenMint)) continue;
    out.push(decoded);
  }

  out.sort((a, b) => Number(a.startSlot - b.startSlot));
  return out;
}

// ---------------------------------------------------------------------------
// Single-account path (the primary one)
// ---------------------------------------------------------------------------

/**
 * Derive the `SubscriptionVault` PDA the program would have created for this
 * (retailer, subscriber, mint) triple:
 * `[b"subscription_vault", retailer, subscriber_id_bytes, token_mint]`
 * (`programs/zk_shielded/src/state/subscription_vault.rs:10`).
 *
 * `subscriberIdBytes` is the subscriber's wallet pubkey (normal mode) or their
 * `subscriber_commitment` (private mode) — the program uses whichever is `Some`.
 *
 * A merchant that already knows those three things does not need the client to
 * present an address and does not need to enumerate anything: derive, then read
 * the one account. VERIFIED against devnet 2026-08-01 before it became a gate —
 * this reproduced the address of every live vault (18 at the time; the count
 * moves as subscriptions land), in both modes, across all three account lengths
 * in use (263 / 328 / 361 bytes).
 */
export function deriveSubscriptionVaultPda(
  retailer: PublicKey,
  subscriberIdBytes: Uint8Array,
  tokenMint: PublicKey,
  opts: { programId?: PublicKey; sdkConfig?: MerchantSdkConfig } = {},
): [PublicKey, number] {
  if (subscriberIdBytes.length !== 32) {
    throw new Error('subscriberIdBytes must be exactly 32 bytes');
  }
  const programId = opts.sdkConfig
    ? resolveProgramIds(opts.sdkConfig).zkShielded
    : (opts.programId ?? ZK_SHIELDED_PROGRAM_ID);
  return PublicKey.findProgramAddressSync(
    [
      SUBSCRIPTION_VAULT_SEED_PREFIX,
      retailer.toBuffer(),
      Buffer.from(subscriberIdBytes),
      tokenMint.toBuffer(),
    ],
    programId,
  );
}

export interface FetchVaultOptions {
  /** Commitment. Default `confirmed`. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Program ID override. Ignored when `sdkConfig` is supplied. */
  programId?: PublicKey;
  /** SDK-level configuration (cluster + program ID overrides). */
  sdkConfig?: MerchantSdkConfig;
}

export type FetchVaultResult =
  | { ok: true; vault: SubscriptionVaultAccount }
  | { ok: false; reason: string };

/**
 * Read ONE `SubscriptionVault` by address and decode it, refusing anything the
 * `zk_shielded` program did not write.
 *
 * ## Why the owner check is not optional
 *
 * `getAccountInfo` returns whatever lives at an address, and an account's bytes
 * are chosen by the program that OWNS it. So an attacker who deploys their own
 * program can create an account holding a perfectly-formed vault body — right
 * discriminator, the victim merchant in the `retailer` field, a
 * `license_commitment` whose preimage they picked, a start slot and deposit
 * that make the subscription look current — and hand its address to the
 * merchant. Without `owner == zk_shielded` every field checked afterwards is
 * attacker-chosen and the check proves nothing.
 *
 * `verifyLicenseAgainstVault` did exactly that until this existed: it called
 * `connection.getAccountInfo` and went straight to decoding. It is enforced
 * here, once, rather than left to each caller, because a
 * client-presents-its-address flow takes on this risk by construction.
 */
export async function fetchVaultByAddress(
  connection: Connection,
  vaultPda: PublicKey,
  opts: FetchVaultOptions = {},
): Promise<FetchVaultResult> {
  const programId = opts.sdkConfig
    ? resolveProgramIds(opts.sdkConfig).zkShielded
    : (opts.programId ?? ZK_SHIELDED_PROGRAM_ID);

  const info = await connection.getAccountInfo(vaultPda, opts.commitment ?? 'confirmed');
  if (!info) return { ok: false, reason: 'vault not found' };
  if (!info.owner.equals(programId)) {
    return {
      ok: false,
      reason:
        `account ${vaultPda.toBase58()} is owned by ${info.owner.toBase58()}, not the zk_shielded ` +
        `program ${programId.toBase58()} — its contents are written by whoever owns it, so nothing ` +
        `in them can be trusted`,
    };
  }
  try {
    return { ok: true, vault: decodeSubscriptionVault(info.data, vaultPda) };
  } catch (e) {
    return { ok: false, reason: `vault decode failed: ${(e as Error).message}` };
  }
}

export interface VaultAccessCheckOptions extends FetchVaultOptions, ServiceScopedOptions {
  /** Slot to evaluate against. Fetched when omitted. */
  currentSlot?: bigint;
}

/**
 * The non-enumerating entitlement check: given the address of ONE vault, say
 * whether it currently entitles `subscriberIdBytes` to service from `retailer`.
 *
 * This is the companion to {@link hasActiveVaultAccess} and the form merchants
 * should reach for. It reads a single account instead of the merchant's whole
 * subscriber book, and it applies the same {@link subscriptionIsCurrent} gate —
 * NOT `is_active`, which the program writes `true` at subscribe time and `false`
 * nowhere, so an exhausted vault reports `true` forever. MEASURED on devnet
 * 2026-08-01: of the 18 live `SubscriptionVault` accounts, 14 had run past the
 * periods they were funded for, and all 18 reported `is_active: true`. Gating
 * on that flag would have served every one of the 14.
 *
 * The client supplies `vaultPda` (from its own subscription receipt), or the
 * merchant derives it with {@link deriveSubscriptionVaultPda} and never asks.
 *
 * ## What is checked, in order
 *
 *  1. the account is owned by `zk_shielded` — see {@link fetchVaultByAddress};
 *  2. it carries the `SubscriptionVault` discriminator and decodes;
 *  3. `vault.retailer` is `retailer`, so another merchant's vault cannot pass;
 *  4. the vault sits at the canonical PDA for (retailer, subscriber, mint), so
 *     the presented address is the one the program would have created;
 *  5. the vault's subscriber ID is `subscriberIdBytes`;
 *  6. `subscriptionIsCurrent` at `currentSlot`;
 *  7. `opts.service`, when supplied.
 *
 * ## Steps 1-6 prove the account is real, not that you sold it
 *
 * `subscribe_normal` is permissionless. `retailer` is an unsigned `AccountInfo`
 * carrying `/// CHECK: Any pubkey can be a retailer`, and `rate`,
 * `interval_slots` and `amount` are instruction arguments with only `> 0`
 * required of each. So anyone can have the program write a genuine vault, at
 * the canonical PDA, naming any merchant, funded with ONE lamport at one
 * lamport per period, with an interval long enough that `periodsElapsed` never
 * reaches `periodsPaidFor`. Steps 1-6 all pass on it — nothing there is forged.
 * It is granted access.
 *
 * Step 7 is the only step that refuses it, because only the registry knows what
 * the merchant charges. Treat `opts.service` as required in production, not as
 * a multi-product convenience: without it this function answers "does a vault
 * naming you exist and is it inside a period someone paid for", which a
 * stranger can arrange for a lamport. `src/self-minted-vault.test.ts` pins both
 * directions.
 *
 * Ambiguous scopes (two of the merchant's services indistinguishable on chain)
 * are ACCEPTED here, because the return type has nowhere to report the
 * ambiguity. Use `verifyLicenseAgainstVault`, which returns
 * `ambiguousService: true`, when the caller needs to know.
 *
 * @returns the vault when access is granted, `null` otherwise.
 */
export async function hasActiveVaultAccessForVault(
  connection: Connection,
  vaultPda: PublicKey,
  retailer: PublicKey,
  subscriberIdBytes: Uint8Array,
  opts: VaultAccessCheckOptions = {},
): Promise<SubscriptionVaultAccount | null> {
  if (subscriberIdBytes.length !== 32) {
    throw new Error('subscriberIdBytes must be exactly 32 bytes');
  }

  const [fetched, slot] = await Promise.all([
    fetchVaultByAddress(connection, vaultPda, opts),
    opts.currentSlot !== undefined
      ? Promise.resolve(opts.currentSlot)
      : connection.getSlot(opts.commitment ?? 'confirmed').then(BigInt),
  ]);
  if (!fetched.ok) return null;
  const vault = fetched.vault;

  if (!vault.retailer.equals(retailer)) return null;

  // The vault must be the canonical PDA for this triple. Redundant given the
  // owner + discriminator + field checks, and kept because it is free and pins
  // the address itself rather than only its contents.
  const [derived] = deriveSubscriptionVaultPda(retailer, subscriberIdBytes, vault.tokenMint, opts);
  if (!derived.equals(vaultPda)) return null;

  const idBytes = vault.subscriberPubkey ? vault.subscriberPubkey.toBytes() : vault.subscriberCommitment;
  if (!idBytes || idBytes.length !== 32) return null;
  if (!bytesEqual(idBytes, subscriberIdBytes)) return null;

  if (!subscriptionIsCurrent(vault, slot)) return null;

  if (opts.service) {
    const m = vaultMatchesService(vault, opts.service, { otherServices: opts.otherServices });
    if (!m.matches) return null;
  }
  return vault;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Compute whether a subscriber has a CURRENT subscription granting them access
 * right now. Callers typically derive the subscriber ID from an out-of-band
 * session token and check here.
 *
 * "Current" means the subscriber has paid for the period the subscription is
 * in — see {@link subscriptionIsCurrent}. It deliberately does not mean
 * `is_active`, which the program writes `true` at subscribe time and `false`
 * nowhere, so an exhausted vault reports `true` forever. Before this check
 * existed, a devnet vault with every period claimed and a zero balance was
 * MEASURED granting access (2026-08-01); the merchant had collected everything
 * it would ever collect and was still being told to serve.
 *
 * The function only validates on-chain state; any off-chain mapping between
 * subscriber identities and vault IDs is the merchant's responsibility.
 *
 * @deprecated for per-request use. This is the enumerating form: it calls
 *   {@link listVaultsForRetailer} and scans. Prefer
 *   {@link hasActiveVaultAccessForVault}, which reads the one vault the request
 *   is about — the client presents its address, or the merchant derives it with
 *   {@link deriveSubscriptionVaultPda}. Keep this one for a background sweep
 *   over all subscribers, where the whole book is the point.
 *
 *   The two are not equivalent in strength, and not only in the new form's
 *   favour: this one never has to trust a client-supplied address, but it also
 *   cannot check that the account it matched sits at the canonical PDA, and it
 *   accepts no service scope, so a subscriber to any of the merchant's services
 *   sharing a mint, price and interval passes for all of them.
 */
export async function hasActiveVaultAccess(
  connection: Connection,
  retailer: PublicKey,
  subscriberIdBytes: Uint8Array,
  opts: Omit<ListVaultsOptions, 'includeInactive'> & {
    /** Slot to evaluate against. Fetched when omitted. */
    currentSlot?: bigint;
  } = {},
): Promise<SubscriptionVaultAccount | null> {
  if (subscriberIdBytes.length !== 32) {
    throw new Error('subscriberIdBytes must be exactly 32 bytes');
  }
  const [vaults, slot] = await Promise.all([
    listVaultsForRetailer(connection, retailer, { ...opts, includeInactive: false }),
    opts.currentSlot !== undefined
      ? Promise.resolve(opts.currentSlot)
      : connection.getSlot(opts.commitment ?? 'confirmed').then(BigInt),
  ]);
  for (const v of vaults) {
    if (!subscriptionIsCurrent(v, slot)) continue;
    const idBytes = v.subscriberPubkey
      ? v.subscriberPubkey.toBytes()
      : v.subscriberCommitment;
    if (!idBytes) continue;
    if (idBytes.length !== 32) continue;
    let matches = true;
    for (let i = 0; i < 32; i++) {
      if (idBytes[i] !== subscriberIdBytes[i]) { matches = false; break; }
    }
    if (matches) return v;
  }
  return null;
}
