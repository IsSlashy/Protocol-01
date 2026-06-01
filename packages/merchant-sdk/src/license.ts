import { Connection, PublicKey } from '@solana/web3.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { listVaultsForRetailer, type SubscriptionVaultAccount, type ListVaultsOptions } from './vaults';

/**
 * Protocol 01 subscription **license keys** — verification side.
 *
 * Key scheme is identical to the mobile app + extension
 * (`services/license/derive.ts`): a deterministic, human-readable
 * `P01-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` string = Crockford base32 of
 * BLAKE3(15) over `(domain || identity || serviceId)`.
 *
 *   - Private (ZK) subscription → `identity` = the SubscriptionVault PDA bytes.
 *   - Classic subscription      → `identity` = deriveClassicIdentity(wallet, streamId).
 *
 * A merchant does NOT decode the key (it's a one-way hash). Instead it
 * **re-derives** the key from on-chain state and matches:
 *   1. List its own SubscriptionVaults (`listVaultsForRetailer`).
 *   2. For each active vault, re-derive `deriveLicenseKey({serviceId, identity:
 *      vaultPda})` and compare to the presented key.
 *   3. On a match → grant access, keyed by the vault PDA (no wallet/PII).
 *
 * This works for ZK subscriptions (vault PDA is the identity, enumerable by
 * retailer + anonymous). Classic subscriptions use a wallet+streamId identity
 * the merchant can't enumerate, so classic verification requires the client to
 * also present the vault address (see `verifyLicenseAgainstVault`).
 */

const KEY_BYTES = 15;
const KEY_DOMAIN = 'p01-license-v1';
const CLASSIC_IDENTITY_DOMAIN = 'p01-license-classic-id-v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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

export interface LicenseKeyArgs {
  serviceId: string;
  identity: Uint8Array;
}

/** Re-derive a license key. Identical to mobile/extension `deriveLicenseKey`. */
export function deriveLicenseKey(args: LicenseKeyArgs): string {
  const enc = new TextEncoder();
  const domain = enc.encode(KEY_DOMAIN);
  const svc = enc.encode(args.serviceId);
  const buf = new Uint8Array(domain.length + args.identity.length + svc.length);
  let off = 0;
  buf.set(domain, off); off += domain.length;
  buf.set(args.identity, off); off += args.identity.length;
  buf.set(svc, off);
  const digest = blake3(buf, { dkLen: KEY_BYTES });
  const groups = encodeCrockford(digest).match(/.{4}/g) ?? [];
  return 'P01-' + groups.join('-');
}

/** Build the 32-byte classic identity. Identical to mobile/extension. */
export function deriveClassicIdentity(walletPubkey: Uint8Array, streamId: string): Uint8Array {
  const enc = new TextEncoder();
  const domain = enc.encode(CLASSIC_IDENTITY_DOMAIN);
  const sid = enc.encode(streamId);
  const buf = new Uint8Array(domain.length + walletPubkey.length + sid.length);
  let off = 0;
  buf.set(domain, off); off += domain.length;
  buf.set(walletPubkey, off); off += walletPubkey.length;
  buf.set(sid, off);
  return blake3(buf, { dkLen: 32 });
}

function normalizeKey(k: string): string {
  return k.trim().toUpperCase();
}

export interface VerifyLicenseKeyResult {
  valid: boolean;
  reason?: string;
  /** The active vault whose re-derived key matched, when valid. */
  vault?: SubscriptionVaultAccount;
}

/**
 * Verify a presented license key for THIS merchant + serviceId by enumerating
 * the merchant's on-chain vaults and re-deriving each one's key (identity =
 * vault PDA). Returns the matching active vault, or invalid. Works for ZK
 * (private) subscriptions.
 *
 * ⚠ `getProgramAccounts` is involved (via listVaultsForRetailer) — cache the
 * vault list in a background worker; don't call this on every request.
 */
export async function verifyLicenseKey(
  connection: Connection,
  presentedKey: string,
  merchantPubkey: PublicKey,
  serviceId: string,
  opts: Omit<ListVaultsOptions, 'includeInactive'> = {},
): Promise<VerifyLicenseKeyResult> {
  const target = normalizeKey(presentedKey);
  let vaults: SubscriptionVaultAccount[];
  try {
    vaults = await listVaultsForRetailer(connection, merchantPubkey, { ...opts, includeInactive: false });
  } catch (e) {
    return { valid: false, reason: `on-chain lookup failed: ${(e as Error).message}` };
  }
  for (const v of vaults) {
    const derived = deriveLicenseKey({ serviceId, identity: v.pda.toBytes() });
    if (normalizeKey(derived) === target) {
      return { valid: true, vault: v };
    }
  }
  return { valid: false, reason: 'no active subscription matches this license key' };
}

/**
 * Verify a license key against a SPECIFIC vault address the client presents
 * (covers classic subscriptions, where the identity isn't enumerable). The
 * merchant still confirms the vault is active + belongs to it on-chain.
 */
export async function verifyLicenseAgainstVault(
  connection: Connection,
  presentedKey: string,
  vaultPda: PublicKey,
  merchantPubkey: PublicKey,
  serviceId: string,
  identity?: Uint8Array,
): Promise<VerifyLicenseKeyResult> {
  const { decodeSubscriptionVault } = await import('./vaults');
  const info = await connection.getAccountInfo(vaultPda);
  if (!info) return { valid: false, reason: 'vault not found' };
  let vault: SubscriptionVaultAccount;
  try {
    vault = decodeSubscriptionVault(info.data, vaultPda);
  } catch (e) {
    return { valid: false, reason: `vault decode failed: ${(e as Error).message}` };
  }
  if (!vault.retailer.equals(merchantPubkey)) return { valid: false, reason: 'vault is for a different merchant', vault };
  if (!vault.isActive) return { valid: false, reason: 'subscription not active', vault };
  const id = identity ?? vaultPda.toBytes();
  const derived = deriveLicenseKey({ serviceId, identity: id });
  if (normalizeKey(derived) !== normalizeKey(presentedKey)) {
    return { valid: false, reason: 'license key does not match this vault', vault };
  }
  return { valid: true, vault };
}
