/**
 * Soft licence gate for `@protocol-01/stark-prover`.
 *
 * Verifies a compact, locally-signed JWT-ish token (Ed25519, no network call).
 * In v0.x this only emits a console warning when the key is missing or
 * invalid — proof generation is never blocked. A future v2.0 may harden this.
 */

import * as nacl from 'tweetnacl';

/** Ed25519 public key (32 bytes, base64) for Protocol 01 license tokens. */
export const LICENSE_PUBLIC_KEY_B64 = 'HyKmZKBRG+yWX3prYET5IelfyKXPo9NTRL/OIfeLK5o=';

export interface LicensePayload {
  sub: string;
  iat?: number;
  exp?: number;
}

export interface LicenseVerification {
  valid: boolean;
  payload?: LicensePayload;
  reason?: string;
}

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function b64urlToBytes(s: string): Uint8Array {
  // Accept both base64url and standard base64.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Uint8Array.from(Buffer.from(padded + padding, 'base64'));
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verifyLicenseKey(licenseKey: string): LicenseVerification {
  if (!licenseKey || typeof licenseKey !== 'string') {
    return { valid: false, reason: 'empty' };
  }
  const dot = licenseKey.indexOf('.');
  if (dot < 0 || dot === licenseKey.length - 1) {
    return { valid: false, reason: 'malformed' };
  }
  const payloadB64 = licenseKey.slice(0, dot);
  const sigB64 = licenseKey.slice(dot + 1);

  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  let pubKey: Uint8Array;
  try {
    payloadBytes = b64urlToBytes(payloadB64);
    sigBytes = b64urlToBytes(sigB64);
    pubKey = b64urlToBytes(LICENSE_PUBLIC_KEY_B64);
  } catch {
    return { valid: false, reason: 'invalid base64url' };
  }

  if (sigBytes.length !== 64 || pubKey.length !== 32) {
    return { valid: false, reason: 'invalid signature length' };
  }

  let payload: LicensePayload;
  try {
    const json = new TextDecoder().decode(payloadBytes);
    payload = JSON.parse(json) as LicensePayload;
  } catch {
    return { valid: false, reason: 'invalid json' };
  }

  if (!payload || typeof payload.sub !== 'string') {
    return { valid: false, reason: 'invalid payload' };
  }

  // Check expiry first so legitimate-but-expired tokens get a clear reason
  // rather than being lumped under "bad signature". Comparing a number to the
  // wall clock leaks nothing useful to an attacker.
  if (typeof payload.exp === 'number') {
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp < nowSec) return { valid: false, reason: 'expired' };
  }

  // Signed message is the utf8 bytes of the b64 payload string itself, not
  // the decoded JSON — this matches how compact JWS signs base64url segments.
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(utf8Bytes(payloadB64), sigBytes, pubKey);
  } catch {
    return { valid: false, reason: 'signature error' };
  }
  if (!ok) return { valid: false, reason: 'bad signature' };

  return { valid: true, payload };
}

// ---------------------------------------------------------------------------
// Warning formatters
// ---------------------------------------------------------------------------

export function formatMissingLicenseWarning(): string {
  return '[stark-prover] No license key provided. This is fine for development, evaluation, testing, and hackathon use. Production deployments require a commercial license — see https://protocol01.com/license or contact contact@protocol01.com';
}

export function formatInvalidLicenseWarning(reason: string): string {
  return '[stark-prover] Invalid license key (' + reason + '). Falling back to non-production mode. Contact contact@protocol01.com to renew.';
}
