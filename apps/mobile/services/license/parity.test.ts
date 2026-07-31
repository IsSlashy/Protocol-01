/**
 * Mobile side of the cross-client license-scheme parity gate.
 *
 * The full three-way comparison lives in
 * `packages/merchant-sdk/src/license-parity.test.ts`. This file re-runs the SAME
 * frozen fixture against the mobile implementation alone, inside the mobile
 * suite, so that editing `derive.ts` fails `pnpm --filter mobile test` directly
 * instead of only failing a test in another package that a mobile-focused change
 * would never run.
 *
 * A drifted client mints a key that verifies against nothing. To the merchant
 * that is indistinguishable from a forged key, so the subscriber is refused
 * service for something they paid for. That is the whole reason this exists.
 */

import { describe, it, expect } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import * as mobile from './derive';
import {
  EXPECTED_SCHEME_DIGEST_BLAKE3,
  EXPECTED_SCHEME_FINGERPRINT,
  bytesToHex,
  licenseSchemeFingerprint,
  schemeDigestPreimage,
} from '../../../../packages/merchant-sdk/src/license-scheme-vectors';

describe('license scheme parity (mobile)', () => {
  it('mobile derive.ts matches the pinned cross-client fingerprint line for line', () => {
    expect(licenseSchemeFingerprint(mobile)).toEqual([...EXPECTED_SCHEME_FINGERPRINT]);
  });

  it('mobile derive.ts matches the pinned scheme digest', () => {
    const digest = bytesToHex(blake3(utf8ToBytes(schemeDigestPreimage(licenseSchemeFingerprint(mobile)))));
    expect(digest).toBe(EXPECTED_SCHEME_DIGEST_BLAKE3);
  });

  it('the test vector quoted in the derive.ts header is the real output', () => {
    const secret = new Uint8Array(16);
    for (let i = 0; i < 16; i++) secret[i] = i;
    expect(mobile.encodeLicenseKey(secret)).toBe('P01-000G-40R4-0M30-E209-185G-R38E-1W');
    expect(bytesToHex(mobile.licenseCommitment(secret))).toBe(
      'a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3',
    );
  });
});
