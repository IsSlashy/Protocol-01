/**
 * license v2: the vector every mirror pins, and the v1 vector left as it is.
 *
 * `docs/LICENSE_KEY_V2-2026-09-02.md` fixes the derivation and the numbers
 * below; the merchant SDK, mobile and the extension assert the same table. A
 * mirror that drifts mints a key the user believes in and no merchant
 * accepts, so the module also checks itself at load; this file makes the
 * check visible in a test run and pins the properties around it.
 *
 * Runs under `vitest.pool.config.mts` (node). Nothing is mocked.
 */

import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  LICENSE_SCHEME_V2,
  decodeLicenseKey,
  deriveLicenseSalt,
  deriveLicenseSecret,
  deriveLicenseSecretV2,
  encodeLicenseKey,
  licenseCommitment,
  licenseKeyForPrivateV2,
} from './license';

/** 0102...20: the identity seed of the spec vector. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

const VECTOR = {
  seedHex: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  noteSecret: '1234',
  serviceTag: 'svc',
  licenseSalt: '058f3c959dba16c347e5e291f65e6d7a26824f1006e541d0b4aba79004c90e6a',
  licenseSecret: 'de00e41667d82798b62825793d51be69',
  key: 'P01-VR0E-85K7-V0KS-HDH8-4NWK-TMDY-D4',
  commitment: '852e98e702bc79617d20199cf25753264b0da206e2835e476caf4b4e865b8fac',
};

describe('license v2: the spec vector', () => {
  it('the fixture seed is the one the spec names', () => {
    expect(bytesToHex(SEED)).toBe(VECTOR.seedHex);
  });

  it('salt, secret, key and commitment match the spec byte for byte', () => {
    expect(bytesToHex(deriveLicenseSalt(SEED))).toBe(VECTOR.licenseSalt);
    const secret = deriveLicenseSecretV2(VECTOR.noteSecret, VECTOR.serviceTag, SEED);
    expect(bytesToHex(secret)).toBe(VECTOR.licenseSecret);
    expect(encodeLicenseKey(secret)).toBe(VECTOR.key);
    expect(bytesToHex(licenseCommitment(secret))).toBe(VECTOR.commitment);
    expect(licenseKeyForPrivateV2(VECTOR.noteSecret, VECTOR.serviceTag, SEED)).toBe(VECTOR.key);
  });

  it('the merchant check holds on the key string: blake3(decode(key)) is the commitment', () => {
    expect(bytesToHex(licenseCommitment(decodeLicenseKey(VECTOR.key)))).toBe(VECTOR.commitment);
  });

  it('a bigint note secret and its decimal string derive the same secret', () => {
    expect(bytesToHex(deriveLicenseSecretV2(1234n, 'svc', SEED))).toBe(VECTOR.licenseSecret);
    expect(bytesToHex(deriveLicenseSecretV2(' 1234 ', 'svc', SEED))).toBe(VECTOR.licenseSecret);
  });

  it('the same inputs under v1 give a different key: a v1 vault is not a v2 vault', () => {
    expect(encodeLicenseKey(deriveLicenseSecret('1234', 'svc'))).not.toBe(VECTOR.key);
  });

  it('the identity seed is in the derivation: another seed, another key', () => {
    const other = new Uint8Array(32).fill(9);
    expect(licenseKeyForPrivateV2('1234', 'svc', other)).not.toBe(VECTOR.key);
    expect(bytesToHex(deriveLicenseSalt(other))).not.toBe(VECTOR.licenseSalt);
  });

  it('the service tag is in the derivation, exactly as under v1', () => {
    expect(licenseKeyForPrivateV2('1234', 'svc2', SEED)).not.toBe(VECTOR.key);
    expect(licenseKeyForPrivateV2('1234', 'SVC', SEED)).not.toBe(VECTOR.key);
  });

  it('refuses a seed that is not 32 bytes rather than deriving from it', () => {
    expect(() => deriveLicenseSalt(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => deriveLicenseSecretV2('1234', 'svc', new Uint8Array(33))).toThrow(/32 bytes/);
  });

  it('the constant block describes the code', () => {
    expect(LICENSE_SCHEME_V2.SECRET_BYTES).toBe(16);
    expect(LICENSE_SCHEME_V2.SALT_BYTES).toBe(32);
    expect(LICENSE_SCHEME_V2.IDENTITY_SEED_BYTES).toBe(32);
    expect(LICENSE_SCHEME_V2.SALT_INFO_LABEL).toBe('p01-license-salt-v2');
    expect(LICENSE_SCHEME_V2.INFO_LABEL).toBe('p01-license-v2');
    expect(LICENSE_SCHEME_V2.keyPrefix).toBe('P01-');
    expect(deriveLicenseSecretV2('1234', 'svc', SEED)).toHaveLength(LICENSE_SCHEME_V2.SECRET_BYTES);
    expect(deriveLicenseSalt(SEED)).toHaveLength(LICENSE_SCHEME_V2.SALT_BYTES);
  });
});

describe('license v1: the frozen vector stays as it is', () => {
  it('000102...0f still encodes and commits to the v1 vector', () => {
    const v = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(encodeLicenseKey(v)).toBe('P01-000G-40R4-0M30-E209-185G-R38E-1W');
    expect(bytesToHex(licenseCommitment(v))).toBe(
      'a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3',
    );
  });
});
