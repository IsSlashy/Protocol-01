import { describe, it, expect } from 'vitest';
import {
  generateWotsKeypair,
  wotsSign,
  wotsVerify,
  deriveWotsKeypair,
  computeWithdrawMessage,
  WOTS_CHAINS,
  WOTS_SIG_SIZE,
  WOTS_PUBKEY_SIZE,
  HASH_SIZE,
} from './wots';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

describe('WOTS+ (Winternitz One-Time Signatures)', () => {
  const seed = sha256(new TextEncoder().encode('test-seed-for-wots'));

  it('generates keypair with correct sizes', () => {
    const kp = generateWotsKeypair(seed);
    expect(kp.secretKey.length).toBe(WOTS_CHAINS * HASH_SIZE);
    expect(kp.publicKey.length).toBe(WOTS_PUBKEY_SIZE);
    expect(kp.publicKeyHash.length).toBe(32);
  });

  it('pubkey hash is SHA-256 of pubkey', () => {
    const kp = generateWotsKeypair(seed);
    const expected = sha256(kp.publicKey);
    expect(Buffer.from(kp.publicKeyHash)).toEqual(Buffer.from(expected));
  });

  it('signs and verifies a message', () => {
    const kp = generateWotsKeypair(seed);
    const message = sha256(new TextEncoder().encode('hello quantum world'));

    const sig = wotsSign(message, kp);
    expect(sig.signature.length).toBe(WOTS_SIG_SIZE);

    const valid = wotsVerify(message, sig, kp.publicKeyHash);
    expect(valid).toBe(true);
  });

  it('rejects wrong message', () => {
    const kp = generateWotsKeypair(seed);
    const message = sha256(new TextEncoder().encode('correct message'));
    const wrong = sha256(new TextEncoder().encode('wrong message'));

    const sig = wotsSign(message, kp);
    const valid = wotsVerify(wrong, sig, kp.publicKeyHash);
    expect(valid).toBe(false);
  });

  it('rejects tampered signature', () => {
    const kp = generateWotsKeypair(seed);
    const message = sha256(new TextEncoder().encode('test'));

    const sig = wotsSign(message, kp);
    // Flip a byte in the signature
    sig.signature[0] ^= 0xff;

    const valid = wotsVerify(message, sig, kp.publicKeyHash);
    expect(valid).toBe(false);
  });

  it('rejects wrong public key hash', () => {
    const kp = generateWotsKeypair(seed);
    const message = sha256(new TextEncoder().encode('test'));

    const sig = wotsSign(message, kp);
    const wrongHash = new Uint8Array(32);

    const valid = wotsVerify(message, sig, wrongHash);
    expect(valid).toBe(false);
  });

  it('deterministic key derivation produces same keypair', () => {
    const masterSeed = randomBytes(32);
    const kp1 = deriveWotsKeypair(masterSeed, 0);
    const kp2 = deriveWotsKeypair(masterSeed, 0);

    expect(Buffer.from(kp1.publicKeyHash)).toEqual(Buffer.from(kp2.publicKeyHash));
    expect(Buffer.from(kp1.secretKey)).toEqual(Buffer.from(kp2.secretKey));
  });

  it('different indices produce different keypairs', () => {
    const masterSeed = randomBytes(32);
    const kp0 = deriveWotsKeypair(masterSeed, 0);
    const kp1 = deriveWotsKeypair(masterSeed, 1);

    expect(Buffer.from(kp0.publicKeyHash)).not.toEqual(Buffer.from(kp1.publicKeyHash));
  });

  it('key rotation: sign with key 0, verify next key 1 is different', () => {
    const masterSeed = randomBytes(32);
    const kp0 = deriveWotsKeypair(masterSeed, 0);
    const kp1 = deriveWotsKeypair(masterSeed, 1);

    // Sign a withdrawal with key 0
    const message = computeWithdrawMessage(
      1_000_000_000n, // 1 SOL
      new Uint8Array(32), // dummy destination
      0n // first withdrawal
    );

    const sig = wotsSign(message, kp0);
    expect(wotsVerify(message, sig, kp0.publicKeyHash)).toBe(true);

    // Key 1's hash would be the next_wots_pubkey_hash stored on-chain
    expect(kp1.publicKeyHash.length).toBe(32);
    expect(Buffer.from(kp1.publicKeyHash)).not.toEqual(Buffer.from(kp0.publicKeyHash));
  });

  it('computeWithdrawMessage is deterministic', () => {
    const amount = 500_000_000n;
    const dest = sha256(new TextEncoder().encode('destination'));
    const count = 3n;

    const msg1 = computeWithdrawMessage(amount, dest, count);
    const msg2 = computeWithdrawMessage(amount, dest, count);
    expect(Buffer.from(msg1)).toEqual(Buffer.from(msg2));
  });

  it('handles all-zero message (edge case)', () => {
    const kp = generateWotsKeypair(seed);
    const message = new Uint8Array(32); // all zeros → all nibbles = 0

    const sig = wotsSign(message, kp);
    expect(wotsVerify(message, sig, kp.publicKeyHash)).toBe(true);
  });

  it('handles all-0xFF message (edge case)', () => {
    const kp = generateWotsKeypair(seed);
    const message = new Uint8Array(32).fill(0xff); // all nibbles = 15

    const sig = wotsSign(message, kp);
    expect(wotsVerify(message, sig, kp.publicKeyHash)).toBe(true);
  });
});
