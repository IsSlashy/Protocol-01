/**
 * Monkey-patch PublicKey.createProgramAddressSync / findProgramAddressSync
 * to fix broken isOnCurve check in React Native (Hermes engine).
 *
 * Root cause: @noble/curves ed25519 ExtendedPoint.fromHex() produces incorrect
 * results in Hermes for certain inputs, causing findProgramAddressSync to accept
 * bump 255 when the resulting hash IS on the ed25519 curve (should skip to 254).
 *
 * Fix: replace the isOnCurve check with a pure BigInt implementation that uses
 * simple modular arithmetic (Euler's criterion) instead of the complex
 * ed25519_pow_2_252_3 addition chain from @noble/curves.
 */
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';

// Ed25519 field prime: p = 2^255 - 19
const P = BigInt(
  '57896044618658097711785492504343953926634992332820282019728792003956564819949',
);
// Curve parameter d = -121665/121666 mod p
const D = BigInt(
  '37095705934669439343138083508754565189542113879843219016388785533085940283555',
);
// (p - 1) / 2  — used for Euler's criterion
const P_MINUS_1_DIV_2 = (P - 1n) >> 1n;

const MAX_SEED_LENGTH = 32;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let num = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    num = (num << 8n) | BigInt(bytes[i]);
  }
  return num;
}

/**
 * Check if 32 bytes represent a valid compressed ed25519 point.
 * Pure BigInt, no dependency on @noble/curves.
 */
function isOnCurve(publicKey: Uint8Array): boolean {
  try {
    if (publicKey.length !== 32) return false;

    // Copy and clear sign bit to extract y
    const yBytes = new Uint8Array(32);
    yBytes.set(publicKey);
    yBytes[31] = yBytes[31] & 0x7f;
    const y = bytesToNumberLE(yBytes);

    // RFC 8032: y must be < p
    if (y >= P) return false;

    // Ed25519 curve: -x^2 + y^2 = 1 + d*x^2*y^2
    // Solving for x^2: x^2 = (y^2 - 1) / (d*y^2 + 1)
    const y2 = (y * y) % P;
    const u = (y2 - 1n + P) % P; // y^2 - 1
    const v = ((D * y2) % P + 1n) % P; // d*y^2 + 1

    if (v === 0n) return false;

    // x^2 = u * v^(-1) mod p  (Fermat's little theorem: v^(-1) = v^(p-2))
    const vInv = modPow(v, P - 2n, P);
    const x2 = (u * vInv) % P;

    if (x2 === 0n) return true; // x = 0 is a valid solution

    // Euler's criterion: x^2 is a quadratic residue iff x^2^((p-1)/2) = 1 mod p
    const euler = modPow(x2, P_MINUS_1_DIV_2, P);
    return euler === 1n;
  } catch {
    return false;
  }
}

function toBuffer(arr: Buffer | Uint8Array | number[]): Buffer {
  if (Buffer.isBuffer(arr)) return arr;
  if (arr instanceof Uint8Array)
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return Buffer.from(arr);
}

// Patch createProgramAddressSync
PublicKey.createProgramAddressSync = function (
  seeds: Array<Buffer | Uint8Array>,
  programId: PublicKey,
): PublicKey {
  let buffer = Buffer.alloc(0);
  seeds.forEach((seed) => {
    if (seed.length > MAX_SEED_LENGTH) {
      throw new TypeError('Max seed length exceeded');
    }
    buffer = Buffer.concat([buffer, toBuffer(seed)]);
  });
  buffer = Buffer.concat([
    buffer,
    programId.toBuffer(),
    Buffer.from('ProgramDerivedAddress'),
  ]);
  const publicKeyBytes = sha256(buffer);
  if (isOnCurve(publicKeyBytes)) {
    throw new Error('Invalid seeds, address must fall off the curve');
  }
  return new PublicKey(publicKeyBytes);
};

// Patch findProgramAddressSync
PublicKey.findProgramAddressSync = function (
  seeds: Array<Buffer | Uint8Array>,
  programId: PublicKey,
): [PublicKey, number] {
  let nonce = 255;
  let address: PublicKey;
  while (nonce !== 0) {
    try {
      const seedsWithNonce = seeds.concat(Buffer.from([nonce]));
      address = PublicKey.createProgramAddressSync(seedsWithNonce, programId);
    } catch (err) {
      if (err instanceof TypeError) {
        throw err;
      }
      nonce--;
      continue;
    }
    return [address, nonce];
  }
  throw new Error('Unable to find a viable program address nonce');
};

// Patch async versions too (they just call the sync versions)
PublicKey.createProgramAddress = async function (
  seeds: Array<Buffer | Uint8Array>,
  programId: PublicKey,
): Promise<PublicKey> {
  return PublicKey.createProgramAddressSync(seeds, programId);
};

PublicKey.findProgramAddress = async function (
  seeds: Array<Buffer | Uint8Array>,
  programId: PublicKey,
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddressSync(seeds, programId);
};

console.log('[PDA-Fix] PublicKey PDA methods patched with pure BigInt isOnCurve');
