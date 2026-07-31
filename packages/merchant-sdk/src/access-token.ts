import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  NOMINAL_SLOT_MS,
  secondsUntilSubscriptionEnds,
  subscriptionIsCurrent,
  type VaultEntitlementState,
} from './period-math';

/**
 * Minimal Ed25519-signed access token.
 *
 * Format (base58):
 *   `<payload-b58>.<sig-b58>`
 * where `payload` is UTF-8 JSON with at minimum:
 *   {
 *     "iss": <merchant pubkey base58>,
 *     "sub": <subscriber identifier string>,
 *     "svc": <service slug>,
 *     "exp": <unix seconds>,
 *     "iat": <unix seconds>,
 *     "nonce"?: <string>
 *   }
 *
 * This is NOT a JWT — no header, no algorithm negotiation. A merchant who
 * wants JWTs should plug in `jose` themselves. We ship a tiny, explicit
 * signer so the demo works in any JS runtime without extra deps.
 *
 * Use case: after `verifyOneShotPayment` succeeds, the merchant backend
 * issues a token the mobile app stores and presents on every subsequent
 * request to prove subscription status without re-hitting the chain.
 *
 * ## What a token is NOT
 *
 * It is a bearer credential whose whole security is `exp`. Nothing here talks
 * to the chain, so nothing here can notice that the subscription behind the
 * token ended. Three consequences the merchant has to design around, and which
 * this module now makes it possible to design around:
 *
 *   1. **`exp` is chosen by the issuer, not by the subscription.** A merchant
 *      that verifies a licence key and then mints a 30-day session token has
 *      granted 30 days of service regardless of how much subscription is left.
 *      That is the same defect as gating on `is_active` — MEASURED granting
 *      access on a real devnet vault on 2026-08-01 — moved one layer up.
 *      {@link issueSubscriptionAccessToken} clamps `exp` to the subscription.
 *
 *   2. **`svc` was never checked.** `verifyAccessToken` compared the issuer and
 *      the signature and ignored the service slug entirely, so a token minted
 *      for a merchant's cheap product authenticated against its expensive one —
 *      exactly the escalation `service-scope.ts` closed one layer down. Pass
 *      `expectedService`; the result now reports `serviceChecked` so a caller
 *      that forgets can see that it forgot.
 *
 *   3. **`sub` is stable across subscription generations.** The vault PDA is
 *      `[b"subscription_vault", retailer, subscriber_id, token_mint]`, so a
 *      subscriber who cancels and re-subscribes gets the SAME `sub` and the
 *      same PDA. A token minted under the old subscription is therefore
 *      indistinguishable from one minted under the new one, and cancellation
 *      revokes nothing. {@link issueSubscriptionAccessToken} pins the token to
 *      `vaultStartSlot`, which the program rewrites on every subscribe, so
 *      tokens do not survive the subscription they were issued for.
 */

export interface AccessTokenClaims {
  /** Merchant pubkey (base58). Signer of the token. */
  iss: string;
  /** Subscriber ID (stealth pubkey, memo nonce, or opaque string). */
  sub: string;
  /** Service slug. */
  svc: string;
  /** Expiry as unix seconds. */
  exp: number;
  /** Issued-at as unix seconds. */
  iat: number;
  /** Optional random nonce for replay protection. */
  nonce?: string;
  /**
   * Vault PDA (base58) the token was issued against. Written by
   * {@link issueSubscriptionAccessToken}; absent on unbound tokens.
   */
  vault?: string;
  /**
   * The vault's `start_slot` as a decimal string — the subscription's
   * generation. The program writes a fresh `start_slot` on every subscribe, so
   * a token from a cancelled-and-resubscribed vault will not match.
   */
  vaultStartSlot?: string;
  /** Any additional fields the merchant wants to attach. */
  [extra: string]: unknown;
}

export interface IssueAccessTokenInput {
  merchantKeypair: Keypair;
  subscriberId: string;
  serviceSlug: string;
  /** TTL from now, in seconds. */
  ttlSeconds: number;
  /**
   * Hard ceiling on `exp`, in unix seconds. `exp` becomes
   * `min(now + ttlSeconds, notAfterUnix)`.
   *
   * Supply this whenever the token stands for something that ends on its own
   * schedule — a subscription, a trial, a licence. Without it the TTL is the
   * only bound and the token outlives whatever justified it.
   *
   * @throws if the ceiling is already in the past: minting a dead token hides
   *   the real problem behind a generic "expired" at the next request.
   */
  notAfterUnix?: number;
  /** Optional nonce — defaults to a random 16-byte base58 string. */
  nonce?: string;
  /** Additional claims to embed. */
  extraClaims?: Record<string, unknown>;
  /** Clock override, unix seconds. Tests only. */
  nowUnix?: number;
}

export function issueAccessToken(input: IssueAccessTokenInput): string {
  const now = input.nowUnix ?? Math.floor(Date.now() / 1000);
  const ttlExp = now + Math.max(1, Math.floor(input.ttlSeconds));
  let exp = ttlExp;
  if (input.notAfterUnix !== undefined) {
    const ceiling = Math.floor(input.notAfterUnix);
    if (ceiling <= now) {
      throw new Error(
        `refusing to issue an access token that is already expired: notAfterUnix ${ceiling} ` +
          `is at or before now (${now}). Whatever the token stands for has already ended; ` +
          `deny the request instead of handing out a credential that fails at the next hop.`,
      );
    }
    exp = Math.min(ttlExp, ceiling);
  }
  const claims: AccessTokenClaims = {
    iss: input.merchantKeypair.publicKey.toBase58(),
    sub: input.subscriberId,
    svc: input.serviceSlug,
    exp,
    iat: now,
    nonce: input.nonce ?? randomNonce(),
    ...input.extraClaims,
  };

  const payload = Buffer.from(JSON.stringify(claims), 'utf-8');
  const digest = sha256(payload);
  const signature = ed25519.sign(digest, input.merchantKeypair.secretKey.subarray(0, 32));

  return `${bs58.encode(payload)}.${bs58.encode(signature)}`;
}

/** A vault as {@link issueSubscriptionAccessToken} needs to see it. */
export type AccessTokenVault = VaultEntitlementState & {
  /** Vault PDA. Written into the token so it can be re-checked later. */
  pda: PublicKey;
};

export interface IssueSubscriptionAccessTokenInput
  extends Omit<IssueAccessTokenInput, 'notAfterUnix'> {
  /** Freshly fetched vault. Stale state here re-opens the hole this closes. */
  vault: AccessTokenVault;
  /** Slot the vault was read at (`connection.getSlot()`). */
  currentSlot: bigint;
  /**
   * Slot time used to turn the remaining slot budget into a deadline.
   * Defaults to the nominal 400 ms, which under-states real wall time and so
   * expires the token EARLY. Raise it only against a measured cluster.
   */
  slotMs?: bigint;
}

/**
 * Issue an access token that cannot outlive the subscription behind it.
 *
 * `exp` becomes `min(now + ttlSeconds, end of the funded window)`, and the
 * token carries the vault PDA plus the vault's `start_slot` so a later
 * verification can tell it apart from a token minted for a different
 * subscription on the same PDA.
 *
 * @throws if the subscription is not current at `currentSlot` — there is no
 *   honest token to mint for a subscriber who is not entitled.
 */
export function issueSubscriptionAccessToken(
  input: IssueSubscriptionAccessTokenInput,
): string {
  const { vault, currentSlot, slotMs = NOMINAL_SLOT_MS, ...rest } = input;
  if (!subscriptionIsCurrent(vault, currentSlot)) {
    throw new Error(
      `refusing to issue an access token for a subscription that is not current at slot ` +
        `${currentSlot}: isActive=${vault.isActive} isPaused=${vault.isPaused}. ` +
        `is_active is written true at subscribe and false nowhere, so it is not the question — ` +
        `the subscriber has run past the periods they funded.`,
    );
  }
  const now = rest.nowUnix ?? Math.floor(Date.now() / 1000);
  const remaining = secondsUntilSubscriptionEnds(vault, currentSlot, slotMs);
  if (remaining <= 0n) {
    throw new Error(
      `refusing to issue an access token with no subscription time left: the funded window ` +
        `ends in under one second at slot ${currentSlot}`,
    );
  }
  return issueAccessToken({
    ...rest,
    nowUnix: now,
    notAfterUnix: now + Number(remaining),
    extraClaims: {
      ...rest.extraClaims,
      vault: vault.pda.toBase58(),
      vaultStartSlot: vault.startSlot.toString(10),
    },
  });
}

export interface VerifyAccessTokenOptions {
  /**
   * Service slug the token is being presented FOR. Supply it and `svc` becomes
   * enforceable; omit it and a token minted for one of the merchant's services
   * authenticates against every other one.
   */
  expectedService?: string;
  /** Vault PDA the token must name. Only meaningful for vault-bound tokens. */
  expectedVault?: PublicKey | string;
  /**
   * Re-check the subscription itself against freshly-read chain state. This is
   * the only thing that can notice a subscription that ended, was paused, or
   * was cancelled and re-created since the token was minted.
   */
  subscription?: {
    vault: AccessTokenVault;
    currentSlot: bigint;
  };
  /** Clock override, unix seconds. Tests only. */
  nowUnix?: number;
}

export interface VerifyAccessTokenResult {
  valid: boolean;
  claims: AccessTokenClaims | null;
  reason?: string;
  /**
   * False when no `expectedService` was supplied: the `svc` claim was NOT
   * enforced and this token would also pass for the merchant's other services.
   */
  serviceChecked: boolean;
  /**
   * False when no `subscription` was supplied: `exp` is the only bound, and a
   * subscription that ended early is invisible here.
   */
  subscriptionChecked: boolean;
}

export function verifyAccessToken(
  token: string,
  expectedMerchant: PublicKey,
  opts: VerifyAccessTokenOptions = {},
): VerifyAccessTokenResult {
  const serviceChecked = opts.expectedService !== undefined;
  const subscriptionChecked = opts.subscription !== undefined;
  const bad = (
    claims: AccessTokenClaims | null,
    reason: string,
  ): VerifyAccessTokenResult => ({ valid: false, claims, reason, serviceChecked, subscriptionChecked });

  const parts = token.split('.');
  if (parts.length !== 2) return bad(null, 'malformed token');

  let payload: Buffer;
  let signature: Buffer;
  try {
    payload = Buffer.from(bs58.decode(parts[0]!));
    signature = Buffer.from(bs58.decode(parts[1]!));
  } catch {
    return bad(null, 'bad base58 encoding');
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(payload.toString('utf-8')) as AccessTokenClaims;
  } catch {
    return bad(null, 'payload is not valid JSON');
  }

  if (claims.iss !== expectedMerchant.toBase58()) {
    return bad(claims, `issuer mismatch (expected ${expectedMerchant.toBase58()})`);
  }

  const digest = sha256(payload);
  let ok = false;
  try {
    ok = ed25519.verify(signature, digest, expectedMerchant.toBytes());
  } catch (err) {
    return bad(claims, `signature verify threw: ${(err as Error).message}`);
  }
  if (!ok) return bad(claims, 'signature invalid');

  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now) {
    return bad(claims, 'token expired');
  }

  if (opts.expectedService !== undefined && claims.svc !== opts.expectedService) {
    return bad(
      claims,
      `token is scoped to service "${claims.svc}", not "${opts.expectedService}"`,
    );
  }

  if (opts.expectedVault !== undefined) {
    const want =
      typeof opts.expectedVault === 'string' ? opts.expectedVault : opts.expectedVault.toBase58();
    if (claims.vault === undefined) {
      return bad(claims, 'token is not bound to a vault, so it cannot be checked against one');
    }
    if (claims.vault !== want) {
      return bad(claims, `token names vault ${claims.vault}, not ${want}`);
    }
  }

  if (opts.subscription) {
    const { vault, currentSlot } = opts.subscription;
    if (claims.vault !== undefined && claims.vault !== vault.pda.toBase58()) {
      return bad(claims, `token names vault ${claims.vault}, not ${vault.pda.toBase58()}`);
    }
    // The generation check. `start_slot` is rewritten on every subscribe, so a
    // token minted before a cancel + re-subscribe names a slot the live vault
    // no longer has. Without it, `sub` being stable means the old token keeps
    // working inside the new subscription's window.
    if (
      claims.vaultStartSlot !== undefined &&
      claims.vaultStartSlot !== vault.startSlot.toString(10)
    ) {
      return bad(
        claims,
        `token was issued for a different subscription on this vault ` +
          `(token start_slot ${claims.vaultStartSlot}, on-chain ${vault.startSlot})`,
      );
    }
    if (!subscriptionIsCurrent(vault, currentSlot)) {
      return bad(
        claims,
        vault.isPaused
          ? 'subscription is paused'
          : 'subscription has run past the periods it was funded for',
      );
    }
  }

  return { valid: true, claims, serviceChecked, subscriptionChecked };
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((b) => b === 0)) {
    // Fallback for older runtimes (should never happen in Node 18+).
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bs58.encode(bytes);
}
