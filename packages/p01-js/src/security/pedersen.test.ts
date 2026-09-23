import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { createCommitment, verifyCommitment, bigIntToBytes, bytesToBigInt } from './crypto';

/**
 * Audit v1, finding F76 (crypto.ts part). The Pedersen generator H was
 * `h·G` with h = SHA-256('Protocol01-Pedersen-H-Generator') mod L: its discrete
 * log with respect to G is public. A commitment C = vG + rH = (v + h·r)G then
 * opens to ANY value v' with r' = r + (v - v')·h⁻¹, so `verifyCommitment`
 * accepted a different amount for the same commitment: not binding.
 *
 * H must come from a hash-to-curve (RFC 9380, edwards25519) with a fixed
 * domain tag, so that nobody knows log_G(H).
 */

const L = ed25519.Point.Fn.ORDER;
const OLD_TAG = 'Protocol01-Pedersen-H-Generator';

function modInv(a: bigint, m: bigint): bigint {
  let [x0, x1, r0, r1] = [0n, 1n, m, ((a % m) + m) % m];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [x0, x1] = [x1, x0 - q * x1];
  }
  return ((x0 % m) + m) % m;
}

describe('Pedersen commitments bind the value (F76)', () => {
  it('an opening to a different value, forged with the public tag, is refused', () => {
    const h = bytesToBigInt(sha256(new TextEncoder().encode(OLD_TAG))) % L;
    const v = 1_000n;
    const r = 123_456_789n;
    const c = createCommitment(v, bigIntToBytes(r, 32));
    expect(verifyCommitment(c.commitment, v, bigIntToBytes(r, 32))).toBe(true);

    const vForged = 1_000_000n;
    const rForged = (((r + ((v - vForged) % L + L) * modInv(h, L)) % L) + L) % L;
    expect(verifyCommitment(c.commitment, vForged, bigIntToBytes(rForged, 32))).toBe(false);
  });

  it('H is not the multiple of G given by the public tag', () => {
    const h = bytesToBigInt(sha256(new TextEncoder().encode(OLD_TAG))) % L;
    // 1·G + 1·H, minus G, is H.
    const one = createCommitment(1n, bigIntToBytes(1n, 32));
    const H = ed25519.Point.fromBytes(one.commitment).subtract(ed25519.Point.BASE);
    expect(H.equals(ed25519.Point.BASE.multiply(h))).toBe(false);
    expect(H.is0()).toBe(false);
    expect(H.isTorsionFree()).toBe(true);
  });

  it('a commitment to the value 0 is valid (the documented range starts at 0)', () => {
    const r = bigIntToBytes(99n, 32);
    const c = createCommitment(0n, r);
    expect(verifyCommitment(c.commitment, 0n, r)).toBe(true);
    expect(verifyCommitment(c.commitment, 1n, r)).toBe(false);
  });

  it('commitments still add homomorphically and still verify', () => {
    const a = createCommitment(40n, bigIntToBytes(7n, 32));
    const b = createCommitment(2n, bigIntToBytes(5n, 32));
    const sum = ed25519.Point.fromBytes(a.commitment).add(ed25519.Point.fromBytes(b.commitment)).toBytes();
    expect(verifyCommitment(sum, 42n, bigIntToBytes(12n, 32))).toBe(true);
  });
});
