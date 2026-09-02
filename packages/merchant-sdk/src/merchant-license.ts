import type { Connection, Keypair } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { blake3 } from '@noble/hashes/blake3.js';

import { type MerchantSdkConfig, resolveProgramIds, ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';
import {
  decodeSubscriptionVault,
  deriveSubscriptionVaultPda,
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  SUBSCRIPTION_VAULT_RETAILER_OFFSET,
  type SubscriptionVaultAccount,
} from './vaults';
import { decodeLicenseKey, licenseCommitment, LICENSE_COMMITMENT_BYTES } from './license';
import {
  periodsElapsed,
  periodsPaidFor,
  subscriptionEndSlot,
  subscriptionIsCurrent,
} from './period-math';
import { type ServiceScope, vaultMatchesService } from './service-scope';
import { issueSubscriptionAccessToken, verifyAccessToken } from './access-token';

/**
 * Merchant-side license verification — **verify only what you sold, store
 * nothing.**
 *
 * A customer who pays merchant X a subscription through the protocol receives a
 * `P01-…` license key: a 16-byte bearer secret whose `blake3` image the client
 * posted on the `SubscriptionVault` as `license_commitment`. This module lets X
 * turn that key into an ephemeral account and session with nothing but public
 * chain state and X's own registry facts:
 *
 *   1. {@link findVaultByLicenseKey} — locate the vault from the key ALONE
 *      (`getProgramAccounts` with memcmp on the retailer and on the commitment;
 *      one or two calls), or read one account when the client presents its
 *      address.
 *   2. {@link verifyMerchantLicense} — the fail-closed check. The service scope
 *      is REQUIRED because it is the only thing that refuses a vault a stranger
 *      self-minted at a rate of one atomic unit naming X as retailer
 *      (`src/self-minted-vault.test.ts`), and the only thing that stops a key
 *      sold for X's cheap tier opening X's dear one. Every refusal names its
 *      reason from a closed enum.
 *   3. {@link ephemeralAccountId} — a pseudonymous, per-(merchant, service,
 *      vault, generation) account identifier that is NOT a function of the
 *      key, so a merchant database holding only the id cannot reconstruct the
 *      bearer secret.
 *   4. {@link createEphemeralSession} — the verification plus a signed access
 *      token whose subject is the ephemeral id, clamped to the funded window
 *      and pinned to the vault's `start_slot`. The token is self-contained; the
 *      merchant persists nothing.
 *
 * ## What this closes, and what it does not
 *
 * Closed by construction: D1 (a self-minted decoy naming the merchant) and D3
 * (entitlement escalation across a merchant's services) — both fall on the
 * required scope; a vault at a non-canonical address falls on the PDA
 * re-derivation; an attacker-owned account falls on the owner check.
 *
 * Two limits stay open and are documented, not hidden:
 *
 *   (a) The NOTE ISSUER can derive every license secret from the note secret
 *       (`docs/DEMO-untraceable-subscription.md:194-200`): `licenseSecret` is
 *       `HKDF(masterNoteSecret, serviceId)`, and the treasury that seeded the
 *       note holds `masterNoteSecret`. A v2 derivation mixing a client-side
 *       nonce would close it; it is NOT in this module.
 *   (b) The merchant learns the vault address — public anyway, enumerable by
 *       anyone from the retailer field at offset 42 — and the key is a bearer
 *       secret the customer must guard: whoever holds the string holds the
 *       subscription.
 */

// ---------------------------------------------------------------------------
// Layout: where `license_commitment` sits, derived from the Borsh shape
// ---------------------------------------------------------------------------

/**
 * Which of the five variable-width `Option` fields of a `SubscriptionVault`
 * are `Some`. Borsh writes `None` as ONE tag byte and `Some` as a tag byte plus
 * the value, so the offset of every field after an `Option` depends on it.
 * `license_commitment` is the LAST field, so its offset depends on all five.
 */
export interface VaultOptionShape {
  /** `subscriber_pubkey: Option<Pubkey>` — Some only on legacy wallet-keyed vaults. */
  subscriberPubkey: boolean;
  /** `subscriber_commitment: Option<[u8; 32]>` — Some on every vault the surviving instruction writes. */
  subscriberCommitment: boolean;
  /** `pause_slot: Option<i64>` — Some while the subscriber has the vault paused. */
  pauseSlot: boolean;
  /** `source_pool: Option<Pubkey>` — Some on every vault `subscribe_private_stark{,_v4}` writes (`:476`, `:756`). */
  sourcePool: boolean;
  /** `client_stealth_meta: Option<[u8; 64]>` — None since the parameter was removed; Some on older vaults. */
  clientStealthMeta: boolean;
}

/** Offset of `token_mint` — immediately after `retailer`, mode-invariant for the same reason. */
export const SUBSCRIPTION_VAULT_TOKEN_MINT_OFFSET = SUBSCRIPTION_VAULT_RETAILER_OFFSET + 32;

/**
 * Byte offset of the `license_commitment` Option TAG for a vault of the given
 * shape — computed field by field from the same Borsh layout
 * {@link decodeSubscriptionVault} reads (`subscription_vault.rs`, 18 fields).
 * `src/merchant-license.test.ts` encodes a synthetic vault of every shape used
 * here and asserts the commitment bytes actually sit where this says.
 *
 * On `Some`, the 33 bytes at `[offset, offset + 33)` are `1 ‖ commitment`,
 * which is exactly what the memcmp filter in {@link findVaultByLicenseKey}
 * matches on.
 */
export function licenseCommitmentTagOffset(shape: VaultOptionShape): number {
  const opt = (some: boolean, width: number) => 1 + (some ? width : 0);
  return (
    8 + // Anchor discriminator
    opt(shape.subscriberPubkey, 32) + // subscriber_pubkey: Option<Pubkey>
    opt(shape.subscriberCommitment, 32) + // subscriber_commitment: Option<[u8; 32]>
    32 + // retailer: Pubkey                       (offset 42, mode-invariant)
    32 + // token_mint: Pubkey                     (offset 74)
    8 + // total_deposited: u64
    8 + // rate: u64
    8 + // interval_slots: u64
    8 + // start_slot: i64
    8 + // claimed_periods: u64
    1 + // is_active: bool
    1 + // is_paused: bool
    opt(shape.pauseSlot, 8) + // pause_slot: Option<i64>
    8 + // total_paused_slots: i64
    32 + // vk_hash_subscriber: [u8; 32]
    opt(shape.sourcePool, 32) + // source_pool: Option<Pubkey>
    1 + // bump: u8
    opt(shape.clientStealthMeta, 64) // client_stealth_meta: Option<[u8; 64]>
  ); // → license_commitment: Option<[u8; 32]> tag byte
}

/**
 * The shape every vault the surviving instructions write has at creation:
 * commitment-keyed, `source_pool = Some(pool)`, no stealth meta, not paused
 * (`subscribe_private_stark.rs:462-491`, `subscribe_private_stark_v4.rs:739-766`).
 */
export const LICENSE_LOOKUP_SHAPE_UNPAUSED: VaultOptionShape = Object.freeze({
  subscriberPubkey: false,
  subscriberCommitment: true,
  pauseSlot: false,
  sourcePool: true,
  clientStealthMeta: false,
});

/** The same vault after `pause`: `pause_slot` becomes `Some`, shifting the tail by 8. */
export const LICENSE_LOOKUP_SHAPE_PAUSED: VaultOptionShape = Object.freeze({
  ...LICENSE_LOOKUP_SHAPE_UNPAUSED,
  pauseSlot: true,
});

/**
 * Shapes {@link findVaultByLicenseKey} queries, in order. One
 * `getProgramAccounts` per shape, stopping at the first that returns anything —
 * so a live subscription costs ONE call and a paused one two.
 *
 * MEASURED on devnet 2026-09-02, all 32 live `SubscriptionVault` accounts: the
 * 18 that carry a `license_commitment` all have its tag at offset 224 (this
 * list's first shape); the 2 paused vaults sit at 232 (its second). The 5
 * older vaults with `client_stealth_meta = Some` (tag at 288) and the 2 legacy
 * wallet-keyed ones (192) carry no commitment, so they are not queried by
 * default. Pass `shapes` to widen the search if a redeploy changes what the
 * instruction writes.
 */
export const LICENSE_LOOKUP_SHAPES: readonly VaultOptionShape[] = Object.freeze([
  LICENSE_LOOKUP_SHAPE_UNPAUSED,
  LICENSE_LOOKUP_SHAPE_PAUSED,
]);

/** `licenseCommitmentTagOffset(LICENSE_LOOKUP_SHAPE_UNPAUSED)` — 224 on the live layout. */
export const LICENSE_COMMITMENT_TAG_OFFSET_UNPAUSED = licenseCommitmentTagOffset(LICENSE_LOOKUP_SHAPE_UNPAUSED);
/** `licenseCommitmentTagOffset(LICENSE_LOOKUP_SHAPE_PAUSED)` — 232 on the live layout. */
export const LICENSE_COMMITMENT_TAG_OFFSET_PAUSED = licenseCommitmentTagOffset(LICENSE_LOOKUP_SHAPE_PAUSED);

// ---------------------------------------------------------------------------
// Lookup: the vault from the key alone
// ---------------------------------------------------------------------------

type CommitmentLevel = 'processed' | 'confirmed' | 'finalized';

export interface FindVaultByLicenseKeyParams {
  /** The payout key the vault must name as `retailer`. */
  merchant: PublicKey;
  /** The presented `P01-…` key. */
  key: string;
  /** Narrow the query to vaults denominated in this mint. Recommended: your service's mint. */
  tokenMint?: PublicKey;
  /** Program ID override. Ignored when `sdkConfig` is supplied. */
  programId?: PublicKey;
  /** SDK-level configuration (cluster + program ID overrides). */
  sdkConfig?: MerchantSdkConfig;
  /** Commitment. Default `confirmed`. */
  commitment?: CommitmentLevel;
  /** Vault shapes to query, in order. Default {@link LICENSE_LOOKUP_SHAPES}. */
  shapes?: readonly VaultOptionShape[];
}

export interface LicenseVaultMatch {
  vaultPda: PublicKey;
  vault: SubscriptionVaultAccount;
}

/** The memcmp filters one lookup query sends, for the given shape. Exported for tests. */
export function licenseLookupFilters(input: {
  merchant: PublicKey;
  commitment: Uint8Array;
  tokenMint?: PublicKey;
  shape: VaultOptionShape;
}): { memcmp: { offset: number; bytes: string } }[] {
  if (input.commitment.length !== LICENSE_COMMITMENT_BYTES) {
    throw new Error(`commitment must be ${LICENSE_COMMITMENT_BYTES} bytes, got ${input.commitment.length}`);
  }
  const filters = [
    { memcmp: { offset: 0, bytes: bs58.encode(SUBSCRIPTION_VAULT_DISCRIMINATOR) } },
    { memcmp: { offset: SUBSCRIPTION_VAULT_RETAILER_OFFSET, bytes: input.merchant.toBase58() } },
  ];
  if (input.tokenMint) {
    filters.push({ memcmp: { offset: SUBSCRIPTION_VAULT_TOKEN_MINT_OFFSET, bytes: input.tokenMint.toBase58() } });
  }
  // `Some(commitment)` on the wire is the tag byte 1 followed by the 32 bytes —
  // matching all 33 at once means a `None` tag can never match, whatever the
  // padding after it holds.
  const some = Buffer.concat([Buffer.from([1]), Buffer.from(input.commitment)]);
  filters.push({ memcmp: { offset: licenseCommitmentTagOffset(input.shape), bytes: bs58.encode(some) } });
  return filters;
}

function resolveZkShielded(opts: { programId?: PublicKey; sdkConfig?: MerchantSdkConfig }): PublicKey {
  return opts.sdkConfig
    ? resolveProgramIds(opts.sdkConfig).zkShielded
    : (opts.programId ?? ZK_SHIELDED_PROGRAM_ID_DEVNET);
}

/**
 * Every vault naming `merchant` whose `license_commitment` is the blake3 image
 * of the presented key. Normally zero or one; more than one means someone put
 * the same (public) commitment on another vault — a self-minted decoy carrying
 * a real subscriber's commitment, say — which is why
 * {@link verifyMerchantLicense} judges every match rather than the first.
 *
 * Cost: one `getProgramAccounts` per shape in `shapes`, stopping at the first
 * that returns anything; at most `shapes.length` calls (two by default).
 *
 * @throws on a malformed key — that is caller input, not chain state.
 */
export async function findVaultsByLicenseKey(
  connection: Connection,
  params: FindVaultByLicenseKeyParams,
): Promise<LicenseVaultMatch[]> {
  const { key, commitment, ...rest } = params;
  const wantCommitment = licenseCommitment(decodeLicenseKey(key));
  return findVaultsByCommitment(connection, { ...rest, wantCommitment, level: commitment });
}

interface FindByCommitmentParams {
  merchant: PublicKey;
  /** `blake3(secret)` — the 32 bytes to match at the commitment slot. */
  wantCommitment: Uint8Array;
  tokenMint?: PublicKey;
  programId?: PublicKey;
  sdkConfig?: MerchantSdkConfig;
  /** RPC commitment level. */
  level?: CommitmentLevel;
  shapes?: readonly VaultOptionShape[];
}

async function findVaultsByCommitment(
  connection: Connection,
  params: FindByCommitmentParams,
): Promise<LicenseVaultMatch[]> {
  const programId = resolveZkShielded(params);
  const shapes = params.shapes ?? LICENSE_LOOKUP_SHAPES;
  for (const shape of shapes) {
    const accounts = await connection.getProgramAccounts(programId, {
      commitment: params.level ?? 'confirmed',
      filters: licenseLookupFilters({
        merchant: params.merchant,
        commitment: params.wantCommitment,
        tokenMint: params.tokenMint,
        shape,
      }),
    });
    const out: LicenseVaultMatch[] = [];
    for (const acc of accounts) {
      // The program is the owner by construction of `getProgramAccounts`; a
      // body the decoder rejects is skipped rather than trusted.
      try {
        out.push({ vaultPda: acc.pubkey, vault: decodeSubscriptionVault(acc.account.data, acc.pubkey) });
      } catch {
        continue;
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

/**
 * Locate the vault from the key ALONE — no address from the client, no
 * subscriber ID, no enumeration of the merchant's book. Returns the first
 * match; see {@link findVaultsByLicenseKey} for all of them.
 *
 * @throws on a malformed key.
 */
export async function findVaultByLicenseKey(
  connection: Connection,
  params: FindVaultByLicenseKeyParams,
): Promise<LicenseVaultMatch | null> {
  const all = await findVaultsByLicenseKey(connection, params);
  return all[0] ?? null;
}

// ---------------------------------------------------------------------------
// The ephemeral account
// ---------------------------------------------------------------------------

/** Domain-separation prefix of {@link ephemeralAccountId}. Bump the version to rotate every id. */
export const EPHEMERAL_ACCOUNT_DOMAIN = 'p01-ephemeral-account-v1';

export interface EphemeralAccountInput {
  merchant: PublicKey;
  serviceSlug: string;
  vaultPda: PublicKey;
  /** The vault's `start_slot` — rewritten on every subscribe, so a renewal that re-creates the vault gets a new id. */
  startSlot: bigint;
}

/**
 * A stable pseudonym for one subscription at one merchant's service:
 *
 *   base58( blake3( "p01-ephemeral-account-v1" ‖ merchant ‖ utf8(serviceSlug) ‖ vaultPda ‖ startSlot as LE u64 ) )
 *
 * Properties, each pinned in `src/merchant-license.test.ts`:
 *
 *   - **Stable** for the life of one vault: every verification of the same
 *     subscription yields the same id, so it can key a merchant-side cache or
 *     rate limiter without a database of customers.
 *   - **Different per subscription generation.** The program rewrites
 *     `start_slot` on every subscribe, so a renewal that creates a new vault —
 *     or re-creates one at the same PDA — gets a new id.
 *   - **Different per merchant and per service**, so two merchants (or two of
 *     one merchant's services) cannot join their records on it.
 *   - **Not derived from the key.** The id is a function of the vault, not of
 *     the bearer secret: a merchant database that stores only this id cannot
 *     reconstruct the key, and a leaked table of ids opens no subscription.
 *
 * What it is NOT: it is a pseudonym, not PII, and not a secret. It reveals
 * exactly what it commits to — the vault address, which is public and
 * enumerable from the retailer field anyway — and nothing about the customer's
 * wallet, which private-mode vaults never name.
 */
export function ephemeralAccountId(input: EphemeralAccountInput): string {
  const slot = Buffer.alloc(8);
  slot.writeBigUInt64LE(BigInt.asUintN(64, input.startSlot));
  const preimage = Buffer.concat([
    Buffer.from(EPHEMERAL_ACCOUNT_DOMAIN, 'utf8'),
    input.merchant.toBuffer(),
    Buffer.from(input.serviceSlug, 'utf8'),
    input.vaultPda.toBuffer(),
    slot,
  ]);
  return bs58.encode(blake3(preimage));
}

// ---------------------------------------------------------------------------
// The fail-closed verification
// ---------------------------------------------------------------------------

/** Every way {@link verifyMerchantLicense} can say no. Closed; match on it. */
export type MerchantLicenseRefusalReason =
  /** The key string does not decode to a 16-byte secret. */
  | 'malformed_key'
  /** No vault naming this merchant carries the key's commitment (or none lives at `vault`). */
  | 'vault_not_found'
  /** The account at `vault` is not owned by `zk_shielded`, so nothing in it can be trusted. */
  | 'wrong_owner'
  /** The account is program-owned but is not a `SubscriptionVault` (bad discriminator or body). */
  | 'undecodable'
  /** `vault.retailer` is not this merchant. */
  | 'retailer_mismatch'
  /** `vault.token_mint` is not the service's mint. */
  | 'mint_mismatch'
  /** `rate` / `interval_slots` are not the price and interval the service registered — the self-minted decoy and the cross-service escalation both land here. */
  | 'service_mismatch'
  /** The address is not the PDA of the vault's own seeds (retailer, subscriber id, mint). */
  | 'non_canonical_pda'
  /** The vault predates license keys and carries no commitment. */
  | 'no_license_commitment'
  /** `blake3(secret)` is not the vault's commitment — a wrong key for this vault. */
  | 'commitment_mismatch'
  /** The subscriber has the vault paused. */
  | 'subscription_paused'
  /** The vault ran past the periods it was funded for (`is_active` is still true — it always is). */
  | 'subscription_ended'
  /** Never current: inactive, or `interval_slots`/`rate` of zero, or the funded window is under a second long. */
  | 'subscription_not_current'
  /** The RPC call failed; nothing was decided. */
  | 'rpc_error';

export interface MerchantLicenseGranted {
  ok: true;
  vaultPda: PublicKey;
  vault: SubscriptionVaultAccount;
  /** {@link ephemeralAccountId} of this subscription at this service. */
  ephemeralAccountId: string;
  periodsPaidFor: bigint;
  periodsElapsed: bigint;
  /** First slot at which the subscription stops being current (a lower bound — pauses only push it later). */
  currentUntilSlot: bigint | null;
  /** The slot the decision was made at. */
  currentSlot: bigint;
  /**
   * Set when `otherServices` was supplied and one of them is indistinguishable
   * from `service` on chain (same retailer, mint, price, interval). Access is
   * granted; the chain cannot tell the two products apart.
   */
  ambiguousService?: true;
}

export interface MerchantLicenseRefused {
  ok: false;
  reason: MerchantLicenseRefusalReason;
  /** Human-readable diagnostics. Log it; do not parse it. */
  detail: string;
  /** The vault the refusal is about, when one was located. */
  vaultPda?: PublicKey;
  vault?: SubscriptionVaultAccount;
  currentSlot?: bigint;
}

export type MerchantLicenseResult = MerchantLicenseGranted | MerchantLicenseRefused;

export interface VerifyMerchantLicenseParams {
  /** The payout key you registered — what the vault must name as `retailer`. */
  merchant: PublicKey;
  /**
   * REQUIRED. The registry facts of the service being unlocked — normally
   * `serviceScopeFromRegistry(entry)`. There is no unchecked mode: without the
   * price and interval you registered, the check cannot tell a subscription
   * you sold from a vault a stranger minted at a rate of one atomic unit.
   */
  service: ServiceScope;
  /** The service slug — bound into the ephemeral account id and the session token's `svc`. */
  serviceSlug: string;
  /** The presented `P01-…` key. */
  key: string;
  /** Fast path: the vault address from the client's receipt. One `getAccountInfo` instead of a program scan. */
  vault?: PublicKey;
  /** Mint to narrow the key-only lookup to. Defaults to `service.tokenMint`. */
  tokenMint?: PublicKey;
  /** Slot to evaluate against. Fetched when omitted. */
  currentSlot?: bigint;
  /** Your other services, so an on-chain-indistinguishable pair is reported as `ambiguousService`. */
  otherServices?: ServiceScope[];
  /** Program ID override. Ignored when `sdkConfig` is supplied. */
  programId?: PublicKey;
  /** SDK-level configuration (cluster + program ID overrides). */
  sdkConfig?: MerchantSdkConfig;
  /** Commitment. Default `confirmed`. */
  commitment?: CommitmentLevel;
}

/** Steps of {@link verifyMerchantLicense}, in order; a refusal's rank is the step it fell at. */
const REFUSAL_RANK: Record<MerchantLicenseRefusalReason, number> = {
  malformed_key: 0,
  rpc_error: 1,
  vault_not_found: 2,
  wrong_owner: 3,
  undecodable: 4,
  retailer_mismatch: 5,
  mint_mismatch: 6,
  service_mismatch: 7,
  non_canonical_pda: 8,
  no_license_commitment: 9,
  commitment_mismatch: 10,
  subscription_paused: 11,
  subscription_ended: 11,
  subscription_not_current: 11,
};

/**
 * Verify a presented license key for THIS merchant and THIS service, and
 * nothing weaker. Fail-closed by design: every parameter that could make the
 * check answer an easier question is required, and every refusal names its
 * reason.
 *
 * ## Checks, in order
 *
 *  1. the key decodes                                       → `malformed_key`
 *  2. a vault is located — from the key alone
 *     ({@link findVaultsByLicenseKey}) or at `vault`         → `vault_not_found`
 *  3. the account is owned by `zk_shielded`                 → `wrong_owner`
 *  4. it decodes as a `SubscriptionVault`                    → `undecodable`
 *  5. `vault.retailer == merchant`                           → `retailer_mismatch`
 *  6. `vault.token_mint == service.tokenMint`                → `mint_mismatch`
 *  7. `rate` and `interval_slots` equal the registered
 *     price and interval ({@link vaultMatchesService})       → `service_mismatch`
 *  8. the address is the PDA of the vault's OWN seeds
 *     ({@link deriveSubscriptionVaultPda})                   → `non_canonical_pda`
 *  9. the vault carries a commitment                         → `no_license_commitment`
 * 10. `blake3(secret) == license_commitment`, constant-time  → `commitment_mismatch`
 * 11. {@link subscriptionIsCurrent} at `currentSlot`         → `subscription_paused` /
 *                                                              `subscription_ended` /
 *                                                              `subscription_not_current`
 *
 * Step 7 is what the older `verifyLicenseAgainstVault` made optional, and it is
 * the whole difference: subscribing is permissionless, the retailer is an
 * unsigned account and the rate is caller-chosen, so steps 3-6 and 8-11 all pass
 * on a vault a stranger minted naming you at one atomic unit per period. Only
 * the registered price refuses it. Likewise a key sold for your cheap tier
 * carries a vault whose `rate` is the cheap price, so it cannot open the dear
 * one. Both are pinned in `src/self-minted-vault.test.ts` and
 * `src/merchant-license.test.ts`.
 *
 * When the key-only lookup returns several vaults (a decoy carrying a real
 * subscriber's public commitment, say), every one is judged and the first that
 * passes is granted; otherwise the refusal reported is the one that got
 * furthest, so a decoy cannot mask a genuine subscriber's real status.
 *
 * ## Cost
 *
 * Key only: at most two `getProgramAccounts` (memcmp on discriminator,
 * retailer, mint, commitment) plus one `getSlot` unless `currentSlot` is
 * supplied. With `vault`: one `getAccountInfo` plus the slot.
 *
 * @throws on caller misconfiguration — a missing `service` or `serviceSlug`,
 *   or a scope whose `retailer` is not `merchant` (the check could never pass,
 *   and a silent refusal would send the debugging to the customer's key).
 */
export async function verifyMerchantLicense(
  connection: Connection,
  params: VerifyMerchantLicenseParams,
): Promise<MerchantLicenseResult> {
  if (!params.service) {
    throw new Error(
      'verifyMerchantLicense: `service` is required. Without the price and interval you registered, ' +
        'the only question left is "does a vault naming me exist and is it inside a paid period", ' +
        'which a stranger can arrange by self-minting a vault at a rate of one atomic unit. ' +
        'Pass serviceScopeFromRegistry(entry), or state the four facts yourself.',
    );
  }
  if (!params.serviceSlug) {
    throw new Error('verifyMerchantLicense: `serviceSlug` is required — it is bound into the ephemeral account id');
  }
  if (!params.service.retailer.equals(params.merchant)) {
    throw new Error(
      `verifyMerchantLicense: the service scope names retailer ${params.service.retailer.toBase58()} but ` +
        `merchant is ${params.merchant.toBase58()} — no vault can satisfy both, so this is a configuration ` +
        `error, not a customer's problem`,
    );
  }

  const programId = resolveZkShielded(params);
  const level = params.commitment ?? 'confirmed';

  let secret: Uint8Array;
  try {
    secret = decodeLicenseKey(params.key);
  } catch (e) {
    return { ok: false, reason: 'malformed_key', detail: `license key does not decode: ${(e as Error).message}` };
  }
  const wantCommitment = licenseCommitment(secret);

  let located: Located[];
  let currentSlot: bigint;
  try {
    [located, currentSlot] = await Promise.all([
      params.vault
        ? readOneVault(connection, params.vault, programId, level).then((r) => [r])
        : findVaultsByCommitment(connection, {
            merchant: params.merchant,
            wantCommitment,
            tokenMint: params.tokenMint ?? params.service.tokenMint,
            programId,
            level,
          }).then((matches) => matches.map((m) => ({ ok: true as const, ...m }))),
      params.currentSlot !== undefined
        ? Promise.resolve(params.currentSlot)
        : connection.getSlot(level).then(BigInt),
    ]);
  } catch (e) {
    return { ok: false, reason: 'rpc_error', detail: `on-chain lookup failed: ${(e as Error).message}` };
  }

  if (located.length === 0) {
    const offsets = LICENSE_LOOKUP_SHAPES.map(licenseCommitmentTagOffset).join('/');
    return {
      ok: false,
      reason: 'vault_not_found',
      detail:
        `no SubscriptionVault owned by ${programId.toBase58()} names retailer ${params.merchant.toBase58()} ` +
        `with this key's commitment (searched license_commitment at offsets ${offsets})`,
      currentSlot,
    };
  }

  let best: MerchantLicenseRefused | null = null;
  for (const candidate of located) {
    const verdict = candidate.ok
      ? judge(candidate.vaultPda, candidate.vault, params, programId, wantCommitment, currentSlot)
      : ({ ok: false, reason: candidate.reason, detail: candidate.detail, vaultPda: candidate.vaultPda, currentSlot } as MerchantLicenseRefused);
    if (verdict.ok) return verdict;
    if (!best || REFUSAL_RANK[verdict.reason] > REFUSAL_RANK[best.reason]) best = verdict;
  }
  return best!;
}

type Located =
  | { ok: true; vaultPda: PublicKey; vault: SubscriptionVaultAccount }
  | { ok: false; reason: 'vault_not_found' | 'wrong_owner' | 'undecodable'; detail: string; vaultPda: PublicKey };

/** The `vault` fast path: one `getAccountInfo`, owner-checked before it is decoded. */
async function readOneVault(
  connection: Connection,
  vaultPda: PublicKey,
  programId: PublicKey,
  level: CommitmentLevel,
): Promise<Located> {
  const info = await connection.getAccountInfo(vaultPda, level);
  if (!info) {
    return { ok: false, reason: 'vault_not_found', detail: `no account at ${vaultPda.toBase58()}`, vaultPda };
  }
  if (!info.owner.equals(programId)) {
    // An account's bytes are written by whoever owns it. Without this check
    // every field judged below — retailer, rate, commitment — is attacker-chosen.
    return {
      ok: false,
      reason: 'wrong_owner',
      detail:
        `account ${vaultPda.toBase58()} is owned by ${info.owner.toBase58()}, not zk_shielded ` +
        `${programId.toBase58()}, so nothing in it can be trusted`,
      vaultPda,
    };
  }
  try {
    return { ok: true, vaultPda, vault: decodeSubscriptionVault(info.data, vaultPda) };
  } catch (e) {
    return { ok: false, reason: 'undecodable', detail: `vault decode failed: ${(e as Error).message}`, vaultPda };
  }
}

/** Steps 5-11 on one located vault. */
function judge(
  vaultPda: PublicKey,
  vault: SubscriptionVaultAccount,
  params: VerifyMerchantLicenseParams,
  programId: PublicKey,
  wantCommitment: Uint8Array,
  currentSlot: bigint,
): MerchantLicenseResult {
  const refuse = (reason: MerchantLicenseRefusalReason, detail: string): MerchantLicenseRefused => ({
    ok: false,
    reason,
    detail,
    vaultPda,
    vault,
    currentSlot,
  });

  if (!vault.retailer.equals(params.merchant)) {
    return refuse('retailer_mismatch', `vault pays ${vault.retailer.toBase58()}, not ${params.merchant.toBase58()}`);
  }
  if (!vault.tokenMint.equals(params.service.tokenMint)) {
    return refuse(
      'mint_mismatch',
      `vault is denominated in ${vault.tokenMint.toBase58()}, the service in ${params.service.tokenMint.toBase58()}`,
    );
  }
  const scoped = vaultMatchesService(vault, params.service, { otherServices: params.otherServices });
  if (!scoped.matches) {
    return refuse('service_mismatch', scoped.reason ?? 'vault does not match the registered service');
  }

  const idBytes = vault.subscriberCommitment ?? vault.subscriberPubkey?.toBytes() ?? null;
  if (!idBytes || idBytes.length !== 32) {
    return refuse('non_canonical_pda', 'vault carries neither a subscriber commitment nor a subscriber pubkey');
  }
  const [canonical] = deriveSubscriptionVaultPda(vault.retailer, idBytes, vault.tokenMint, { programId });
  if (!canonical.equals(vaultPda)) {
    return refuse(
      'non_canonical_pda',
      `account ${vaultPda.toBase58()} is not the PDA its own seeds derive (${canonical.toBase58()})`,
    );
  }

  if (!vault.licenseCommitment) {
    return refuse('no_license_commitment', 'vault was created before license keys existed and carries no commitment');
  }
  if (!bytesEqual(vault.licenseCommitment, wantCommitment)) {
    return refuse('commitment_mismatch', 'blake3(key) is not this vault\'s license_commitment');
  }

  if (!subscriptionIsCurrent(vault, currentSlot)) {
    const paid = periodsPaidFor(vault);
    if (vault.isPaused) {
      return refuse('subscription_paused', `subscriber paused the vault at slot ${vault.pauseSlot ?? '?'}`);
    }
    if (vault.isActive && vault.intervalSlots > 0n && periodsElapsed(vault, currentSlot) >= paid) {
      return refuse(
        'subscription_ended',
        `subscription ran past the ${paid} period(s) it was funded for (is_active is still true — it always is)`,
      );
    }
    return refuse(
      'subscription_not_current',
      `vault is never current: isActive=${vault.isActive} intervalSlots=${vault.intervalSlots} rate=${vault.rate}`,
    );
  }

  const granted: MerchantLicenseGranted = {
    ok: true,
    vaultPda,
    vault,
    ephemeralAccountId: ephemeralAccountId({
      merchant: params.merchant,
      serviceSlug: params.serviceSlug,
      vaultPda,
      startSlot: vault.startSlot,
    }),
    periodsPaidFor: periodsPaidFor(vault),
    periodsElapsed: periodsElapsed(vault, currentSlot),
    currentUntilSlot: subscriptionEndSlot(vault),
    currentSlot,
  };
  if (scoped.ambiguous) granted.ambiguousService = true;
  return granted;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The ephemeral session
// ---------------------------------------------------------------------------

export interface CreateEphemeralSessionParams extends VerifyMerchantLicenseParams {
  /** The key that signs the token. Need not be the retailer; it is whatever `verifyAccessToken` will be given. */
  issuer: Keypair;
  /** Token TTL from now, in seconds — a ceiling: `exp` is clamped to the funded window. */
  ttlSeconds: number;
  /** Extra claims to attach. They decorate the token and cannot override `iss`/`sub`/`svc`/`exp`/`vault`. */
  extraClaims?: Record<string, unknown>;
  /** Slot time used to turn the remaining slots into a deadline. Default 400 ms (expires early, the safe direction). */
  slotMs?: bigint;
  /** Clock override, unix seconds. Tests only. */
  nowUnix?: number;
}

export type EphemeralSessionResult =
  | (MerchantLicenseGranted & {
      /** Self-contained, Ed25519-signed; re-verify with `verifyAccessToken(token, issuer.publicKey, { expectedService, expectedVault })`. */
      token: string;
      issuer: PublicKey;
      /** The token's `exp`, unix seconds. */
      expiresAtUnix: number;
    })
  | MerchantLicenseRefused;

/**
 * {@link verifyMerchantLicense}, then a session: an access token whose subject
 * is the {@link ephemeralAccountId}, issued through
 * `issueSubscriptionAccessToken` so it inherits that module's three guarantees —
 * `exp` clamped to the subscription's funded window, `svc` set to
 * `serviceSlug`, and `vault` + `vaultStartSlot` pinned so the token does not
 * survive a close-and-resubscribe on the same PDA.
 *
 * The merchant stores nothing. The token carries everything a later request
 * needs, and `verifyAccessToken` checks it from the issuer's public key alone.
 * A refusal propagates as-is and no token is minted.
 */
export async function createEphemeralSession(
  connection: Connection,
  params: CreateEphemeralSessionParams,
): Promise<EphemeralSessionResult> {
  const { issuer, ttlSeconds, extraClaims, slotMs, nowUnix, ...verifyParams } = params;
  const verdict = await verifyMerchantLicense(connection, verifyParams);
  if (!verdict.ok) return verdict;

  let token: string;
  try {
    token = issueSubscriptionAccessToken({
      merchantKeypair: issuer,
      subscriberId: verdict.ephemeralAccountId,
      serviceSlug: params.serviceSlug,
      ttlSeconds,
      vault: verdict.vault,
      currentSlot: verdict.currentSlot,
      extraClaims,
      slotMs,
      nowUnix,
    });
  } catch (e) {
    // `verifyMerchantLicense` said current; the only way issuance still refuses
    // is a funded window that ends within the second. Report it as the
    // subscription ending rather than as a token bug.
    return {
      ok: false,
      reason: 'subscription_ended',
      detail: `no token issued: ${(e as Error).message}`,
      vaultPda: verdict.vaultPda,
      vault: verdict.vault,
      currentSlot: verdict.currentSlot,
    };
  }

  const claims = verifyAccessToken(token, issuer.publicKey, { nowUnix }).claims;
  if (!claims || typeof claims.exp !== 'number') {
    throw new Error('createEphemeralSession: the token just issued does not verify — this is a bug');
  }
  return { ...verdict, token, issuer: issuer.publicKey, expiresAtUnix: claims.exp };
}
