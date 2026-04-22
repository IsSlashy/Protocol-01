import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

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
  /** Any additional fields the merchant wants to attach. */
  [extra: string]: unknown;
}

export interface IssueAccessTokenInput {
  merchantKeypair: Keypair;
  subscriberId: string;
  serviceSlug: string;
  /** TTL from now, in seconds. */
  ttlSeconds: number;
  /** Optional nonce — defaults to a random 16-byte base58 string. */
  nonce?: string;
  /** Additional claims to embed. */
  extraClaims?: Record<string, unknown>;
}

export function issueAccessToken(input: IssueAccessTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    iss: input.merchantKeypair.publicKey.toBase58(),
    sub: input.subscriberId,
    svc: input.serviceSlug,
    exp: now + Math.max(1, Math.floor(input.ttlSeconds)),
    iat: now,
    nonce: input.nonce ?? randomNonce(),
    ...input.extraClaims,
  };

  const payload = Buffer.from(JSON.stringify(claims), 'utf-8');
  const digest = sha256(payload);
  const signature = ed25519.sign(digest, input.merchantKeypair.secretKey.subarray(0, 32));

  return `${bs58.encode(payload)}.${bs58.encode(signature)}`;
}

export interface VerifyAccessTokenResult {
  valid: boolean;
  claims: AccessTokenClaims | null;
  reason?: string;
}

export function verifyAccessToken(
  token: string,
  expectedMerchant: PublicKey,
): VerifyAccessTokenResult {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, claims: null, reason: 'malformed token' };
  }

  let payload: Buffer;
  let signature: Buffer;
  try {
    payload = Buffer.from(bs58.decode(parts[0]!));
    signature = Buffer.from(bs58.decode(parts[1]!));
  } catch {
    return { valid: false, claims: null, reason: 'bad base58 encoding' };
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(payload.toString('utf-8')) as AccessTokenClaims;
  } catch {
    return { valid: false, claims: null, reason: 'payload is not valid JSON' };
  }

  if (claims.iss !== expectedMerchant.toBase58()) {
    return { valid: false, claims, reason: `issuer mismatch (expected ${expectedMerchant.toBase58()})` };
  }

  const digest = sha256(payload);
  let ok = false;
  try {
    ok = ed25519.verify(signature, digest, expectedMerchant.toBytes());
  } catch (err) {
    return { valid: false, claims, reason: `signature verify threw: ${(err as Error).message}` };
  }
  if (!ok) return { valid: false, claims, reason: 'signature invalid' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now) {
    return { valid: false, claims, reason: 'token expired' };
  }

  return { valid: true, claims };
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
