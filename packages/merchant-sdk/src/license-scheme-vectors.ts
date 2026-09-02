/**
 * Frozen cross-client fixture for the Protocol 01 license-key scheme.
 *
 * `LICENSE_SCHEME` in `./license.ts` says "DO NOT DRIFT. Mirror byte-for-byte in
 * apps/mobile/services/license/derive.ts and apps/extension's license module."
 * Until this file existed, nothing enforced that sentence: three independent
 * copies of the derivation could diverge silently, and the first symptom would
 * be a paying subscriber whose key verifies nowhere — indistinguishable, from
 * the merchant's side, from a forgery.
 *
 * This module is dependency-free on purpose so every workspace can import it by
 * relative path without a build step: the merchant SDK, apps/mobile and
 * apps/extension each run it against their OWN copy of the derivation.
 *
 * ## What is pinned
 *
 * `licenseSchemeFingerprint(impl)` runs a fixed input set through an
 * implementation and returns canonical lines. Comparing those lines to
 * `EXPECTED_*_FINGERPRINT` pins, per implementation and by execution:
 *
 *   - the Crockford alphabet, read out symbol by symbol (`alphabet=`)
 *   - the key prefix and the 4-character grouping (`prefix=`, every `key=`)
 *   - `commitment = blake3(licenseSecret)` (`commit=`)
 *   - the HKDF: hash, absent salt, `info = utf8(label) || utf8(serviceId)`,
 *     output length, and the utf8-decimal ikm encoding for the ZK path
 *     (every `secret=` under `zk/`)
 *   - the classic path ikm (raw 64-byte signature) and the exact bytes a
 *     classic signer must sign (`classic/…|msg=`)
 *
 * Change any one of those in any one client and the corresponding line changes,
 * so the client's own test suite goes red before the drift can ship.
 *
 * ## Regenerating
 *
 * These are not guesses — they are measured output. If the scheme is
 * INTENTIONALLY revised, every client must be revised together and the
 * fingerprint re-measured in the same commit; a lone edit here is the bug this
 * file exists to catch.
 */

// ---------------------------------------------------------------------------
// Implementation shape
// ---------------------------------------------------------------------------

/** The key codec + commitment. Present in all three implementations. */
export interface LicenseCodecImpl {
  encodeLicenseKey(licenseSecret: Uint8Array): string;
  decodeLicenseKey(key: string): Uint8Array;
  licenseCommitment(licenseSecret: Uint8Array): Uint8Array;
}

/**
 * The secret derivation. Present in the CLIENTS only — the merchant SDK
 * deliberately never derives a secret, it only verifies a presented key against
 * the on-chain commitment.
 */
export interface LicenseDerivationImpl {
  deriveLicenseSecret(masterNoteSecret: bigint | string, serviceId: string): Uint8Array;
  deriveClassicLicenseSecret(deterministicSignature: Uint8Array, serviceId: string): Uint8Array;
  classicLicenseSignMessage(serviceId: string): Uint8Array;
  /**
   * The service tag fed to the HKDF `info`. Pinned here because a mismatch
   * between the caller that POSTS the commitment and the caller that DISPLAYS
   * the key is exactly the bug this fixture was written after — and it is
   * invisible to a test that only checks the crypto.
   */
  licenseServiceTag(serviceId: string | null | undefined, retailerAddress: string): string;
}

// ---------------------------------------------------------------------------
// Input vectors
// ---------------------------------------------------------------------------

/** Raw 16-byte secrets — pins the codec and the commitment hash alone. */
export const RAW_SECRET_VECTORS: ReadonlyArray<{ id: string; secretHex: string }> = [
  // The vector quoted in the mobile + extension file headers.
  { id: 'raw/000102..0f', secretHex: '000102030405060708090a0b0c0d0e0f' },
  { id: 'raw/zero', secretHex: '00'.repeat(16) },
  { id: 'raw/ff', secretHex: 'ff'.repeat(16) },
];

/**
 * ZK/private path. `ikm` is the subscriber master note secret as its canonical
 * decimal string. `zk/empty-service` and `zk/unicode-service` pin the utf8
 * encoding and the label||serviceId concatenation order.
 */
export const ZK_DERIVATION_VECTORS: ReadonlyArray<{ id: string; ikm: string; serviceId: string }> = [
  { id: 'zk/registry-slug', ikm: '1', serviceId: 'disney-plus' },
  {
    id: 'zk/registry-slug-2',
    ikm: '21888242871839275222246405745257275088548364400416034343698204186575808495616',
    serviceId: 'netflix',
  },
  // The fallback shape used when a free-form recipient has no registry slug:
  // the retailer's base58 address is the service tag.
  { id: 'zk/retailer-fallback', ikm: '9182736455647382910', serviceId: '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU' },
  { id: 'zk/empty-service', ikm: '42', serviceId: '' },
  { id: 'zk/unicode-service', ikm: '42', serviceId: 'café-日本-🔑' },
];

/**
 * The service-tag rule. `RETAILER` stands in for the retailer's base58 address,
 * which is the tag whenever the recipient has no Service Registry slug.
 */
export const SERVICE_TAG_VECTORS: ReadonlyArray<{
  id: string;
  serviceId: string | null | undefined;
  retailerAddress: string;
}> = [
  { id: 'tag/slug', serviceId: 'disney-plus', retailerAddress: 'RETAILER' },
  { id: 'tag/empty-string', serviceId: '', retailerAddress: 'RETAILER' },
  { id: 'tag/undefined', serviceId: undefined, retailerAddress: 'RETAILER' },
  { id: 'tag/null', serviceId: null, retailerAddress: 'RETAILER' },
  // Not trimmed on purpose — see licenseServiceTag. Normalising would orphan
  // any key already issued against the un-normalised bytes.
  { id: 'tag/whitespace-kept', serviceId: '  ', retailerAddress: 'RETAILER' },
];

/** Classic path — ikm is the raw 64-byte ed25519 signature. */
export const CLASSIC_DERIVATION_VECTORS: ReadonlyArray<{ id: string; signatureHex: string; serviceId: string }> = [
  {
    id: 'classic/sig-00..3f',
    signatureHex: Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, '0')).join(''),
    serviceId: 'disney-plus',
  },
  { id: 'classic/sig-ff', signatureHex: 'ff'.repeat(64), serviceId: '' },
];

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/**
 * Read the Crockford alphabet straight OUT of an implementation, symbol by
 * symbol: a 16-byte input whose leading 5 bits are `i` encodes to a key whose
 * first payload character is `alphabet[i]`. A reordered or mistyped alphabet
 * shows up as a changed string rather than as an unexplained key mismatch.
 */
export function readAlphabet(impl: LicenseCodecImpl): string {
  let alphabet = '';
  for (let i = 0; i < 32; i++) {
    const b = new Uint8Array(16);
    b[0] = i << 3;
    alphabet += impl.encodeLicenseKey(b)[4];
  }
  return alphabet;
}

/** Canonical lines for the codec half of the scheme (all three implementations). */
export function licenseCodecFingerprint(impl: LicenseCodecImpl): string[] {
  const lines: string[] = [];
  lines.push(`alphabet=${readAlphabet(impl)}`);
  lines.push(`prefix=${impl.encodeLicenseKey(new Uint8Array(16)).slice(0, 4)}`);
  for (const v of RAW_SECRET_VECTORS) {
    const s = hexToBytes(v.secretHex);
    lines.push(`${v.id}|key=${impl.encodeLicenseKey(s)}|commit=${bytesToHex(impl.licenseCommitment(s))}`);
  }
  return lines;
}

/** Canonical lines for the derivation half of the scheme (clients only). */
export function licenseDerivationFingerprint(impl: LicenseDerivationImpl & LicenseCodecImpl): string[] {
  const lines: string[] = [];
  for (const v of ZK_DERIVATION_VECTORS) {
    const s = impl.deriveLicenseSecret(v.ikm, v.serviceId);
    lines.push(
      `${v.id}|secret=${bytesToHex(s)}|key=${impl.encodeLicenseKey(s)}|commit=${bytesToHex(impl.licenseCommitment(s))}`,
    );
  }
  for (const v of CLASSIC_DERIVATION_VECTORS) {
    const s = impl.deriveClassicLicenseSecret(hexToBytes(v.signatureHex), v.serviceId);
    lines.push(
      `${v.id}|secret=${bytesToHex(s)}|key=${impl.encodeLicenseKey(s)}|commit=${bytesToHex(impl.licenseCommitment(s))}` +
        `|msg=${bytesToHex(impl.classicLicenseSignMessage(v.serviceId))}`,
    );
  }
  for (const v of SERVICE_TAG_VECTORS) {
    lines.push(`${v.id}|tag=${impl.licenseServiceTag(v.serviceId, v.retailerAddress)}`);
  }
  return lines;
}

/** Codec + derivation, in the order the digest is taken over. */
export function licenseSchemeFingerprint(impl: LicenseDerivationImpl & LicenseCodecImpl): string[] {
  return [...licenseCodecFingerprint(impl), ...licenseDerivationFingerprint(impl)];
}

// ---------------------------------------------------------------------------
// Pinned values — MEASURED, not chosen
// ---------------------------------------------------------------------------

export const EXPECTED_CODEC_FINGERPRINT: readonly string[] = [
  'alphabet=0123456789ABCDEFGHJKMNPQRSTVWXYZ',
  'prefix=P01-',
  'raw/000102..0f|key=P01-000G-40R4-0M30-E209-185G-R38E-1W|commit=a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3',
  'raw/zero|key=P01-0000-0000-0000-0000-0000-0000-00|commit=e572dff82304700b856a555ac3a4558d0df3646a3727816500270a93c66aac1e',
  'raw/ff|key=P01-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZW|commit=c3870565bcf29b077548a4c004a9beadd7b923ccb68bc4312a3a22d0497d8c14',
];

export const EXPECTED_DERIVATION_FINGERPRINT: readonly string[] = [
  'zk/registry-slug|secret=62dc60df1e4f743b3b03ac970e8996d4|key=P01-CBE6-1QRY-9XT3-PER3-NJBG-X2CP-TG|commit=108359468e33e01612f98ecf3c97d3ed448f5a29d904e3c4415d87437885648d',
  'zk/registry-slug-2|secret=b811bbf43de21ffe9069680f758b5b82|key=P01-Q08V-QX1X-W8FZ-X439-D07Q-B2TV-G8|commit=5db4e1ebe4511d083b5b00a6cd09eab356870cb3b3ca4adb8877e77e97a2776f',
  'zk/retailer-fallback|secret=fc1699cbdb45e1a3cdde783af9b79a54|key=P01-ZGB9-KJYV-8QGT-7KEY-F0XF-KDWT-AG|commit=1f71bc0e03571d327864a13baaa3cd4aa5942c05aa3f1a64d3386159718dec53',
  'zk/empty-service|secret=c086134916f0c2e97219fff9eeac2070|key=P01-R231-6J8P-Y31E-JWGS-ZZWY-XB10-E0|commit=c100723a73ceb62e916c2f009cad2d84603f9bc82224deda8207f2968cc9de03',
  'zk/unicode-service|secret=433db0f8311ed0c55136dad9a9a5b0cc|key=P01-8CYV-1Y1H-3V8C-AM9P-VBCT-K9DG-SG|commit=f466667c85e39f02873327aa83d388f075cbe0f77ba88bcf7cd51b0b2592acfa',
  'classic/sig-00..3f|secret=b1451363f0522144a724fb9e4031ffdf|key=P01-P52H-6RZG-A8GM-99S4-ZEF4-0CFZ-VW|commit=9db7baf098aed3606a9aaac602f933c0fc9beaf4eeb7f41428c18cd2dbc4710c|msg=7030312d6c6963656e73652d76313a6469736e65792d706c7573',
  'classic/sig-ff|secret=54c53c6e760972aceb58ef27b0595f49|key=P01-AK2K-RVKP-15SA-STTR-XWKV-0PAZ-94|commit=1d8002dda1a1e7ca42b74438e1c856bda069fec1444b043905ce5c8aa941a49b|msg=7030312d6c6963656e73652d76313a',
  'tag/slug|tag=disney-plus',
  'tag/empty-string|tag=RETAILER',
  'tag/undefined|tag=RETAILER',
  'tag/null|tag=RETAILER',
  'tag/whitespace-kept|tag=  ',
];

export const EXPECTED_SCHEME_FINGERPRINT: readonly string[] = [
  ...EXPECTED_CODEC_FINGERPRINT,
  ...EXPECTED_DERIVATION_FINGERPRINT,
];

/**
 * `blake3(utf8(EXPECTED_SCHEME_FINGERPRINT.join('\n')))`, hex. One value that
 * moves if ANY line above moves — the single assertion worth quoting in a
 * release note. Computed by each caller with its own blake3 so this module
 * keeps zero dependencies.
 */
export const EXPECTED_SCHEME_DIGEST_BLAKE3 =
  'f67a08fa9dde78b4efb23636703fe6041ec689650db3a90c339d5ab06646a7fa';

/** The exact preimage the digest is taken over. */
export function schemeDigestPreimage(fingerprint: readonly string[]): string {
  return fingerprint.join('\n');
}

// ---------------------------------------------------------------------------
// v2 derivation (additive, 2026-09-02): docs/LICENSE_KEY_V2-2026-09-02.md
//
// Kept apart from the v1 fixture on purpose: EXPECTED_SCHEME_FINGERPRINT and
// its digest do not move, because v1 keys already issued must keep verifying.
// ---------------------------------------------------------------------------

/**
 * The v2 derivation. Present in every mirror, the merchant SDK included (there
 * for tests and tooling only; verification is scheme-agnostic).
 */
export interface LicenseDerivationV2Impl {
  deriveLicenseSalt(identitySeed: Uint8Array): Uint8Array;
  deriveLicenseSecretV2(masterNoteSecret: bigint | string, serviceId: string, identitySeed: Uint8Array): Uint8Array;
}

/**
 * The single v2 vector every mirror pins, copied from the spec. Computed with
 * @noble/hashes (hkdf, sha256, blake3) on 2026-09-02.
 */
export const LICENSE_V2_VECTOR = {
  id: 'v2/spec',
  identitySeedHex: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  noteSecret: '1234',
  serviceTag: 'svc',
  licenseSaltHex: '058f3c959dba16c347e5e291f65e6d7a26824f1006e541d0b4aba79004c90e6a',
  licenseSecretHex: 'de00e41667d82798b62825793d51be69',
  key: 'P01-VR0E-85K7-V0KS-HDH8-4NWK-TMDY-D4',
  commitmentHex: '852e98e702bc79617d20199cf25753264b0da206e2835e476caf4b4e865b8fac',
} as const;

/** Canonical line for the v2 derivation, measured through an implementation. */
export function licenseV2Fingerprint(impl: LicenseDerivationV2Impl & LicenseCodecImpl): string[] {
  const v = LICENSE_V2_VECTOR;
  const seed = hexToBytes(v.identitySeedHex);
  const salt = impl.deriveLicenseSalt(seed);
  const s = impl.deriveLicenseSecretV2(v.noteSecret, v.serviceTag, seed);
  return [
    `${v.id}|salt=${bytesToHex(salt)}|secret=${bytesToHex(s)}|key=${impl.encodeLicenseKey(s)}|commit=${bytesToHex(impl.licenseCommitment(s))}`,
  ];
}

/** The pinned v2 line, spelled from the spec vector. */
export const EXPECTED_V2_FINGERPRINT: readonly string[] = [
  `${LICENSE_V2_VECTOR.id}|salt=${LICENSE_V2_VECTOR.licenseSaltHex}|secret=${LICENSE_V2_VECTOR.licenseSecretHex}` +
    `|key=${LICENSE_V2_VECTOR.key}|commit=${LICENSE_V2_VECTOR.commitmentHex}`,
];
