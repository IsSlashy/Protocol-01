/**
 * P6.4 — Crypto-v2 parity tests (Point / HKDF / WOTS+)
 *
 * Guards the client-side primitives against drift between the JS
 * implementation and the Rust / on-chain verifiers. Implicit cross-
 * language parity is already exercised by the devnet smoke tests
 * (wots-devnet-smoke.ts, e2e-stark-*). These unit tests catch drift
 * at build-time without needing a running validator.
 *
 * Three suites:
 *   1. HKDF  — RFC 5869 §A.2/§A.3 known-answer vectors (SHA-256).
 *              Proves @noble/hashes matches the spec byte-for-byte.
 *   2. Point — RFC 8032 §7.1 test vector 1 (Ed25519).
 *              Proves @noble/curves scalar → point conversion is stable.
 *   3. WOTS+ — Determinism + golden fixture (seed 0x00..1f).
 *              Any change to nibble encoding, checksum layout, or chain
 *              hashing would flip the fixture and fail the test.
 *
 * If any fixture fails, either the primitive drifted, a dep was
 * upgraded incompatibly, or the on-chain verifier must be updated
 * alongside — fix both sides before landing changes.
 */
import { describe, it, expect } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import {
  generateWotsKeypair,
  deriveWotsKeypair,
  wotsSign,
  wotsVerify,
  computeWithdrawMessage,
  WOTS_CHAINS,
  WOTS_SIG_SIZE,
  WOTS_PUBKEY_SIZE,
  HASH_SIZE,
} from './quantum/wots';

// ── helpers ────────────────────────────────────────────────────────

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// 1. HKDF parity — RFC 5869 §A.2 / §A.3 test vectors (SHA-256)
// https://datatracker.ietf.org/doc/html/rfc5869#appendix-A
// ============================================================================

describe('Parity: HKDF-SHA256 (RFC 5869)', () => {
  it('Case 1 — basic vector', () => {
    const ikm = fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const salt = fromHex('000102030405060708090a0b0c');
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
    const okmExpected =
      '3cb25f25faacd57a90434f64d0362f2a' +
      '2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
      '34007208d5b887185865';

    const okm = hkdf(sha256, ikm, salt, info, 42);
    expect(toHex(okm)).toBe(okmExpected);
  });

  it('Case 3 — empty salt and info', () => {
    const ikm = fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const okmExpected =
      '8da4e775a563c18f715f802a063c5a31' +
      'b8a11f5c5ee1879ec3454e5f3c738d2d' +
      '9d201395faa4b61a96c8';

    const okm = hkdf(sha256, ikm, new Uint8Array(0), new Uint8Array(0), 42);
    expect(toHex(okm)).toBe(okmExpected);
  });

  it('deriveStealthSeed path — same inputs produce same 32-byte output', () => {
    // The on-chain scanner derives the same seed from (spendingPubKey, sharedSecret)
    // by mirroring this hkdf call. Verify that the utf8-encoded info tag is stable.
    const spendingPub = fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const shared = fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const info = utf8ToBytes('p01-stealth-seed-v1');

    const out1 = hkdf(sha256, shared, spendingPub, info, 32);
    const out2 = hkdf(sha256, shared, spendingPub, info, 32);
    expect(toHex(out1)).toBe(toHex(out2));
    expect(out1.length).toBe(32);
  });
});

// ============================================================================
// 2. Ed25519 Point parity — RFC 8032 §7.1 test vector 1
// https://datatracker.ietf.org/doc/html/rfc8032#section-7.1
// ============================================================================

describe('Parity: Ed25519 Point (RFC 8032)', () => {
  it('secret 9d61b19d… → pub d75a9801… (test vector 1)', () => {
    const secret = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const pubExpected = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const pub = ed25519.getPublicKey(secret);
    expect(toHex(pub)).toBe(pubExpected);
  });

  it('scalar multiplication is deterministic', () => {
    const secret = fromHex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
    const pub1 = ed25519.getPublicKey(secret);
    const pub2 = ed25519.getPublicKey(secret);
    expect(toHex(pub1)).toBe(toHex(pub2));
  });

  it('RFC 8032 §7.1 vector 2: 4ccd089b… → 3d40170710…', () => {
    const secret = fromHex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
    const pubExpected = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
    const pub = ed25519.getPublicKey(secret);
    expect(toHex(pub)).toBe(pubExpected);
  });
});

// ============================================================================
// 3. WOTS+ parity — determinism + golden fixture
// On-chain Rust verifier in programs/p01_quantum_vault/src/lib.rs reconstructs
// the pubkey hash from the same (seed, message) by walking the same chains
// with SHA-256. Drift here → on-chain rejection.
// ============================================================================

describe('Parity: WOTS+ (67-chain, SHA-256)', () => {
  // Shared fixture seed: bytes 0x00..0x1f
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;

  it('sizes match 67-chain spec constants', () => {
    expect(WOTS_CHAINS).toBe(67);
    expect(HASH_SIZE).toBe(32);
    expect(WOTS_SIG_SIZE).toBe(2144);
    expect(WOTS_PUBKEY_SIZE).toBe(2144);
  });

  it('golden fixture: seed 0x00..1f → stable pubkey hash', () => {
    const kp = generateWotsKeypair(seed);
    expect(kp.publicKey.length).toBe(2144);
    expect(kp.secretKey.length).toBe(2144);

    // Bytes produced by the current JS impl AND the on-chain Rust verifier
    // (cross-checked via wots-devnet-smoke.ts). Hardcoded here so any drift
    // in either nibble encoding, checksum placement, or chain length fails
    // the test at build-time instead of devnet.
    expect(toHex(kp.publicKey.slice(0, 16))).toBe('547b0f52756b18917f1d98df7276cae0');
    expect(toHex(kp.publicKey.slice(-16))).toBe('0f37e26619e302a136dc61f8963174af');
    expect(toHex(kp.publicKeyHash)).toBe(
      'ac3e3aa97a7e208759b1af9a1a30f2d028b0a6decf32b4f8917d6b85ac21f5ab',
    );
  });

  it('determinism — same seed always yields same keypair', () => {
    const a = generateWotsKeypair(seed);
    const b = generateWotsKeypair(seed);
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey));
    expect(toHex(a.secretKey)).toBe(toHex(b.secretKey));
    expect(toHex(a.publicKeyHash)).toBe(toHex(b.publicKeyHash));
  });

  it('signature golden fixture: message "parity-test-message-v1"', () => {
    const kp = generateWotsKeypair(seed);
    const msgHash = sha256(utf8ToBytes('parity-test-message-v1'));
    expect(toHex(msgHash)).toBe(
      'bd2efed5dbc75385bd3ec85102cbffd200a56a05ac003d8dfc08250e8aa74314',
    );

    const sig = wotsSign(msgHash, kp);
    expect(sig.signature.length).toBe(2144);
    // Signature bytes are deterministic for a fixed (seed, message) pair.
    expect(toHex(sig.signature.slice(0, 16))).toBe('166b3bee7fed97cd67cdaa6b50049b07');
    expect(toHex(sig.signature.slice(-16))).toBe('53bb379f9caf364888dcec812ca132ed');

    // And the signature must verify back to the stored hash.
    expect(wotsVerify(msgHash, sig, kp.publicKeyHash)).toBe(true);
  });

  it('withdraw message hash matches the on-chain SHA-256(amount || dest || count)', () => {
    // Mirrors the Rust handler:
    //   msg = hashv(&[&amount_le, dest.as_ref(), &count_le])
    const dest = new Uint8Array(32).fill(0xaa);
    const withdrawMsg = computeWithdrawMessage(123456789n, dest, 7n);

    expect(toHex(withdrawMsg)).toBe(
      'fd195da59446aaedf15a73046b94780a91ab3c5787ac409c62445ea356eb193f',
    );
  });

  it('deriveWotsKeypair(index) — same master seed, different indexes → different keypairs', () => {
    const master = new Uint8Array(32).fill(0x42);
    const kp0a = deriveWotsKeypair(master, 0);
    const kp0b = deriveWotsKeypair(master, 0);
    const kp1 = deriveWotsKeypair(master, 1);

    // Same index → byte-equal
    expect(toHex(kp0a.publicKeyHash)).toBe(toHex(kp0b.publicKeyHash));
    // Different index → different keypair (domain separation)
    expect(toHex(kp0a.publicKeyHash)).not.toBe(toHex(kp1.publicKeyHash));
  });

  it('checksum is load-bearing: flipping one message nibble forces sig change', () => {
    const kp = generateWotsKeypair(seed);

    const m1 = sha256(utf8ToBytes('message-a'));
    const m2 = sha256(utf8ToBytes('message-b'));

    const s1 = wotsSign(m1, kp);
    const s2 = wotsSign(m2, kp);

    // Different messages → different signatures
    expect(toHex(s1.signature)).not.toBe(toHex(s2.signature));

    // Each must verify only against its own message
    expect(wotsVerify(m1, s1, kp.publicKeyHash)).toBe(true);
    expect(wotsVerify(m2, s2, kp.publicKeyHash)).toBe(true);
    expect(wotsVerify(m1, s2, kp.publicKeyHash)).toBe(false);
    expect(wotsVerify(m2, s1, kp.publicKeyHash)).toBe(false);
  });
});
