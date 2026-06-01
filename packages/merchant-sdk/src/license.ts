import { Connection, PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hasActiveVaultAccess, type SubscriptionVaultAccount, type ListVaultsOptions } from './vaults';

/**
 * Protocol 01 subscription **license keys**.
 *
 * A license key is the anonymous credential a subscriber presents to a merchant
 * after subscribing (Standard or ZK) from the Protocol 01 app/extension. It is
 * the verification counterpart to the extension's
 * `apps/extension/src/shared/services/license.ts` encoder — the byte layout
 * MUST stay in sync:
 *
 *   packed = [version:1][mode:1][retailer:32][subscriberId:32]   (66 bytes)
 *   key    = "p01lic_" + base64url(packed)
 *
 * `subscriberId` is the on-chain subscription identity:
 *   - ZK (mode=1)       → the vault `subscriber_commitment` (anonymous; NOT
 *                          linkable to the paying wallet).
 *   - Standard (mode=0) → the subscriber wallet pubkey.
 *
 * Verification flow for a merchant backend:
 *   1. `verifyLicenseKey(connection, key, myMerchantPubkey)`
 *   2. On `{ valid: true }`, provision/lookup an EPHEMERAL account keyed by
 *      `result.ephemeralAccountId` — a one-way hash of the subscriber id, so
 *      no wallet / email / PII is ever stored. Optionally issue a signed
 *      session token with `issueAccessToken({ subscriberId: ephemeralAccountId, ... })`.
 *
 * Trust model: the key carries on-chain-public data, so it is an IDENTIFIER,
 * not a bearer secret. Its privacy property is that a ZK subscriber id is a
 * commitment that cannot be traced to a wallet. If you need replay protection
 * against a *leaked* key, pair this with a challenge-response (have the client
 * sign a nonce) before issuing long-lived sessions.
 */

const PREFIX = 'p01lic_';
const PACKED_LEN = 66;

export type LicenseMode = 'standard' | 'zk';

export interface ParsedLicenseKey {
  version: number;
  mode: LicenseMode;
  retailer: PublicKey;
  subscriberId: Uint8Array; // 32 bytes
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return new Uint8Array(Buffer.from(b64 + pad, 'base64'));
}

/** Decode + validate a license key. Throws on malformed input. */
export function parseLicenseKey(key: string): ParsedLicenseKey {
  const trimmed = key.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('not a Protocol 01 license key');
  const packed = base64UrlToBytes(trimmed.slice(PREFIX.length));
  if (packed.length !== PACKED_LEN) throw new Error('malformed license key');
  return {
    version: packed[0]!,
    mode: packed[1] === 1 ? 'zk' : 'standard',
    retailer: new PublicKey(packed.subarray(2, 34)),
    subscriberId: packed.subarray(34, 66),
  };
}

/**
 * Deterministic, PII-free account handle. One-way (sha256) so the subscriber id
 * can't be recovered, stable so the same license always maps to the same
 * ephemeral account. Matches the extension's `ephemeralAccountId`.
 */
export function deriveEphemeralAccountId(keyOrSubscriberId: string | Uint8Array): string {
  const subscriberId =
    typeof keyOrSubscriberId === 'string'
      ? parseLicenseKey(keyOrSubscriberId).subscriberId
      : keyOrSubscriberId;
  const h = sha256(subscriberId);
  return Buffer.from(h.subarray(0, 12)).toString('hex');
}

export interface VerifyLicenseKeyResult {
  valid: boolean;
  reason?: string;
  mode?: LicenseMode;
  /** PII-free handle to key the merchant's ephemeral account on. */
  ephemeralAccountId?: string;
  /** The active vault backing the license, when valid. */
  vault?: SubscriptionVaultAccount;
}

/**
 * Verify a license key against on-chain state for THIS merchant.
 *
 * Returns `valid: true` only when the key decodes for `merchantPubkey` AND a
 * matching `SubscriptionVault` is active (and unpaused, by default). The
 * returned `ephemeralAccountId` is what the merchant should provision against.
 */
export async function verifyLicenseKey(
  connection: Connection,
  licenseKey: string,
  merchantPubkey: PublicKey,
  opts: Omit<ListVaultsOptions, 'includeInactive'> = {},
): Promise<VerifyLicenseKeyResult> {
  let parsed: ParsedLicenseKey;
  try {
    parsed = parseLicenseKey(licenseKey);
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }

  if (!parsed.retailer.equals(merchantPubkey)) {
    return {
      valid: false,
      mode: parsed.mode,
      reason: `license is for a different merchant (${parsed.retailer.toBase58()})`,
    };
  }

  let vault: SubscriptionVaultAccount | null;
  try {
    vault = await hasActiveVaultAccess(connection, merchantPubkey, parsed.subscriberId, opts);
  } catch (e) {
    return { valid: false, mode: parsed.mode, reason: `on-chain lookup failed: ${(e as Error).message}` };
  }

  if (!vault) {
    return {
      valid: false,
      mode: parsed.mode,
      reason: 'no active subscription vault found for this license',
    };
  }

  return {
    valid: true,
    mode: parsed.mode,
    ephemeralAccountId: deriveEphemeralAccountId(parsed.subscriberId),
    vault,
  };
}
