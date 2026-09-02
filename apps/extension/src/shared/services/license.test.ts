// @vitest-environment node
// Pure crypto — no DOM. The frozen license scheme MUST match
// apps/mobile/services/license/derive.ts and packages/merchant-sdk byte-for-byte
// so a key minted in the extension verifies on the merchant side.
import { describe, it, expect } from 'vitest';
import {
  deriveLicenseSecret,
  deriveLicenseSalt,
  deriveLicenseSecretV2,
  licenseCommitment,
  encodeLicenseKey,
  decodeLicenseKey,
  licenseKeyForPrivate,
  LICENSE_SECRET_BYTES,
  LICENSE_SALT_BYTES,
} from './license';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('license scheme (frozen — must match mobile + merchant-sdk byte-for-byte)', () => {
  it('FROZEN TEST VECTOR: secret 000102..0f → key + commitment', () => {
    // licenseSecret = 0x000102...0f (16 bytes), serviceId-independent.
    const secret = new Uint8Array(LICENSE_SECRET_BYTES);
    for (let i = 0; i < LICENSE_SECRET_BYTES; i++) secret[i] = i;

    const key = encodeLicenseKey(secret);
    const commitmentHex = toHex(licenseCommitment(secret));

    // Lock the values so any drift in encoding/hashing fails loudly.
    expect(key).toBe('P01-000G-40R4-0M30-E209-185G-R38E-1W');
    expect(commitmentHex).toBe(
      'a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3',
    );

    // Round-trip: decode reproduces the secret exactly.
    expect(decodeLicenseKey(key)).toEqual(secret);
  });

  it('decodeLicenseKey tolerates casing, whitespace, missing prefix', () => {
    const secret = new Uint8Array(LICENSE_SECRET_BYTES);
    for (let i = 0; i < LICENSE_SECRET_BYTES; i++) secret[i] = i;
    const key = encodeLicenseKey(secret);
    expect(decodeLicenseKey(key.toLowerCase())).toEqual(secret);
    expect(decodeLicenseKey(`  ${key}  `)).toEqual(secret);
    expect(decodeLicenseKey(key.replace('P01-', ''))).toEqual(secret);
  });

  it('rejects empty / malformed keys', () => {
    expect(() => decodeLicenseKey('')).toThrow();
    expect(() => decodeLicenseKey('P01-')).toThrow();
  });

  it('deriveLicenseSecret is deterministic and 16 bytes; bigint == decimal-string ikm', () => {
    const noteSecret = 123456789012345678901234567890n;
    const serviceId = 'GhostRetailerPubkeyBase58xxxxxxxxxxxxxxxxxxxx';
    const a = deriveLicenseSecret(noteSecret, serviceId);
    const b = deriveLicenseSecret(noteSecret.toString(10), serviceId);
    expect(a.length).toBe(LICENSE_SECRET_BYTES);
    expect(toHex(a)).toBe(toHex(b)); // bigint and its decimal string yield identical ikm
  });

  it('serviceId scoping: different serviceId → different licenseSecret (same note secret)', () => {
    const noteSecret = 999n;
    const k1 = deriveLicenseSecret(noteSecret, 'serviceA');
    const k2 = deriveLicenseSecret(noteSecret, 'serviceB');
    expect(toHex(k1)).not.toBe(toHex(k2));
  });

  it('licenseKeyForPrivate == encodeLicenseKey(deriveLicenseSecret(...)) (display matches commitment input)', () => {
    const noteSecret = 42n;
    const serviceId = 'svc-disney-plus';
    const expectedKey = encodeLicenseKey(deriveLicenseSecret(noteSecret, serviceId));
    expect(licenseKeyForPrivate(noteSecret, serviceId)).toBe(expectedKey);
  });

  it('adversarial: blake3(decode(displayed key)) === posted commitment (merchant accepts)', () => {
    // The exact flow: derive secret → post blake3(secret) on-chain, display
    // encodeLicenseKey(secret). The merchant decodes the presented key and
    // blake3s it; it MUST equal the posted commitment.
    const noteSecret = 7777777n;
    const serviceId = 'RetailerXYZ';
    const secret = deriveLicenseSecret(noteSecret, serviceId);
    const postedCommitment = licenseCommitment(secret); // on-chain license_commitment
    const displayedKey = encodeLicenseKey(secret);       // shown to the user

    const merchantRecomputed = licenseCommitment(decodeLicenseKey(displayedKey));
    expect(toHex(merchantRecomputed)).toBe(toHex(postedCommitment));
  });
});

describe('license scheme v2 (additive; docs/LICENSE_KEY_V2-2026-09-02.md)', () => {
  // identitySeed 01..20: the spec vector, also pinned in license-parity.test.ts.
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 1;

  it('FROZEN V2 VECTOR: seed 01..20, note "1234", tag "svc" -> salt, secret, key, commitment', () => {
    expect(toHex(seed)).toBe('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
    expect(toHex(deriveLicenseSalt(seed))).toBe(
      '058f3c959dba16c347e5e291f65e6d7a26824f1006e541d0b4aba79004c90e6a',
    );
    const secret = deriveLicenseSecretV2('1234', 'svc', seed);
    expect(toHex(secret)).toBe('de00e41667d82798b62825793d51be69');
    expect(encodeLicenseKey(secret)).toBe('P01-VR0E-85K7-V0KS-HDH8-4NWK-TMDY-D4');
    expect(toHex(licenseCommitment(secret))).toBe(
      '852e98e702bc79617d20199cf25753264b0da206e2835e476caf4b4e865b8fac',
    );
    expect(decodeLicenseKey(encodeLicenseKey(secret))).toEqual(secret);
  });

  it('salt is 32 bytes, secret is 16 bytes; bigint == decimal-string ikm', () => {
    expect(deriveLicenseSalt(seed).length).toBe(LICENSE_SALT_BYTES);
    const a = deriveLicenseSecretV2(1234n, 'svc', seed);
    const b = deriveLicenseSecretV2('1234', 'svc', seed);
    expect(a.length).toBe(LICENSE_SECRET_BYTES);
    expect(toHex(a)).toBe(toHex(b));
  });

  it('the identity seed matters: same note and tag, different seed, different key', () => {
    const other = new Uint8Array(32).fill(0x42);
    expect(toHex(deriveLicenseSecretV2('1234', 'svc', seed))).not.toBe(
      toHex(deriveLicenseSecretV2('1234', 'svc', other)),
    );
  });

  it('serviceId scoping holds under v2', () => {
    expect(toHex(deriveLicenseSecretV2('1234', 'serviceA', seed))).not.toBe(
      toHex(deriveLicenseSecretV2('1234', 'serviceB', seed)),
    );
  });

  it('v2 is not v1: the same note secret and tag give unrelated secrets', () => {
    expect(toHex(deriveLicenseSecretV2('1234', 'svc', seed))).not.toBe(toHex(deriveLicenseSecret('1234', 'svc')));
  });

  it('a seed of the wrong length is refused', () => {
    expect(() => deriveLicenseSalt(seed.subarray(0, 31))).toThrow();
    expect(() => deriveLicenseSecretV2('1234', 'svc', new Uint8Array(16))).toThrow();
  });
});
