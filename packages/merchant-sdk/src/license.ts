import { Connection, PublicKey } from '@solana/web3.js';
import { blake3 } from '@noble/hashes/blake3.js';
import {
  fetchVaultByAddress,
  listVaultsForRetailer,
  type SubscriptionVaultAccount,
  type ListVaultsOptions,
} from './vaults';
import { periodsPaidFor, subscriptionIsCurrent } from './claim';
import { type ServiceScopedOptions, vaultMatchesService } from './service-scope';

// Re-exported so `import { ServiceScopedOptions } from './license'` keeps
// working; the declaration moved to `service-scope.ts` when `vaults.ts` started
// needing it too.
export type { ServiceScopedOptions };

/**
 * Protocol 01 subscription **license keys** — commitment scheme.
 *
 * ## The scheme (no shared secret, no on-chain hashing)
 *
 * A license key is a human-readable string that encodes a per-subscriber
 * 128-bit `licenseSecret`. At subscribe time the client posts only the
 * `blake3(licenseSecret)` **commitment** on-chain (`SubscriptionVault
 * .license_commitment`, stored verbatim — no on-chain verification). The
 * subscriber later presents the key (= the preimage) to the merchant, who
 * recomputes `blake3(decode(key))` and checks it equals the on-chain
 * commitment for a CURRENT vault it is the retailer of. Current, not
 * `is_active` — see `subscriptionIsCurrent`.
 *
 *   key string  = "P01-" + Crockford-base32(licenseSecret)  (16 bytes → 26 chars, grouped in 4s)
 *   commitment  = blake3(licenseSecret)                      (32 bytes, posted on-chain)
 *   verify      = blake3(decode(key)) === vault.license_commitment
 *
 * ## Why this is forgery-resistant (and needs NO merchant secret)
 *
 * Everything public — the vault PDA (enumerable on-chain via
 * `getProgramAccounts`), the `serviceId` (published in the Service Registry),
 * and the `license_commitment` (a 32-byte blake3 image) — is insufficient to
 * forge a key: an attacker would need the **preimage** `licenseSecret`, and
 * inverting blake3 is infeasible. Only the subscriber can produce a key whose
 * blake3 matches the commitment, because only they hold the master note secret
 * (ZK) / wallet (classic) from which `licenseSecret` is derived.
 *
 * This is strictly better than the rejected keyed-MAC approach: there is NO
 * per-merchant secret to provision, deliver to clients, or leak. Keys are
 * generated entirely on the subscriber's device; the merchant verifies with
 * public on-chain data alone.
 *
 * ## Derivation (defined ONCE — clients + merchant must match byte-for-byte)
 *
 * See `LICENSE_SCHEME` below for the authoritative constant block. The mobile
 * app and the browser extension MUST mirror it exactly so a key generated on
 * one device verifies on any merchant. The merchant SDK never derives the
 * secret (it only verifies a presented key against the on-chain commitment), so
 * the derivation itself lives client-side; it is documented here for reference.
 */

// ---------------------------------------------------------------------------
// Authoritative scheme constants — DO NOT DRIFT. Mirror byte-for-byte in
// apps/mobile/services/license/derive.ts and apps/extension's license module.
// ---------------------------------------------------------------------------

/**
 * Frozen description of the license scheme so every implementation (merchant
 * SDK, mobile, extension) can be byte-matched against one source of truth.
 */
export const LICENSE_SCHEME = {
  /** licenseSecret length in bytes (128-bit). */
  SECRET_BYTES: 16,
  /** HKDF hash. */
  hkdfHash: 'SHA-256',
  /** HKDF salt — none (undefined). */
  hkdfSalt: undefined as undefined,
  /** HKDF info = utf8(INFO_LABEL) || utf8(serviceId). */
  INFO_LABEL: 'p01-license-v1',
  /**
   * ZK/private ikm = the subscriber master note secret for the vault, as its
   * canonical decimal string, UTF-8 encoded. Same secret family the vault's
   * `subscriber_commitment` is derived from (`receipt.secret`).
   */
  ZK_IKM: 'utf8(masterNoteSecret.toString(10))',
  /**
   * Classic ikm = ed25519 signMessage(wallet, "p01-license-v1:" || serviceId),
   * the 64-byte signature. DEFERRED — see note in mobile derive module.
   */
  CLASSIC_IKM: 'ed25519 sign("p01-license-v1:" || serviceId)',
  CLASSIC_SIGN_PREFIX: 'p01-license-v1:',
  /** Commitment = blake3(licenseSecret), 32 bytes, posted on-chain. */
  commitment: 'blake3(licenseSecret) -> 32 bytes',
  /** Key string = "P01-" + Crockford-base32(licenseSecret) grouped in 4s.
   *  The prefix is UNIFORM across merchants on purpose — see encodeLicenseKey. */
  keyPrefix: 'P01-',
  CROCKFORD: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
} as const;

/** licenseSecret byte length (128-bit). */
export const LICENSE_SECRET_BYTES = LICENSE_SCHEME.SECRET_BYTES;

/** Commitment byte length (blake3 default output). */
export const LICENSE_COMMITMENT_BYTES = 32;

const CROCKFORD = LICENSE_SCHEME.CROCKFORD;
const CROCKFORD_INV: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD.length; i++) m[CROCKFORD[i]!] = i;
  // Crockford aliases (decode-only leniency): O→0, I/L→1.
  m['O'] = 0; m['I'] = 1; m['L'] = 1;
  return m;
})();

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 0x1f];
  return out;
}

function decodeCrockford(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = CROCKFORD_INV[ch];
    if (v === undefined) throw new Error(`invalid Crockford character: ${ch}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Encode a 16-byte `licenseSecret` into the user-facing key string
 * `P01-XXXX-XXXX-...`. The inverse of `decodeLicenseKey`.
 */
/**
 * Render a license key for presentation: `P01-` + Crockford-base32(secret),
 * grouped in 4s. The inverse of {@link decodeLicenseKey}.
 *
 * The `P01-` prefix is deliberately UNIFORM across every merchant. A
 * per-merchant prefix (`PO-` for Proton, `ND-` for Nord) was considered on
 * 2026-08-04 and rejected: the key is a bearer string the subscriber stores,
 * screenshots and pastes into support chats, and a brand-stamped prefix makes it
 * self-identifying in every one of those places. Private-mode vaults are keyed
 * on a commitment rather than on a wallet precisely so that "this person
 * subscribes to that service" is not derivable — putting the service name on the
 * key hands back, in plaintext, the exact fact the vault design spends its
 * complexity hiding. It buys the merchant nothing either: the merchant knows
 * which service it is when the key is presented to it, and verification is
 * against its own `license_commitment` regardless.
 *
 * The key IS service-specific, cryptographically: the secret is derived through
 * HKDF with `INFO_LABEL || serviceId` (see {@link LICENSE_SCHEME}), so a key for
 * one service cannot verify against another. That binding is real; it is simply
 * not advertised on the string.
 *
 * NOT DONE, deliberately, and costed 2026-08-04: appending 2 Crockford chars of
 * blake3 checksum so a mistyped key is caught on the subscriber's own screen
 * instead of returning from the merchant as a generic rejection. Compatibility
 * was verified in both directions — a 26-char decoder recovers the correct
 * secret from a 28-char key because base32 is prefix-preserving at the 5-bit
 * boundary, and a checksum-aware decoder can tell the two apart by length. It
 * was reverted because this format is mirrored byte-for-byte in
 * `apps/mobile/services/license/derive.ts` and
 * `apps/extension/src/shared/services/license.ts`, and pinned by a frozen
 * conformance vector in `license-scheme-vectors.ts`. Changing it is a
 * coordinated six-file change and a deliberate re-freeze — not a side effect.
 */
export function encodeLicenseKey(licenseSecret: Uint8Array): string {
  if (licenseSecret.length !== LICENSE_SECRET_BYTES) {
    throw new Error(`licenseSecret must be exactly ${LICENSE_SECRET_BYTES} bytes, got ${licenseSecret.length}`);
  }
  const groups = encodeCrockford(licenseSecret).match(/.{1,4}/g) ?? [];
  return LICENSE_SCHEME.keyPrefix + groups.join('-');
}

/**
 * Decode a presented license key string back to the 16-byte `licenseSecret`.
 * Tolerant of casing, surrounding whitespace, dashes, and the optional `P01-`
 * prefix. Throws on malformed input.
 */
export function decodeLicenseKey(key: string): Uint8Array {
  let s = key.trim().toUpperCase().replace(/-/g, '').replace(/\s+/g, '');
  if (s.startsWith('P01')) s = s.slice(3);
  if (s.length === 0) throw new Error('empty license key');

  const bytes = decodeCrockford(s);
  // 16 bytes → 26 Crockford chars (130 bits) where the last char carries 2
  // significant + 3 padding bits, so decode yields exactly 16 bytes.
  if (bytes.length < LICENSE_SECRET_BYTES) {
    throw new Error(`license key decodes to ${bytes.length} bytes, need ${LICENSE_SECRET_BYTES}`);
  }
  return bytes.subarray(0, LICENSE_SECRET_BYTES);
}

/**
 * Compute the on-chain `license_commitment` from a `licenseSecret`.
 * `commitment = blake3(licenseSecret)` (32 bytes). Identical client-side and
 * merchant-side.
 */
export function licenseCommitment(licenseSecret: Uint8Array): Uint8Array {
  if (licenseSecret.length !== LICENSE_SECRET_BYTES) {
    throw new Error(`licenseSecret must be exactly ${LICENSE_SECRET_BYTES} bytes, got ${licenseSecret.length}`);
  }
  return blake3(licenseSecret);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Pure check: does `presentedKey` decode to a secret whose blake3 image equals
 * `commitment`? No network. Returns false (never throws) on a malformed key.
 */
export function keyMatchesCommitment(presentedKey: string, commitment: Uint8Array): boolean {
  let secret: Uint8Array;
  try {
    secret = decodeLicenseKey(presentedKey);
  } catch {
    return false;
  }
  return bytesEqual(licenseCommitment(secret), commitment);
}

export interface VerifyLicenseKeyResult {
  valid: boolean;
  reason?: string;
  /** The active vault whose commitment matched, when valid. */
  vault?: SubscriptionVaultAccount;
  /**
   * Valid, but the supplied `service` scope cannot tell this service apart from
   * another of the merchant's: same retailer, mint, price and interval. Grant
   * access if you like, but the chain does not distinguish the two products.
   */
  ambiguousService?: boolean;
}

export interface VerifyLicenseKeyOptions
  extends Omit<ListVaultsOptions, 'includeInactive'>,
    ServiceScopedOptions {}

/**
 * Verify a presented license key for THIS merchant + serviceId by enumerating
 * the merchant's on-chain vaults and matching `blake3(decode(key))` against each
 * vault's `license_commitment`. Returns the matching current vault, or invalid.
 *
 * NO merchant secret anywhere — verification uses only public on-chain state.
 *
 * @deprecated Use {@link verifyLicenseAgainstVault}, which reads the one vault
 *   the key belongs to instead of the merchant's whole subscriber book. This
 *   form remains the fallback for a merchant that has the key and nothing else:
 *   no vault address from the client, and not enough information (retailer +
 *   subscriber id + mint) to derive one.
 *
 *   MEASURED on devnet 2026-08-01, one verification against a 4-vault merchant:
 *   this path made 2 RPC calls (`getProgramAccounts` + `getSlot`) for 492
 *   request / 2,750 response bytes and 4 accounts;
 *   {@link verifyLicenseAgainstVault} made 2 calls (`getAccountInfo` +
 *   `getSlot`) for 309 request / 813 response bytes and 1 account. The call
 *   count is the same; the payload is not, and it scales with the subscriber
 *   count rather than with the question asked.
 *
 * The `serviceId` argument is only enforceable when `opts.service` supplies the
 * service's registry facts — see `ServiceScope`.
 */
export async function verifyLicenseKey(
  connection: Connection,
  presentedKey: string,
  merchantPubkey: PublicKey,
  serviceId: string,
  opts: VerifyLicenseKeyOptions = {},
): Promise<VerifyLicenseKeyResult> {
  // `serviceId` is only enforceable when the caller supplies the service's
  // registry facts — the vault records no service identifier. Without a scope
  // this argument cannot be honoured, and saying so beats the silent `void`
  // that let a key for one service verify against another. See ServiceScope.
  const scope = opts.service;
  if (!scope) void serviceId;
  let secret: Uint8Array;
  try {
    secret = decodeLicenseKey(presentedKey);
  } catch (e) {
    return { valid: false, reason: `malformed license key: ${(e as Error).message}` };
  }
  const wantCommitment = licenseCommitment(secret);

  let vaults: SubscriptionVaultAccount[];
  let slot: bigint;
  try {
    [vaults, slot] = await Promise.all([
      listVaultsForRetailer(connection, merchantPubkey, { ...opts, includeInactive: false }),
      connection.getSlot(opts.commitment ?? 'confirmed').then(BigInt),
    ]);
  } catch (e) {
    return { valid: false, reason: `on-chain lookup failed: ${(e as Error).message}` };
  }
  // Match the key first, then judge the subscription, so an exhausted holder
  // gets "expired" rather than the indistinguishable "no match" that a
  // commitment-only loop produces.
  const matched = vaults.find((v) => v.licenseCommitment && bytesEqual(v.licenseCommitment, wantCommitment));
  if (!matched) return { valid: false, reason: 'no subscription matches this license key' };
  if (!subscriptionIsCurrent(matched, slot)) {
    return {
      valid: false,
      reason: matched.isPaused
        ? 'subscription is paused'
        : `subscription has run past the ${periodsPaidFor(matched)} period(s) it was funded for`,
      vault: matched,
    };
  }
  if (scope) {
    const m = vaultMatchesService(matched, scope, { otherServices: opts.otherServices });
    if (!m.matches) {
      return { valid: false, reason: `key is not scoped to "${serviceId}": ${m.reason}`, vault: matched };
    }
    if (m.ambiguous) {
      return { valid: true, vault: matched, ambiguousService: true };
    }
  }
  return { valid: true, vault: matched };
}

export interface VerifyLicenseAgainstVaultOptions extends ServiceScopedOptions {
  /** SDK config; forwarded to program-id resolution (used for the owner check). */
  sdkConfig?: import('./config').MerchantSdkConfig;
  /** Program ID override. Ignored when `sdkConfig` is supplied. */
  programId?: PublicKey;
  /** Commitment. Default `confirmed`. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * **The primary license verification path.** Verify a key against the SPECIFIC
 * vault address the client presents (from its subscription receipt), or that
 * the merchant derived itself with `deriveSubscriptionVaultPda`.
 *
 * One `getAccountInfo` + one `getSlot`, whatever the merchant's subscriber
 * count. The merchant confirms the account is owned by `zk_shielded` and names
 * it as the retailer, that the subscription is current, then checks
 * `blake3(decode(key)) === vault.license_commitment`.
 *
 * Prefer this over {@link verifyLicenseKey}, which answers the same question by
 * hydrating the merchant's entire subscriber book.
 *
 * ## Two things this does NOT check
 *
 * 1. **The canonical PDA.** Unlike `hasActiveVaultAccessForVault`, this takes no
 *    subscriber ID, so there is no seed set to derive from. The account is
 *    accepted at whatever address it is presented at, as long as `zk_shielded`
 *    owns it and its `retailer` is the merchant. The license commitment is what
 *    binds a key to a vault here.
 * 2. **That the merchant ever sold this subscription.** `license_commitment` is
 *    an instruction argument to `subscribe_private_stark`
 *    (`subscribe_private_stark.rs:74`), whose `retailer` is an unsigned account
 *    (`:81-83`) and whose `rate`/`interval_slots` are chosen by the caller
 *    (`:181-182`). A stranger can therefore create a real, program-owned,
 *    currently-funded vault naming this merchant, with a commitment whose
 *    preimage they picked, at a rate of one atomic unit — and present the
 *    matching key. Removing `subscribe_normal` did not close this; it only
 *    stopped the deposit being caller-chosen (`total_deposited` is now the
 *    pool's denomination, `:187`/`:390`), which a rate of 1 turns straight back
 *    into an effectively unexpiring `periodsPaidFor`. A
 *    valid result WITHOUT `opts.service` means "a vault naming you exists, is
 *    inside a paid-for period, and this key matches the commitment someone put
 *    on it". Pass `opts.service` and the vault's `rate` and `interval_slots`
 *    must equal the price and interval the service registered, which is what
 *    turns that into "this person bought this product".
 *    `src/self-minted-vault.test.ts` pins both.
 */
export async function verifyLicenseAgainstVault(
  connection: Connection,
  presentedKey: string,
  vaultPda: PublicKey,
  merchantPubkey: PublicKey,
  serviceId: string,
  opts: VerifyLicenseAgainstVaultOptions = {},
): Promise<VerifyLicenseKeyResult> {
  // `serviceId` is only enforceable when the caller supplies the service's
  // registry facts — the vault records no service identifier. Without a scope
  // this argument cannot be honoured, and saying so beats the silent `void`
  // that let a key for one service verify against another. See ServiceScope.
  const scope = opts.service;
  if (!scope) void serviceId;
  let secret: Uint8Array;
  try {
    secret = decodeLicenseKey(presentedKey);
  } catch (e) {
    return { valid: false, reason: `malformed license key: ${(e as Error).message}` };
  }
  // A client that presents an address chose that address. `getAccountInfo`
  // returns whatever lives there, and an account's bytes are written by the
  // program that OWNS it — so without an owner check the attacker supplies both
  // the address and every field verified below, including the commitment.
  // `fetchVaultByAddress` rejects anything `zk_shielded` did not write.
  const fetched = await fetchVaultByAddress(connection, vaultPda, {
    commitment: opts.commitment,
    programId: opts.programId,
    sdkConfig: opts.sdkConfig,
  });
  if (!fetched.ok) return { valid: false, reason: fetched.reason };
  const vault: SubscriptionVaultAccount = fetched.vault;
  if (!vault.retailer.equals(merchantPubkey)) return { valid: false, reason: 'vault is for a different merchant', vault };
  // `isActive` alone is not an entitlement: the program writes it `true` at
  // subscribe time and `false` nowhere, so an exhausted subscription reports
  // `true` forever. Gate on the period actually being paid for.
  const slot = BigInt(await connection.getSlot(opts.commitment ?? 'confirmed'));
  if (!subscriptionIsCurrent(vault, slot)) {
    return {
      valid: false,
      reason: vault.isPaused
        ? 'subscription is paused'
        : !vault.isActive
          ? 'subscription not active'
          : `subscription has run past the ${periodsPaidFor(vault)} period(s) it was funded for`,
      vault,
    };
  }
  if (!vault.licenseCommitment) {
    return { valid: false, reason: 'vault has no license commitment (created before license keys)', vault };
  }
  if (!bytesEqual(licenseCommitment(secret), vault.licenseCommitment)) {
    return { valid: false, reason: 'license key does not match this vault', vault };
  }
  if (scope) {
    const m = vaultMatchesService(vault, scope, { otherServices: opts.otherServices });
    if (!m.matches) {
      return { valid: false, reason: `key is not scoped to "${serviceId}": ${m.reason}`, vault };
    }
    if (m.ambiguous) return { valid: true, vault, ambiguousService: true };
  }
  return { valid: true, vault };
}
