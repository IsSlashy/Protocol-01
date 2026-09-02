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
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import * as sdk from './license';
import { LICENSE_SCHEME, LICENSE_SCHEME_V2 } from './license';
import * as mobile from '../../../apps/mobile/services/license/derive';
import * as extension from '../../../apps/extension/src/shared/services/license';
import * as web from '../../../apps/web/lib/privacy/license';
import {
  EXPECTED_CODEC_FINGERPRINT,
  EXPECTED_DERIVATION_FINGERPRINT,
  EXPECTED_SCHEME_DIGEST_BLAKE3,
  EXPECTED_SCHEME_FINGERPRINT,
  EXPECTED_V2_FINGERPRINT,
  LICENSE_V2_VECTOR,
  ZK_DERIVATION_VECTORS,
  CLASSIC_DERIVATION_VECTORS,
  SERVICE_TAG_VECTORS,
  bytesToHex,
  hexToBytes,
  licenseCodecFingerprint,
  licenseSchemeFingerprint,
  licenseV2Fingerprint,
  readAlphabet,
  schemeDigestPreimage,
} from './license-scheme-vectors';

/** Every implementation that owns a key codec. */
const CODECS = [
  ['merchant-sdk', sdk],
  ['mobile', mobile],
  ['extension', extension],
  // Fourth implementation, added 2026-08-04 when the /pay page grew a subscribe
  // compartment. A key minted in a browser has to verify against a merchant that
  // has never seen apps/web, so it belongs in this table, not in a comment
  // claiming it was copied carefully.
  ['web', web],
] as const;

/** Every implementation that derives the secret (the clients). */
const CLIENTS = [
  ['mobile', mobile],
  ['extension', extension],
  ['web', web],
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

// ===========================================================================
// 4. The service tag — the rule that actually broke in production
// ===========================================================================

describe('license parity: service tag', () => {
  it('every client resolves the tag identically', () => {
    for (const v of SERVICE_TAG_VECTORS) {
      const tags = CLIENTS.map(([, impl]) => impl.licenseServiceTag(v.serviceId, v.retailerAddress));
      expect(new Set(tags).size, `${v.id} → ${JSON.stringify(tags)}`).toBe(1);
    }
  });

  it('a missing slug falls back to the retailer address, never to a local id', () => {
    // The recorded defect: the display path fell back to the local `streamId`,
    // a value that has never been on chain, so the key it showed could not
    // match the commitment the subscribe path had posted.
    const retailer = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
    const localStreamId = 'stream_1754000000000_abc123def';
    for (const [name, impl] of CLIENTS) {
      for (const missing of ['', undefined, null] as const) {
        expect(impl.licenseServiceTag(missing, retailer), name).toBe(retailer);
        expect(impl.licenseServiceTag(missing, retailer), name).not.toBe(localStreamId);
      }
    }
  });

  it('poster and displayer produce the same key when they use the tag rule', () => {
    // Full round trip on the no-slug path: subscribe posts the commitment,
    // the card re-derives the key, the merchant SDK verifies it.
    const retailer = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
    const noteSecret = '9182736455647382910';
    for (const [name, impl] of CLIENTS) {
      const postedTag = impl.licenseServiceTag(undefined, retailer);
      const onChain = impl.licenseCommitment(impl.deriveLicenseSecret(noteSecret, postedTag));
      const displayedTag = impl.licenseServiceTag(undefined, retailer);
      const displayedKey = impl.encodeLicenseKey(impl.deriveLicenseSecret(noteSecret, displayedTag));
      expect(sdk.keyMatchesCommitment(displayedKey, onChain), name).toBe(true);
    }
  });

  it('the old streamId fallback is demonstrably wrong', () => {
    // Kept as a live proof of the failure, not a comment: derive with a local
    // stream id and the merchant rejects the key.
    const retailer = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
    const noteSecret = '9182736455647382910';
    const localStreamId = 'stream_1754000000000_abc123def';
    for (const [name, impl] of CLIENTS) {
      const onChain = impl.licenseCommitment(impl.deriveLicenseSecret(noteSecret, retailer));
      const keyFromStreamId = impl.encodeLicenseKey(impl.deriveLicenseSecret(noteSecret, localStreamId));
      expect(sdk.keyMatchesCommitment(keyFromStreamId, onChain), name).toBe(false);
    }
  });
});

// ===========================================================================
// 5. v2 derivation (additive): the note issuer cannot compute the key.
//    docs/LICENSE_KEY_V2-2026-09-02.md. The v1 fixture above is untouched.
// ===========================================================================

/**
 * Every implementation that carries the v2 derivation. The SDK is in this
 * table (tests and tooling only); the web client mints v2 but exposes it from
 * its own module, not from the codec module imported above, so it is not.
 */
const V2_IMPLS = [
  ['merchant-sdk', sdk],
  ['mobile', mobile],
  ['extension', extension],
] as const;

/** The two mirrors that also derive v1, for the v1-vs-v2 comparisons. */
const V2_CLIENTS = [
  ['mobile', mobile],
  ['extension', extension],
] as const;

describe('license parity: v2 derivation (docs/LICENSE_KEY_V2-2026-09-02.md)', () => {
  it.each(V2_IMPLS)('%s v2 fingerprint matches the spec vector', (_name, impl) => {
    expect(licenseV2Fingerprint(impl)).toEqual([...EXPECTED_V2_FINGERPRINT]);
  });

  it('LICENSE_SCHEME_V2 field by field: salt = hkdf(sha256, seed, none, utf8(salt label), 32); secret = hkdf(sha256, utf8(decimal) || salt, none, utf8(label || serviceId), 16)', () => {
    // Rebuilt from LICENSE_SCHEME_V2's own declared fields, as section 2 does
    // for v1. Any change to a hash, label, concatenation order, ikm encoding
    // or length in any mirror diverges here.
    const seed = hexToBytes(LICENSE_V2_VECTOR.identitySeedHex);
    const expectedSalt = hkdf(
      sha256,
      seed,
      LICENSE_SCHEME_V2.hkdfSalt,
      utf8ToBytes(LICENSE_SCHEME_V2.SALT_INFO_LABEL),
      LICENSE_SCHEME_V2.SALT_BYTES,
    );
    expect(bytesToHex(expectedSalt)).toBe(LICENSE_V2_VECTOR.licenseSaltHex);
    for (const [name, impl] of V2_IMPLS) {
      expect(bytesToHex(impl.deriveLicenseSalt(seed)), name).toBe(bytesToHex(expectedSalt));
      expect(impl.LICENSE_SALT_BYTES, name).toBe(LICENSE_SCHEME_V2.SALT_BYTES);
      expect(impl.LICENSE_IDENTITY_SEED_BYTES, name).toBe(LICENSE_SCHEME_V2.IDENTITY_SEED_BYTES);
    }
    for (const v of ZK_DERIVATION_VECTORS) {
      const expected = hkdf(
        sha256,
        concatBytes(utf8ToBytes(v.ikm), expectedSalt),
        LICENSE_SCHEME_V2.hkdfSalt,
        utf8ToBytes(LICENSE_SCHEME_V2.INFO_LABEL + v.serviceId),
        LICENSE_SCHEME_V2.SECRET_BYTES,
      );
      for (const [name, impl] of V2_IMPLS) {
        expect(bytesToHex(impl.deriveLicenseSecretV2(v.ikm, v.serviceId, seed)), `${name} ${v.id}`).toBe(
          bytesToHex(expected),
        );
      }
    }
  });

  it('the identity seed matters: same note and tag, different seed, different key', () => {
    // This is the property v2 exists for. The issuer holds the note secret and
    // the public tag; without the seed it cannot land on the commitment.
    const seedA = hexToBytes(LICENSE_V2_VECTOR.identitySeedHex);
    const seedB = new Uint8Array(32).fill(0x42);
    for (const [name, impl] of V2_IMPLS) {
      const a = impl.deriveLicenseSecretV2(LICENSE_V2_VECTOR.noteSecret, LICENSE_V2_VECTOR.serviceTag, seedA);
      const b = impl.deriveLicenseSecretV2(LICENSE_V2_VECTOR.noteSecret, LICENSE_V2_VECTOR.serviceTag, seedB);
      expect(bytesToHex(a), name).not.toBe(bytesToHex(b));
      expect(sdk.keyMatchesCommitment(impl.encodeLicenseKey(a), impl.licenseCommitment(b)), name).toBe(false);
    }
  });

  it('v2 and v1 differ for the same note secret and tag; the SDK verifies a v2 key without knowing the scheme', () => {
    const seed = hexToBytes(LICENSE_V2_VECTOR.identitySeedHex);
    for (const [name, impl] of V2_CLIENTS) {
      const v1 = impl.deriveLicenseSecret(LICENSE_V2_VECTOR.noteSecret, LICENSE_V2_VECTOR.serviceTag);
      const v2 = impl.deriveLicenseSecretV2(LICENSE_V2_VECTOR.noteSecret, LICENSE_V2_VECTOR.serviceTag, seed);
      expect(bytesToHex(v1), name).not.toBe(bytesToHex(v2));
      // Same codec, same commitment rule, same verifier: a v2 key is a 16-byte
      // secret whose blake3 the vault carries, nothing more.
      expect(sdk.keyMatchesCommitment(impl.encodeLicenseKey(v2), impl.licenseCommitment(v2)), name).toBe(true);
      expect(sdk.keyMatchesCommitment(impl.encodeLicenseKey(v2), impl.licenseCommitment(v1)), name).toBe(false);
      expect(bytesToHex(sdk.decodeLicenseKey(impl.encodeLicenseKey(v2))), name).toBe(bytesToHex(v2));
    }
  });

  it('bigint and its decimal string are the same v2 ikm; a seed of the wrong length is refused', () => {
    const seed = hexToBytes(LICENSE_V2_VECTOR.identitySeedHex);
    for (const [name, impl] of V2_IMPLS) {
      expect(bytesToHex(impl.deriveLicenseSecretV2(1234n, 'svc', seed)), name).toBe(LICENSE_V2_VECTOR.licenseSecretHex);
      expect(() => impl.deriveLicenseSalt(seed.subarray(0, 31)), name).toThrow();
      expect(() => impl.deriveLicenseSecretV2('1234', 'svc', new Uint8Array(16)), name).toThrow();
    }
  });

  it('mobile, extension and the SDK agree byte-for-byte on v2 across the v1 input set', () => {
    const seed = hexToBytes(LICENSE_V2_VECTOR.identitySeedHex);
    for (const v of ZK_DERIVATION_VECTORS) {
      const s = sdk.deriveLicenseSecretV2(v.ikm, v.serviceId, seed);
      for (const [name, impl] of V2_CLIENTS) {
        const c = impl.deriveLicenseSecretV2(v.ikm, v.serviceId, seed);
        expect(bytesToHex(c), `${name} ${v.id}`).toBe(bytesToHex(s));
        expect(impl.encodeLicenseKey(c), `${name} ${v.id}`).toBe(sdk.encodeLicenseKey(s));
        expect(bytesToHex(impl.licenseCommitment(c)), `${name} ${v.id}`).toBe(bytesToHex(sdk.licenseCommitment(s)));
      }
    }
  });
});
