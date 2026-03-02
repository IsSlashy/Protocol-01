import { poseidon2 } from 'poseidon-lite';
import type { IncrementalTreeUpdate } from './types';

const DEFAULT_ZERO = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');

/**
 * Compute the zero hashes for a Merkle tree of given depth.
 * zeroHashes[i] = Poseidon(zeroHashes[i-1], zeroHashes[i-1])
 */
export function computeZeroHashes(depth: number, zeroValue: bigint = DEFAULT_ZERO): bigint[] {
  const zeros = [zeroValue];
  for (let i = 1; i <= depth; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

// Cache for default zero hashes
let _defaultZeroHashes: bigint[] | null = null;

/**
 * Get zero hashes for a Merkle tree with default depth 20.
 * Cached for performance.
 */
export function getZeroHashes(depth: number = 20, zeroValue?: bigint): bigint[] {
  if (!zeroValue && depth === 20 && _defaultZeroHashes) return _defaultZeroHashes;
  const zeros = computeZeroHashes(depth, zeroValue);
  if (!zeroValue && depth === 20) _defaultZeroHashes = zeros;
  return zeros;
}
