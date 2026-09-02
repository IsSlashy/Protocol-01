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
import {
  encodeLicenseKey,
  decodeLicenseKey,
  licenseCommitment,
  keyMatchesCommitment,
  deriveLicenseSalt,
  deriveLicenseSecretV2,
  LICENSE_SECRET_BYTES,
} from './license';
import { hexToBytes } from './license-scheme-vectors';
import { decodeSubscriptionVault } from './vaults';
import { blake3 } from '@noble/hashes/blake3.js';
import { Buffer } from 'buffer';

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

// ---------------------------------------------------------------------------
// 4. license keys — commitment scheme (no shared secret, forgery resistance)
// ---------------------------------------------------------------------------

describe('license key encode/decode', () => {
  it('round-trips a 16-byte licenseSecret through encode → decode', () => {
    const secret = new Uint8Array(LICENSE_SECRET_BYTES);
    for (let i = 0; i < secret.length; i++) secret[i] = (i * 37 + 11) & 0xff;
    const key = encodeLicenseKey(secret);
    expect(key.startsWith('P01-')).toBe(true);
    expect(decodeLicenseKey(key)).toEqual(secret);
  });

  it('round-trips an all-zero and an all-ones secret', () => {
    const zero = new Uint8Array(LICENSE_SECRET_BYTES).fill(0x00);
    const ones = new Uint8Array(LICENSE_SECRET_BYTES).fill(0xff);
    expect(decodeLicenseKey(encodeLicenseKey(zero))).toEqual(zero);
    expect(decodeLicenseKey(encodeLicenseKey(ones))).toEqual(ones);
  });

  it('tolerates lowercase, missing prefix, and dashes/spacing on decode', () => {
    const secret = new Uint8Array(LICENSE_SECRET_BYTES).fill(0x5a);
    const key = encodeLicenseKey(secret); // "P01-XXXX-..."
    const noPrefix = key.slice(4); // drop "P01-"
    const messy = `  ${key.toLowerCase().replace(/-/g, ' ')}  `;
    expect(decodeLicenseKey(noPrefix)).toEqual(secret);
    expect(decodeLicenseKey(messy)).toEqual(secret);
  });

  it('rejects an empty / malformed key', () => {
    expect(() => decodeLicenseKey('')).toThrow();
    expect(() => decodeLicenseKey('P01-')).toThrow();
  });

  it('test vector (frozen) — extension must match byte-for-byte', () => {
    // licenseSecret = 0x000102...0f (16 bytes). The key string and commitment
    // below are the canonical reference for the mobile + extension mirrors.
    const secret = new Uint8Array(16);
    for (let i = 0; i < 16; i++) secret[i] = i;
    const key = encodeLicenseKey(secret);
    const commitmentHex = Buffer.from(licenseCommitment(secret)).toString('hex');
    // Lock the values so any drift in encoding/hashing fails loudly.
    expect(key).toBe('P01-000G-40R4-0M30-E209-185G-R38E-1W');
    expect(commitmentHex).toBe(
      'a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3',
    );
    // Sanity: decode reproduces the secret.
    expect(decodeLicenseKey(key)).toEqual(secret);
  });

  it('v2 test vector (frozen) from docs/LICENSE_KEY_V2-2026-09-02.md: salt, secret, key, commitment', () => {
    // identitySeed 01..20, noteSecret "1234", serviceTag "svc". The same vector
    // is pinned in the mobile and extension parity tests.
    const identitySeed = hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
    const salt = deriveLicenseSalt(identitySeed);
    expect(Buffer.from(salt).toString('hex')).toBe(
      '058f3c959dba16c347e5e291f65e6d7a26824f1006e541d0b4aba79004c90e6a',
    );
    const secret = deriveLicenseSecretV2('1234', 'svc', identitySeed);
    expect(Buffer.from(secret).toString('hex')).toBe('de00e41667d82798b62825793d51be69');
    const key = encodeLicenseKey(secret);
    expect(key).toBe('P01-VR0E-85K7-V0KS-HDH8-4NWK-TMDY-D4');
    expect(Buffer.from(licenseCommitment(secret)).toString('hex')).toBe(
      '852e98e702bc79617d20199cf25753264b0da206e2835e476caf4b4e865b8fac',
    );
    // Verification is scheme-agnostic: blake3(decode(key)) and nothing else.
    expect(keyMatchesCommitment(key, licenseCommitment(secret))).toBe(true);
    expect(decodeLicenseKey(key)).toEqual(secret);
  });
});

describe('license commitment + verification (commitment scheme)', () => {
  // The on-chain commitment a subscriber posts.
  const licenseSecret = (() => {
    const s = new Uint8Array(LICENSE_SECRET_BYTES);
    for (let i = 0; i < s.length; i++) s[i] = (i * 13 + 7) & 0xff;
    return s;
  })();

  it('commitment = blake3(licenseSecret) and is 32 bytes', () => {
    const c = licenseCommitment(licenseSecret);
    expect(c.length).toBe(32);
    expect(Buffer.from(c)).toEqual(Buffer.from(blake3(licenseSecret)));
  });

  it('ROUND-TRIP: a key issued from licenseSecret verifies against its on-chain commitment', () => {
    // Client: derive key + commitment from the same secret.
    const key = encodeLicenseKey(licenseSecret);
    const onChainCommitment = licenseCommitment(licenseSecret); // stored verbatim on-chain.

    // Merchant: decode the presented key, blake3 it, compare to the commitment.
    expect(keyMatchesCommitment(key, onChainCommitment)).toBe(true);
  });

  it('FORGERY REJECTED: attacker with vault PDA + serviceId + on-chain commitment (but NOT the secret) cannot produce a verifying key', () => {
    // Everything the attacker can see publicly:
    const vaultPda = new PublicKey(new Uint8Array(32).fill(0x55)).toBytes();
    const serviceId = 'disney-plus';
    const onChainCommitment = licenseCommitment(licenseSecret); // a blake3 image — public on-chain.
    void vaultPda; void serviceId;

    // The attacker's best efforts WITHOUT the preimage licenseSecret:
    //  (a) try to reuse the commitment bytes as if they were a secret;
    const forgeFromCommitment = encodeLicenseKey(onChainCommitment.subarray(0, LICENSE_SECRET_BYTES));
    //  (b) hash the public vault PDA + serviceId (the old secret-less idea);
    const enc = new TextEncoder();
    const guessSecret = blake3(
      new Uint8Array([...vaultPda, ...enc.encode(serviceId)]),
      { dkLen: LICENSE_SECRET_BYTES },
    );
    const forgeFromPublicData = encodeLicenseKey(guessSecret);
    //  (c) a random 16-byte guess.
    const randomGuess = encodeLicenseKey(new Uint8Array(LICENSE_SECRET_BYTES).fill(0xaa));

    expect(keyMatchesCommitment(forgeFromCommitment, onChainCommitment)).toBe(false);
    expect(keyMatchesCommitment(forgeFromPublicData, onChainCommitment)).toBe(false);
    expect(keyMatchesCommitment(randomGuess, onChainCommitment)).toBe(false);

    // Only the genuine secret produces a verifying key.
    expect(keyMatchesCommitment(encodeLicenseKey(licenseSecret), onChainCommitment)).toBe(true);
  });

  it('a malformed key never throws in verification, just fails', () => {
    const onChainCommitment = licenseCommitment(licenseSecret);
    expect(keyMatchesCommitment('not-a-real-key-!!!', onChainCommitment)).toBe(false);
    expect(keyMatchesCommitment('', onChainCommitment)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. vault decoder — trailing client_stealth_meta + license_commitment offsets
// ---------------------------------------------------------------------------

const VAULT_DISC = [96, 90, 247, 202, 157, 16, 86, 190];

/**
 * A REAL `SubscriptionVault` account captured live from devnet
 * (account 72n5rpWb2qaPSnnzUjbnoWqQ7qJkESWrA3MQbN3K1TZ, program
 * GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c) — len 328, private mode,
 * client_stealth_meta SOME, license_commitment NONE. Used as a regression guard
 * so the variable-width Borsh decode is validated against ground truth (under
 * the old fixed-width-None bug, `retailer` decoded to all-zeros / system program).
 */
const REAL_VAULT_HEX =
  '605af7ca9d1056be000130eac88f0f49d1ba000000000000000000000000000000000000000000000000175fd5ff7689f023598a33f4db5b7e8a3333ea6305cad8f70af129e693d9d233000000000000000000000000000000000000000000000000000000000000000000e1f5050000000080f0fa020000000080e06200000000008293c21b0000000000000000000000000100000000000000000000a64ead4b3a24448b2bf246de8f1ac62a3e0956bed54b7abd1915fbc9244d703301f7944f20410137dd38d8e9709c97fc0b4fe88db86773bb182c83fc804be398bdfe01b51749ad138f3d0d3432e25ef76bd3fa7e3f128cb6feb9179a6a2e83c7db81c2f2ea6dee638f9bef1fc5afb30bc4d1be34abc8da6aa3661060c069652ffe1c3900000000000000000000000000000000000000000000000000000000000000000000000000000000';
const REAL_VAULT_RETAILER = '2aF8pZzbycK5N3nM6nFXLLSJKe8uQ2M7s5rPRa4VmPiJ';

/** Anchor `init` space for a SubscriptionVault (matches Rust `LEN`). The fixed
 *  account allocation; Borsh serializes variable-width inside it, leaving
 *  trailing zero padding. */
const VAULT_LEN =
  8 + 33 + 33 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 9 + 8 + 32 + 33 + 1 + 65 + 33;

/**
 * Build a synthetic SubscriptionVault account body as TRUE Borsh:
 *   - `Option::None`  => a SINGLE `0` tag byte (NO value bytes).
 *   - `Option::Some`  => `1` tag + value bytes.
 * Exactly one of subscriber_pubkey / subscriber_commitment is Some (mode), the
 * other is None — so `retailer` lands at the mode-invariant offset 42.
 *
 * `mode`: 'private' (pubkey None, commitment Some) or 'normal' (pubkey Some,
 * commitment None). `padToLen`: zero-pad the body up to the fixed account size
 * (mirrors a real Anchor-init'd account; the program leaves trailing zeros that
 * decode as None for trailing Options).
 */
function buildVaultBuf(opts: {
  mode?: 'private' | 'normal';
  retailer?: Uint8Array;
  stealth?: Uint8Array | null;
  license?: Uint8Array | null;
  padToLen?: boolean;
}): Buffer {
  const mode = opts.mode ?? 'private';
  const retailer = opts.retailer ?? new Uint8Array(32).fill(0x22);
  const parts: Buffer[] = [];
  parts.push(Buffer.from(VAULT_DISC)); // 8

  // subscriber_pubkey: Option<Pubkey> — TRUE Borsh None = 1 byte.
  if (mode === 'normal') {
    parts.push(Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 0x99)])); // Some (33)
  } else {
    parts.push(Buffer.from([0])); // None (1 byte ONLY — not 33)
  }
  // subscriber_commitment: Option<[u8;32]>
  if (mode === 'private') {
    parts.push(Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 0x11)])); // Some (33)
  } else {
    parts.push(Buffer.from([0])); // None (1 byte ONLY)
  }

  parts.push(Buffer.from(retailer)); // retailer (32) — must land at offset 42
  parts.push(Buffer.alloc(32, 0x33)); // token_mint
  for (let i = 0; i < 5; i++) parts.push(Buffer.alloc(8)); // total,rate,interval,start,claimed
  parts.push(Buffer.from([1, 0])); // is_active, is_paused
  parts.push(Buffer.from([0])); // pause_slot None — 1 byte ONLY (not 9)
  parts.push(Buffer.alloc(8)); // total_paused_slots i64
  parts.push(Buffer.alloc(32, 0x44)); // vk_hash
  parts.push(Buffer.from([0])); // source_pool None — 1 byte ONLY (not 33)
  parts.push(Buffer.from([7])); // bump

  // client_stealth_meta: Option<[u8;64]>
  if (opts.stealth) {
    parts.push(Buffer.concat([Buffer.from([1]), Buffer.from(opts.stealth)]));
  } else {
    parts.push(Buffer.from([0])); // None — 1 byte
  }
  // license_commitment: Option<[u8;32]>
  if (opts.license) {
    parts.push(Buffer.concat([Buffer.from([1]), Buffer.from(opts.license)]));
  } else {
    parts.push(Buffer.from([0])); // None — 1 byte
  }

  let body = Buffer.concat(parts);
  if (opts.padToLen && body.length < VAULT_LEN) {
    body = Buffer.concat([body, Buffer.alloc(VAULT_LEN - body.length)]); // zero pad
  }
  return body;
}

describe('decodeSubscriptionVault — variable-width Borsh + trailing license_commitment', () => {
  const pda = new PublicKey(new Uint8Array(32).fill(0x66));

  it('retailer lands at the mode-invariant offset 42 in BOTH modes (variable-width)', () => {
    const retailer = new Uint8Array(32);
    for (let i = 0; i < 32; i++) retailer[i] = (i * 7 + 3) & 0xff;
    const want = new PublicKey(retailer).toBase58();
    for (const mode of ['private', 'normal'] as const) {
      const buf = buildVaultBuf({ mode, retailer });
      // Sanity: retailer bytes truly sit at offset 42 in the serialized buffer.
      expect(Buffer.from(buf.subarray(42, 74))).toEqual(Buffer.from(retailer));
      const v = decodeSubscriptionVault(buf, pda);
      expect(v.retailer.toBase58()).toBe(want);
      // token_mint follows correctly (would be zeros under the old fixed-width bug).
      expect(Buffer.from(v.tokenMint.toBytes())).toEqual(Buffer.from(new Uint8Array(32).fill(0x33)));
      // Mode is encoded via which leading Option is Some.
      if (mode === 'private') {
        expect(v.subscriberPubkey).toBeNull();
        expect(v.subscriberCommitment).not.toBeNull();
      } else {
        expect(v.subscriberPubkey).not.toBeNull();
        expect(v.subscriberCommitment).toBeNull();
      }
    }
  });

  it('legacy account (no trailing bytes after bump) decodes both trailing fields as null', () => {
    // Truncate right after bump to simulate a pre-stealth/pre-license vault.
    const full = buildVaultBuf({ mode: 'private' });
    // bump is the last byte before client_stealth_meta tag; find it: body up to
    // and including bump = full minus the two trailing None tag bytes (2 bytes).
    const legacy = full.subarray(0, full.length - 2);
    const v = decodeSubscriptionVault(legacy, pda);
    expect(v.clientStealthMeta).toBeNull();
    expect(v.licenseCommitment).toBeNull();
    // retailer still correct.
    expect(Buffer.from(v.retailer.toBytes())).toEqual(Buffer.from(new Uint8Array(32).fill(0x22)));
  });

  it('fully-allocated (padded to LEN) account with both None tags decodes both as null', () => {
    const buf = buildVaultBuf({ mode: 'private', padToLen: true });
    const v = decodeSubscriptionVault(buf, pda);
    expect(v.clientStealthMeta).toBeNull();
    expect(v.licenseCommitment).toBeNull();
  });

  it('license_commitment Some is read at the correct offset (stealth None, padded)', () => {
    const license = new Uint8Array(32);
    for (let i = 0; i < 32; i++) license[i] = (i + 1) & 0xff;
    const buf = buildVaultBuf({ mode: 'private', stealth: null, license, padToLen: true });
    const v = decodeSubscriptionVault(buf, pda);
    expect(v.clientStealthMeta).toBeNull();
    expect(v.licenseCommitment).not.toBeNull();
    expect(Buffer.from(v.licenseCommitment!)).toEqual(Buffer.from(license));
  });

  it('both stealth Some and license Some decode at correct offsets', () => {
    const stealth = new Uint8Array(64).fill(0xab);
    const license = new Uint8Array(32).fill(0xcd);
    const buf = buildVaultBuf({ mode: 'private', stealth, license });
    const v = decodeSubscriptionVault(buf, pda);
    expect(Buffer.from(v.clientStealthMeta!)).toEqual(Buffer.from(stealth));
    expect(Buffer.from(v.licenseCommitment!)).toEqual(Buffer.from(license));
  });

  it('end-to-end: a key verifies against the decoded vault commitment', () => {
    const ls = new Uint8Array(LICENSE_SECRET_BYTES);
    for (let i = 0; i < ls.length; i++) ls[i] = (i * 9 + 3) & 0xff;
    const commitment = licenseCommitment(ls);
    // Real vaults are init'd at full LEN and Borsh-serialized variable-width;
    // emit stealth None (1-byte tag) + license Some, padded to LEN.
    const buf = buildVaultBuf({ mode: 'private', license: commitment, padToLen: true });
    const v = decodeSubscriptionVault(buf, pda);
    const key = encodeLicenseKey(ls);
    expect(v.licenseCommitment).not.toBeNull();
    expect(keyMatchesCommitment(key, v.licenseCommitment!)).toBe(true);
  });

  it('REAL devnet layout: a recorded on-chain vault decodes to a valid non-zero retailer + correct trailing fields', () => {
    // A real `len=328` private vault captured from devnet (program
    // GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c) with client_stealth_meta
    // SOME and license_commitment NONE. This is the canonical regression guard:
    // under the old fixed-width-None bug the retailer decoded to all-zeros.
    const buf = Buffer.from(REAL_VAULT_HEX, 'hex');
    expect(buf.length).toBe(328);
    const v = decodeSubscriptionVault(buf, pda);
    // retailer is a real, non-zero pubkey at offset 42 (NOT the system program).
    expect(v.retailer.toBase58()).toBe(REAL_VAULT_RETAILER);
    expect(v.retailer.equals(PublicKey.default)).toBe(false);
    // Private mode: subscriber_pubkey None, subscriber_commitment Some.
    expect(v.subscriberPubkey).toBeNull();
    expect(v.subscriberCommitment).not.toBeNull();
    // This vault has a stealth meta (Some) and no license (None).
    expect(v.clientStealthMeta).not.toBeNull();
    expect(v.licenseCommitment).toBeNull();
  });
});
