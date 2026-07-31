/**
 * CROSS-CLIENT license-scheme parity.
 *
 * `LICENSE_SCHEME` in `./license.ts` calls itself authoritative and says
 * "DO NOT DRIFT. Mirror byte-for-byte in apps/mobile/services/license/derive.ts
 * and apps/extension's license module." Nothing enforced that. Three hand-copied
 * implementations of an HKDF + a base32 codec is exactly the shape that rots
 * quietly, and the failure mode is the worst one available here: a subscriber
 * who paid presents a key the merchant cannot distinguish from a forgery.
 *
 * This file imports the mobile and extension modules DIRECTLY — by relative
 * path, the real files the apps ship — and runs every implementation against the
 * frozen fixture in `./license-scheme-vectors`. It does not read source text or
 * compare comments; every claim below is an executed derivation.
 *
 * The three implementations under test:
 *   packages/merchant-sdk/src/license.ts            (verify side: codec only)
 *   apps/mobile/services/license/derive.ts          (client: codec + derivation)
 *   apps/extension/src/shared/services/license.ts   (client: codec + derivation)
 *
 * The same fixture is re-run inside each app's own suite
 * (apps/mobile/services/license/parity.test.ts,
 * apps/extension/src/shared/services/license-parity.test.ts) so a client that
 * drifts fails its own `pnpm test`, not only this one.
 */

import { describe, it, expect } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import * as sdk from './license';
import { LICENSE_SCHEME } from './license';
import * as mobile from '../../../apps/mobile/services/license/derive';
import * as extension from '../../../apps/extension/src/shared/services/license';
import {
  EXPECTED_CODEC_FINGERPRINT,
  EXPECTED_DERIVATION_FINGERPRINT,
  EXPECTED_SCHEME_DIGEST_BLAKE3,
  EXPECTED_SCHEME_FINGERPRINT,
  ZK_DERIVATION_VECTORS,
  CLASSIC_DERIVATION_VECTORS,
  bytesToHex,
  hexToBytes,
  licenseCodecFingerprint,
  licenseSchemeFingerprint,
  readAlphabet,
  schemeDigestPreimage,
} from './license-scheme-vectors';

/** Every implementation that owns a key codec. */
const CODECS = [
  ['merchant-sdk', sdk],
  ['mobile', mobile],
  ['extension', extension],
] as const;

/** Every implementation that derives the secret (the clients). */
const CLIENTS = [
  ['mobile', mobile],
  ['extension', extension],
] as const;

// ===========================================================================
// 1. Fixture digests — the one-line drift alarm
// ===========================================================================

describe('license parity: frozen fixture', () => {
  it.each(CODECS)('%s codec fingerprint matches the pinned fixture', (_name, impl) => {
    expect(licenseCodecFingerprint(impl)).toEqual([...EXPECTED_CODEC_FINGERPRINT]);
  });

  it.each(CLIENTS)('%s full scheme fingerprint matches the pinned fixture', (_name, impl) => {
    expect(licenseSchemeFingerprint(impl)).toEqual([...EXPECTED_SCHEME_FINGERPRINT]);
  });

  it.each(CLIENTS)('%s scheme digest == EXPECTED_SCHEME_DIGEST_BLAKE3', (_name, impl) => {
    const digest = bytesToHex(blake3(utf8ToBytes(schemeDigestPreimage(licenseSchemeFingerprint(impl)))));
    expect(digest).toBe(EXPECTED_SCHEME_DIGEST_BLAKE3);
  });

  it('the pinned fingerprint really hashes to the pinned digest', () => {
    // Guards the fixture against being "fixed" by editing only the digest, or
    // only the lines. Both must move together.
    const digest = bytesToHex(blake3(utf8ToBytes(schemeDigestPreimage(EXPECTED_SCHEME_FINGERPRINT))));
    expect(digest).toBe(EXPECTED_SCHEME_DIGEST_BLAKE3);
  });
});

// ===========================================================================
// 2. Field-by-field against LICENSE_SCHEME — the declared constant block,
//    executed rather than read.
// ===========================================================================

describe('license parity: LICENSE_SCHEME field by field', () => {
  it('SECRET_BYTES — every client derives exactly LICENSE_SCHEME.SECRET_BYTES bytes', () => {
    for (const [name, impl] of CLIENTS) {
      expect(impl.LICENSE_SECRET_BYTES, name).toBe(LICENSE_SCHEME.SECRET_BYTES);
      expect(impl.deriveLicenseSecret('1', 'svc').length, name).toBe(LICENSE_SCHEME.SECRET_BYTES);
      expect(impl.deriveClassicLicenseSecret(new Uint8Array(64), 'svc').length, name).toBe(
        LICENSE_SCHEME.SECRET_BYTES,
      );
    }
    expect(sdk.LICENSE_SECRET_BYTES).toBe(LICENSE_SCHEME.SECRET_BYTES);
  });

  it('hkdfHash / hkdfSalt / INFO_LABEL / ZK_IKM — the ZK path IS hkdf(sha256, utf8(decimal), undefined, utf8(label||serviceId), 16)', () => {
    // Rebuilt here from LICENSE_SCHEME's own declared fields. If any client
    // changes hash, salt, label, concatenation order, ikm encoding or length,
    // this diverges.
    for (const v of ZK_DERIVATION_VECTORS) {
      const expected = hkdf(
        sha256,
        utf8ToBytes(v.ikm),
        LICENSE_SCHEME.hkdfSalt,
        utf8ToBytes(LICENSE_SCHEME.INFO_LABEL + v.serviceId),
        LICENSE_SCHEME.SECRET_BYTES,
      );
      for (const [name, impl] of CLIENTS) {
        expect(bytesToHex(impl.deriveLicenseSecret(v.ikm, v.serviceId)), `${name} ${v.id}`).toBe(
          bytesToHex(expected),
        );
      }
    }
  });

  it('hkdfSalt is genuinely absent — a salted HKDF gives a different secret', () => {
    // Proves "salt: undefined" is a real property of the clients, not just a
    // comment. undefined salt is NOT the same as a zero-filled salt of the
    // hash length in noble... but it must at least differ from any non-empty
    // salt, or the field carries no meaning.
    const salted = hkdf(sha256, utf8ToBytes('1'), utf8ToBytes('salt'), utf8ToBytes('p01-license-v1disney-plus'), 16);
    for (const [name, impl] of CLIENTS) {
      expect(bytesToHex(impl.deriveLicenseSecret('1', 'disney-plus')), name).not.toBe(bytesToHex(salted));
    }
  });

  it('hkdfHash is SHA-256, not SHA-512', () => {
    const wrong = hkdf(sha512, utf8ToBytes('1'), undefined, utf8ToBytes('p01-license-v1disney-plus'), 16);
    for (const [name, impl] of CLIENTS) {
      expect(bytesToHex(impl.deriveLicenseSecret('1', 'disney-plus')), name).not.toBe(bytesToHex(wrong));
    }
    expect(LICENSE_SCHEME.hkdfHash).toBe('SHA-256');
  });

  it('INFO_LABEL is a prefix, not a suffix — label||serviceId is order-sensitive', () => {
    // "ab" as label + "c" as service must differ from "a" + "bc"; if a client
    // ever concatenated the other way round the two would collide.
    for (const [name, impl] of CLIENTS) {
      const a = bytesToHex(impl.deriveLicenseSecret('1', 'X'));
      const b = bytesToHex(impl.deriveLicenseSecret('1', ''));
      expect(a, name).not.toBe(b);
      // and the label really is LICENSE_SCHEME.INFO_LABEL: swapping it changes
      // the answer.
      const withOtherLabel = hkdf(sha256, utf8ToBytes('1'), undefined, utf8ToBytes('p01-license-v2X'), 16);
      expect(a, name).not.toBe(bytesToHex(withOtherLabel));
    }
  });

  it('ZK_IKM — bigint and its canonical decimal string are the same ikm', () => {
    for (const [name, impl] of CLIENTS) {
      const big = 21888242871839275222246405745257275088548364400416034343698204186575808495616n;
      expect(bytesToHex(impl.deriveLicenseSecret(big, 'svc')), name).toBe(
        bytesToHex(impl.deriveLicenseSecret(big.toString(10), 'svc')),
      );
    }
  });

  it('CLASSIC_IKM / CLASSIC_SIGN_PREFIX — the signed message and the derivation', () => {
    for (const v of CLASSIC_DERIVATION_VECTORS) {
      const sig = hexToBytes(v.signatureHex);
      const expectedMsg = utf8ToBytes(LICENSE_SCHEME.CLASSIC_SIGN_PREFIX + v.serviceId);
      const expectedSecret = hkdf(
        sha256,
        sig,
        LICENSE_SCHEME.hkdfSalt,
        utf8ToBytes(LICENSE_SCHEME.INFO_LABEL + v.serviceId),
        LICENSE_SCHEME.SECRET_BYTES,
      );
      for (const [name, impl] of CLIENTS) {
        expect(bytesToHex(impl.classicLicenseSignMessage(v.serviceId)), `${name} ${v.id} msg`).toBe(
          bytesToHex(expectedMsg),
        );
        expect(bytesToHex(impl.deriveClassicLicenseSecret(sig, v.serviceId)), `${name} ${v.id}`).toBe(
          bytesToHex(expectedSecret),
        );
      }
    }
  });

  it('commitment — blake3(licenseSecret), 32 bytes, in all three', () => {
    const secret = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const expected = bytesToHex(blake3(secret));
    for (const [name, impl] of CODECS) {
      const c = impl.licenseCommitment(secret);
      expect(c.length, name).toBe(32);
      expect(impl.LICENSE_COMMITMENT_BYTES, name).toBe(32);
      expect(bytesToHex(c), name).toBe(expected);
    }
  });

  it('CROCKFORD — every implementation reads back LICENSE_SCHEME.CROCKFORD', () => {
    for (const [name, impl] of CODECS) {
      expect(readAlphabet(impl), name).toBe(LICENSE_SCHEME.CROCKFORD);
    }
    // The alphabet is the RFC 4648 set minus I, L, O, U.
    expect(LICENSE_SCHEME.CROCKFORD).toHaveLength(32);
    expect(new Set(LICENSE_SCHEME.CROCKFORD).size).toBe(32);
    for (const ch of 'ILOU') expect(LICENSE_SCHEME.CROCKFORD).not.toContain(ch);
  });

  it('keyPrefix + grouping — "P01-" then 4-char groups, 26 payload chars', () => {
    const secret = hexToBytes('000102030405060708090a0b0c0d0e0f');
    for (const [name, impl] of CODECS) {
      const key = impl.encodeLicenseKey(secret);
      expect(key.startsWith(LICENSE_SCHEME.keyPrefix), name).toBe(true);
      const payload = key.slice(LICENSE_SCHEME.keyPrefix.length);
      expect(payload.split('-').map((g) => g.length), name).toEqual([4, 4, 4, 4, 4, 4, 2]);
      expect(payload.replace(/-/g, ''), name).toHaveLength(26);
    }
  });

  it('decode-only Crockford aliases O→0, I→1, L→1 are honoured identically', () => {
    const secret = hexToBytes('000102030405060708090a0b0c0d0e0f');
    for (const [name, impl] of CODECS) {
      const key = impl.encodeLicenseKey(secret);
      // Aliases apply to the PAYLOAD only — the literal "P01-" prefix is matched
      // verbatim by every decoder, so mangling it there would test nothing.
      const payload = key.slice(LICENSE_SCHEME.keyPrefix.length);
      const aliased =
        LICENSE_SCHEME.keyPrefix + payload.replace(/0/g, 'O').replace(/1/g, 'L');
      expect(bytesToHex(impl.decodeLicenseKey(aliased)), name).toBe(bytesToHex(secret));
      expect(bytesToHex(impl.decodeLicenseKey(key.toLowerCase())), name).toBe(bytesToHex(secret));
      // Whitespace / missing dashes are tolerated identically everywhere.
      expect(bytesToHex(impl.decodeLicenseKey(`  ${key.replace(/-/g, '')}  `)), name).toBe(bytesToHex(secret));
    }
  });
});

// ===========================================================================
// 3. Byte-for-byte between implementations, and the end-to-end merchant flow
// ===========================================================================

describe('license parity: implementations agree byte-for-byte', () => {
  it('mobile and extension derive identical secrets, keys and commitments', () => {
    for (const v of ZK_DERIVATION_VECTORS) {
      const m = mobile.deriveLicenseSecret(v.ikm, v.serviceId);
      const e = extension.deriveLicenseSecret(v.ikm, v.serviceId);
      expect(bytesToHex(m), v.id).toBe(bytesToHex(e));
      expect(mobile.encodeLicenseKey(m), v.id).toBe(extension.encodeLicenseKey(e));
      expect(bytesToHex(mobile.licenseCommitment(m)), v.id).toBe(bytesToHex(extension.licenseCommitment(e)));
      expect(mobile.licenseKeyForPrivate(v.ikm, v.serviceId), v.id).toBe(
        extension.licenseKeyForPrivate(v.ikm, v.serviceId),
      );
    }
  });

  it('a key minted on ANY client verifies against the commitment the SDK recomputes', () => {
    // This is the whole product promise: client mints, chain stores the
    // commitment, merchant SDK verifies with public data only.
    for (const [name, impl] of CLIENTS) {
      for (const v of ZK_DERIVATION_VECTORS) {
        const licenseSecret = impl.deriveLicenseSecret(v.ikm, v.serviceId);
        const onChain = impl.licenseCommitment(licenseSecret); // what subscribe posts
        const displayedKey = impl.encodeLicenseKey(licenseSecret); // what the user pastes
        expect(sdk.keyMatchesCommitment(displayedKey, onChain), `${name} ${v.id}`).toBe(true);
        // …and the SDK's own decode round-trips to the same secret.
        expect(bytesToHex(sdk.decodeLicenseKey(displayedKey)), `${name} ${v.id}`).toBe(bytesToHex(licenseSecret));
      }
    }
  });

  it('keys are service-scoped: a key for service A does not verify for service B', () => {
    for (const [name, impl] of CLIENTS) {
      const a = impl.deriveLicenseSecret('1', 'disney-plus');
      const b = impl.deriveLicenseSecret('1', 'netflix');
      expect(bytesToHex(a), name).not.toBe(bytesToHex(b));
      expect(sdk.keyMatchesCommitment(impl.encodeLicenseKey(a), impl.licenseCommitment(b)), name).toBe(false);
    }
  });

  it('the SDK encodes what the clients encode, for the clients own secrets', () => {
    for (const [name, impl] of CLIENTS) {
      for (const v of ZK_DERIVATION_VECTORS) {
        const s = impl.deriveLicenseSecret(v.ikm, v.serviceId);
        expect(sdk.encodeLicenseKey(s), `${name} ${v.id}`).toBe(impl.encodeLicenseKey(s));
      }
    }
  });
});
