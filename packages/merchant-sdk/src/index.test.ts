/**
 * Unit tests for @protocol-01/merchant-sdk
 *
 * These tests cover the two pure/offline modules:
 *   1. payments.ts  — parseInvoiceMemo
 *   2. access-token.ts — issueAccessToken / verifyAccessToken round-trip
 *   3. config.ts    — resolveProgramIds cluster guard
 *
 * No network calls are made; everything runs deterministically.
 */

import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

import { parseInvoiceMemo, MEMO_INVOICE_PREFIX } from './payments';
import { issueAccessToken, verifyAccessToken } from './access-token';
import {
  resolveProgramIds,
  ZK_SHIELDED_PROGRAM_ID_DEVNET,
  REGISTRY_PROGRAM_ID_DEVNET,
  type MerchantSdkConfig,
} from './config';

// ---------------------------------------------------------------------------
// 1. parseInvoiceMemo
// ---------------------------------------------------------------------------

describe('parseInvoiceMemo', () => {
  it('returns null for a non-p01 memo', () => {
    expect(parseInvoiceMemo('hello world')).toBeNull();
    expect(parseInvoiceMemo('')).toBeNull();
    expect(parseInvoiceMemo('memo:foo:bar')).toBeNull();
  });

  it('returns null when slug is empty', () => {
    // "p01::" — empty slug between the two colons
    expect(parseInvoiceMemo(`${MEMO_INVOICE_PREFIX}:`)).toBeNull();
    expect(parseInvoiceMemo(`${MEMO_INVOICE_PREFIX}`)).toBeNull();
  });

  it('parses a minimal memo with slug only', () => {
    const result = parseInvoiceMemo('p01:netflix-standard');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('netflix-standard');
    expect(result!.extras).toEqual([]);
    expect(result!.raw).toBe('p01:netflix-standard');
  });

  it('parses a memo with slug + extras', () => {
    const result = parseInvoiceMemo('p01:spotify-premium:3m:abc123');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('spotify-premium');
    expect(result!.extras).toEqual(['3m', 'abc123']);
    expect(result!.raw).toBe('p01:spotify-premium:3m:abc123');
  });

  it('preserves arbitrary extras without interpretation', () => {
    const result = parseInvoiceMemo('p01:my-saas:12:nonce-xyz:extra');
    expect(result!.slug).toBe('my-saas');
    expect(result!.extras).toEqual(['12', 'nonce-xyz', 'extra']);
  });

  it('handles slug containing numbers and hyphens', () => {
    const result = parseInvoiceMemo('p01:service-v2-2026');
    expect(result!.slug).toBe('service-v2-2026');
  });
});

// ---------------------------------------------------------------------------
// 2. issueAccessToken / verifyAccessToken
// ---------------------------------------------------------------------------

describe('access token round-trip', () => {
  // Deterministic keypair for tests — never use in production.
  const seed = new Uint8Array(32).fill(0x42);
  const kp = Keypair.fromSeed(seed);

  it('issues a token that verifies against the same merchant pubkey', () => {
    const token = issueAccessToken({
      merchantKeypair: kp,
      subscriberId: 'user-001',
      serviceSlug: 'netflix-standard',
      ttlSeconds: 3600,
    });

    expect(typeof token).toBe('string');
    expect(token.includes('.')).toBe(true);

    const result = verifyAccessToken(token, kp.publicKey);
    expect(result.valid).toBe(true);
    expect(result.claims).not.toBeNull();
    expect(result.claims!.sub).toBe('user-001');
    expect(result.claims!.svc).toBe('netflix-standard');
    expect(result.claims!.iss).toBe(kp.publicKey.toBase58());
    expect(typeof result.claims!.exp).toBe('number');
    expect(typeof result.claims!.iat).toBe('number');
    expect(result.claims!.exp).toBeGreaterThan(result.claims!.iat);
  });

  it('attaches extraClaims in the payload', () => {
    const token = issueAccessToken({
      merchantKeypair: kp,
      subscriberId: 'user-002',
      serviceSlug: 'spotify',
      ttlSeconds: 60,
      extraClaims: { tier: 'premium', plan: 3 },
    });

    const result = verifyAccessToken(token, kp.publicKey);
    expect(result.valid).toBe(true);
    expect((result.claims as Record<string, unknown>)?.tier).toBe('premium');
    expect((result.claims as Record<string, unknown>)?.plan).toBe(3);
  });

  it('fails verification against a different merchant pubkey', () => {
    const otherKp = Keypair.fromSeed(new Uint8Array(32).fill(0x11));
    const token = issueAccessToken({
      merchantKeypair: kp,
      subscriberId: 'user-003',
      serviceSlug: 'test',
      ttlSeconds: 60,
    });

    const result = verifyAccessToken(token, otherKp.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/issuer mismatch/i);
  });

  it('fails verification when the signature is tampered', () => {
    const token = issueAccessToken({
      merchantKeypair: kp,
      subscriberId: 'user-004',
      serviceSlug: 'test',
      ttlSeconds: 60,
    });

    // Flip the last character of the signature component.
    const parts = token.split('.');
    const sig = parts[1]!;
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'a' ? 'b' : 'a');
    const tampered = `${parts[0]}.${flipped}`;

    const result = verifyAccessToken(tampered, kp.publicKey);
    expect(result.valid).toBe(false);
  });

  it('fails verification for a malformed token (no dot separator)', () => {
    const result = verifyAccessToken('notavalidtoken', kp.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed/i);
  });

  it('fails verification for bad base58 encoding', () => {
    const result = verifyAccessToken('!!!.???', kp.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/base58/i);
  });

  it('returns valid=false with claims set when signature is invalid (not expired)', () => {
    const token = issueAccessToken({
      merchantKeypair: kp,
      subscriberId: 'user-005',
      serviceSlug: 'test',
      ttlSeconds: 3600,
    });

    // Tamper with the payload, keeping the old signature — verify should fail
    // but still return the (now-mismatched) claims.
    const parts = token.split('.');
    // Decode payload, mutate, re-encode.
    const { decodeBase58, encodeBase58 } = (() => {
      // Inline a quick base58 decode/encode using bs58 via dynamic import is not
      // possible in a sync test — instead, just swap a known valid token's
      // signature with the zero signature (64 zeroed bytes, which is invalid).
      return {
        decodeBase58: (_s: string) => new Uint8Array(0),
        encodeBase58: (_b: Uint8Array) => '',
      };
    })();
    void decodeBase58; void encodeBase58;

    // Simpler: build a valid token for a different kp, use its signature with
    // this kp's payload — the issuer will match but the signature will not.
    const otherKp = Keypair.fromSeed(new Uint8Array(32).fill(0x77));
    const otherToken = issueAccessToken({
      merchantKeypair: otherKp,
      subscriberId: 'user-005',
      serviceSlug: 'test',
      ttlSeconds: 3600,
    });
    const otherSig = otherToken.split('.')[1]!;
    const hybridToken = `${parts[0]}.${otherSig}`;

    const result = verifyAccessToken(hybridToken, kp.publicKey);
    expect(result.valid).toBe(false);
    // Claims are decoded before sig verification — claims should be present.
    expect(result.claims).not.toBeNull();
  });

  it('uses an explicit nonce when provided', () => {
    const token = issueAccessToken({
      merchantKeypair: kp,
      subscriberId: 'user-006',
      serviceSlug: 'test',
      ttlSeconds: 60,
      nonce: 'fixed-nonce-for-testing',
    });

    const result = verifyAccessToken(token, kp.publicKey);
    expect(result.valid).toBe(true);
    expect(result.claims!.nonce).toBe('fixed-nonce-for-testing');
  });
});

// ---------------------------------------------------------------------------
// 3. resolveProgramIds — cluster guard
// ---------------------------------------------------------------------------

describe('resolveProgramIds', () => {
  it('returns devnet defaults when no config is supplied', () => {
    const ids = resolveProgramIds();
    expect(ids.zkShielded.equals(ZK_SHIELDED_PROGRAM_ID_DEVNET)).toBe(true);
    expect(ids.registry.equals(REGISTRY_PROGRAM_ID_DEVNET)).toBe(true);
  });

  it('returns devnet defaults when cluster: devnet', () => {
    const ids = resolveProgramIds({ cluster: 'devnet' });
    expect(ids.zkShielded.equals(ZK_SHIELDED_PROGRAM_ID_DEVNET)).toBe(true);
    expect(ids.registry.equals(REGISTRY_PROGRAM_ID_DEVNET)).toBe(true);
  });

  it('throws when cluster: mainnet-beta and no overrides are provided', () => {
    const cfg: MerchantSdkConfig = { cluster: 'mainnet-beta' };
    expect(() => resolveProgramIds(cfg)).toThrow(/not yet deployed on mainnet/i);
  });

  it('accepts mainnet-beta when both program ID overrides are provided', () => {
    const fakeZkShielded = new PublicKey(new Uint8Array(32).fill(0x01));
    const fakeRegistry = new PublicKey(new Uint8Array(32).fill(0x02));
    const cfg: MerchantSdkConfig = {
      cluster: 'mainnet-beta',
      programIds: { zkShielded: fakeZkShielded, registry: fakeRegistry },
    };
    const ids = resolveProgramIds(cfg);
    expect(ids.zkShielded.equals(fakeZkShielded)).toBe(true);
    expect(ids.registry.equals(fakeRegistry)).toBe(true);
  });

  it('partial override: only zkShielded, devnet registry stays', () => {
    const customZk = new PublicKey(new Uint8Array(32).fill(0x03));
    const ids = resolveProgramIds({
      cluster: 'devnet',
      programIds: { zkShielded: customZk },
    });
    expect(ids.zkShielded.equals(customZk)).toBe(true);
    expect(ids.registry.equals(REGISTRY_PROGRAM_ID_DEVNET)).toBe(true);
  });
});
