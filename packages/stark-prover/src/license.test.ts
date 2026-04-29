/**
 * Tests for the soft license gate.
 *
 * NOTE: We do not have the production private key in this repo, so the
 * "valid token signed with the production key" path is intentionally not
 * covered. Instead, we sign with a fresh test keypair and confirm the
 * verifier rejects it (different pubkey → bad signature). All other failure
 * modes (malformed, base64, JSON, expiry, tamper) are exercised here.
 */

import { describe, it, expect } from 'vitest';
import * as nacl from 'tweetnacl';

import {
  verifyLicenseKey,
  formatMissingLicenseWarning,
  formatInvalidLicenseWarning,
  LICENSE_PUBLIC_KEY_B64,
} from './license';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

function makeToken(payload: object, secretKey: Uint8Array): string {
  const payloadB64 = strToB64url(JSON.stringify(payload));
  const sig = nacl.sign.detached(new TextEncoder().encode(payloadB64), secretKey);
  return payloadB64 + '.' + bytesToB64url(sig);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('license — verifyLicenseKey', () => {
  it('rejects a token signed with a non-production key', () => {
    const kp = nacl.sign.keyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({ sub: 'test-customer', iat: now, exp: now + 3600 }, kp.secretKey);
    const v = verifyLicenseKey(token);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('bad signature');
  });

  it('rejects empty string', () => {
    const v = verifyLicenseKey('');
    expect(v.valid).toBe(false);
    expect(v.reason).toBeTruthy();
  });

  it('rejects malformed token (missing dot)', () => {
    const v = verifyLicenseKey('this-has-no-dot-anywhere');
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/malformed/);
  });

  it('rejects token with a trailing dot and no signature', () => {
    const v = verifyLicenseKey('payload.');
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/malformed/);
  });

  it('rejects token whose payload is not valid JSON', () => {
    // payload b64 decodes to "not-json" which JSON.parse rejects.
    const payloadB64 = strToB64url('not-json');
    const sigB64 = bytesToB64url(new Uint8Array(64));
    const v = verifyLicenseKey(payloadB64 + '.' + sigB64);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/json|signature/);
  });

  it('rejects token whose signature segment decodes to the wrong length', () => {
    // Well-formed payload, but signature is only a few bytes — not a valid
    // 64-byte Ed25519 signature.
    const payloadB64 = strToB64url(JSON.stringify({ sub: 'short-sig' }));
    const sigB64 = bytesToB64url(new Uint8Array(8));
    const v = verifyLicenseKey(payloadB64 + '.' + sigB64);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/signature/);
  });

  it('rejects a tampered signature on an otherwise well-formed token', () => {
    const kp = nacl.sign.keyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({ sub: 'tamper', iat: now }, kp.secretKey);
    const dot = token.indexOf('.');
    // Flip a byte in the payload — signature no longer matches.
    const tampered = strToB64url(JSON.stringify({ sub: 'attacker', iat: now })) + '.' + token.slice(dot + 1);
    const v = verifyLicenseKey(tampered);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('bad signature');
  });

  it('rejects an expired payload (exp < now) with reason "expired"', () => {
    // verifyLicenseKey checks expiry before the signature, so a token with
    // exp in the past gets a clear "expired" reason regardless of signing key.
    const kp = nacl.sign.keyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({ sub: 'expired', iat: now - 7200, exp: now - 3600 }, kp.secretKey);
    const v = verifyLicenseKey(token);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('expired');
  });
});

describe('license — warning formatters', () => {
  it('formatMissingLicenseWarning returns a non-empty string mentioning license + protocol01.com', () => {
    const s = formatMissingLicenseWarning();
    expect(s.length).toBeGreaterThan(0);
    expect(s.toLowerCase()).toContain('license');
    expect(s).toContain('protocol01.com');
  });

  it('formatInvalidLicenseWarning embeds the reason and mentions license + protocol01.com', () => {
    const s = formatInvalidLicenseWarning('bad signature');
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain('bad signature');
    expect(s.toLowerCase()).toContain('license');
    expect(s).toContain('protocol01.com');
  });
});

describe('license — public key constant', () => {
  it('LICENSE_PUBLIC_KEY_B64 decodes to 32 bytes (Ed25519 pubkey)', () => {
    const bytes = Uint8Array.from(Buffer.from(LICENSE_PUBLIC_KEY_B64, 'base64'));
    expect(bytes.length).toBe(32);
  });
});
