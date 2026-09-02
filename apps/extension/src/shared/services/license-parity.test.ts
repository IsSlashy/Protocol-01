/**
 * Extension side of the cross-client license-scheme parity gate.
 *
 * The full three-way comparison lives in
 * `packages/merchant-sdk/src/license-parity.test.ts`. This file re-runs the SAME
 * frozen fixture against the extension implementation alone, inside the
 * extension suite, so that editing `license.ts` fails `pnpm --filter extension
 * test` directly instead of only failing a test in another package that an
 * extension-focused change would never run.
 *
 * A drifted client mints a key that verifies against nothing. To the merchant
 * that is indistinguishable from a forged key, so the subscriber is refused
 * service for something they paid for. That is the whole reason this exists.
 */

import { describe, it, expect } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import * as extension from './license';
import {
  EXPECTED_SCHEME_DIGEST_BLAKE3,
  EXPECTED_SCHEME_FINGERPRINT,
  EXPECTED_V2_FINGERPRINT,
  LICENSE_V2_VECTOR,
  bytesToHex,
  hexToBytes,
  licenseSchemeFingerprint,
  licenseV2Fingerprint,
  schemeDigestPreimage,
} from '../../../../../packages/merchant-sdk/src/license-scheme-vectors';

describe('license scheme parity (extension)', () => {
  it('extension license.ts matches the pinned cross-client fingerprint line for line', () => {
    expect(licenseSchemeFingerprint(extension)).toEqual([...EXPECTED_SCHEME_FINGERPRINT]);
  });

  it('extension license.ts matches the pinned scheme digest', () => {
    const digest = bytesToHex(blake3(utf8ToBytes(schemeDigestPreimage(licenseSchemeFingerprint(extension)))));
    expect(digest).toBe(EXPECTED_SCHEME_DIGEST_BLAKE3);
  });

  it('the test vector quoted in the license.ts header is the real output', () => {
    const secret = new Uint8Array(16);
    for (let i = 0; i < 16; i++) secret[i] = i;
    expect(extension.encodeLicenseKey(secret)).toBe('P01-000G-40R4-0M30-E209-185G-R38E-1W');
    expect(bytesToHex(extension.licenseCommitment(secret))).toBe(
      'a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3',
    );
  });

  it('the v2 vector from docs/LICENSE_KEY_V2-2026-09-02.md is the real output (additive; v1 fixture untouched)', () => {
    expect(licenseV2Fingerprint(extension)).toEqual([...EXPECTED_V2_FINGERPRINT]);
    const seed = hexToBytes(LICENSE_V2_VECTOR.identitySeedHex);
    expect(bytesToHex(extension.deriveLicenseSalt(seed))).toBe(LICENSE_V2_VECTOR.licenseSaltHex);
    const secret = extension.deriveLicenseSecretV2(LICENSE_V2_VECTOR.noteSecret, LICENSE_V2_VECTOR.serviceTag, seed);
    expect(bytesToHex(secret)).toBe(LICENSE_V2_VECTOR.licenseSecretHex);
    expect(extension.encodeLicenseKey(secret)).toBe(LICENSE_V2_VECTOR.key);
    expect(bytesToHex(extension.licenseCommitment(secret))).toBe(LICENSE_V2_VECTOR.commitmentHex);
    // bigint and decimal string are the same ikm, as in v1.
    expect(bytesToHex(extension.deriveLicenseSecretV2(1234n, 'svc', seed))).toBe(LICENSE_V2_VECTOR.licenseSecretHex);
    // v2 is a different key from v1 for the same note and tag.
    expect(bytesToHex(extension.deriveLicenseSecret(LICENSE_V2_VECTOR.noteSecret, LICENSE_V2_VECTOR.serviceTag))).not.toBe(
      LICENSE_V2_VECTOR.licenseSecretHex,
    );
  });
});
