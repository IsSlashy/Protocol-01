// @vitest-environment node
// Pure crypto — no DOM. The frozen license scheme MUST match
// apps/mobile/services/license/derive.ts and packages/merchant-sdk byte-for-byte
// so a key minted in the extension verifies on the merchant side.
import { describe, it, expect } from 'vitest';
import {
  deriveLicenseSecret,
  licenseCommitment,
  encodeLicenseKey,
  decodeLicenseKey,
  licenseKeyForPrivate,
  LICENSE_SECRET_BYTES,
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
