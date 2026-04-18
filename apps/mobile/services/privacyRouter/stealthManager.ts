/**
 * Stealth Manager — Deterministic stealth address generation for privacy routes.
 *
 * All keys are derived from the user's spending key + route context,
 * so the user can always reconstruct every intermediate wallet from
 * their spending key alone. No state is required beyond the spending key.
 *
 * Derivation path:
 *   seed = HMAC-SHA256(spendingKeyHash, "stealth" || routeId || hopIndex || outputIndex)
 *   keypair = Ed25519.fromSeed(seed)
 *
 * This is a one-way derivation: knowing a stealth address does not reveal
 * the spending key or any other stealth address in the route.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Derives a deterministic stealth keypair for a specific position in a privacy route.
 *
 * The keypair is derived via HMAC-SHA256(spendingKeyHash, context) where context
 * encodes the route ID, hop index, and output index. This ensures:
 * - Different routes produce different keys (routeId is unique per route)
 * - Different hops within a route produce different keys
 * - Different outputs within a hop produce different keys
 * - The same inputs always produce the same keypair (reproducible from spending key)
 *
 * @param params.spendingKeyHash - Hex-encoded hash of the user's spending key
 * @param params.routeId - Unique identifier for the privacy route
 * @param params.hopIndex - Position of the hop in the route (0-based)
 * @param params.outputIndex - Position of the output within the hop (0-based)
 * @returns Ed25519 Keypair for this stealth address
 */
export function deriveRouteStealthKeypair(params: {
  spendingKeyHash: string;
  routeId: string;
  hopIndex: number;
  outputIndex: number;
}): Keypair {
  const { spendingKeyHash, routeId, hopIndex, outputIndex } = params;

  // Build the context string for HMAC derivation
  const context = `stealth:${routeId}:${hopIndex}:${outputIndex}`;

  // Derive 32-byte seed via HMAC-SHA256
  const keyBytes = hexToBytes(spendingKeyHash);
  const contextBytes = new TextEncoder().encode(context);
  const seed = hmac(sha256, keyBytes, contextBytes);

  // Create Ed25519 keypair from the 32-byte seed
  const kp = Keypair.fromSeed(seed);
  console.log(`[Stealth] Derived keypair: hop=${hopIndex} out=${outputIndex} → ${kp.publicKey.toBase58().slice(0, 12)}...`);
  return kp;
}

/**
 * Derives just the public key (stealth address) without exposing the full keypair.
 * Useful for route planning where only the address is needed.
 *
 * @param params.spendingKeyHash - Hex-encoded hash of the user's spending key
 * @param params.routeId - Unique identifier for the privacy route
 * @param params.hopIndex - Position of the hop in the route (0-based)
 * @param params.outputIndex - Position of the output within the hop (0-based)
 * @returns PublicKey for the stealth address
 */
export function deriveStealthAddress(params: {
  spendingKeyHash: string;
  routeId: string;
  hopIndex: number;
  outputIndex: number;
}): PublicKey {
  const keypair = deriveRouteStealthKeypair(params);
  console.log(`[Stealth] Address: hop=${params.hopIndex} out=${params.outputIndex} → ${keypair.publicKey.toBase58().slice(0, 12)}...`);
  return keypair.publicKey;
}

/**
 * Derives N stealth keypairs for all outputs in a single route hop.
 *
 * @param params.spendingKeyHash - Hex-encoded hash of the user's spending key
 * @param params.routeId - Unique identifier for the privacy route
 * @param params.hopIndex - Position of the hop in the route (0-based)
 * @param params.numOutputs - Number of outputs (stealth addresses) to generate
 * @returns Array of Ed25519 Keypairs, one per output
 */
export function deriveHopKeypairs(params: {
  spendingKeyHash: string;
  routeId: string;
  hopIndex: number;
  numOutputs: number;
}): Keypair[] {
  const { spendingKeyHash, routeId, hopIndex, numOutputs } = params;
  const keypairs: Keypair[] = [];

  for (let i = 0; i < numOutputs; i++) {
    keypairs.push(
      deriveRouteStealthKeypair({
        spendingKeyHash,
        routeId,
        hopIndex,
        outputIndex: i,
      }),
    );
  }

  return keypairs;
}

/**
 * Derives the stealth secret (raw 32-byte seed) for encrypting into the route plan.
 * This is stored encrypted in the RouteHop.stealthSecret field so the hop executor
 * can reconstruct the keypair without re-deriving from the spending key.
 *
 * @param params.spendingKeyHash - Hex-encoded hash of the user's spending key
 * @param params.routeId - Unique identifier for the privacy route
 * @param params.hopIndex - Position of the hop in the route (0-based)
 * @param params.outputIndex - Position of the output within the hop (0-based)
 * @returns Hex-encoded 32-byte secret seed
 */
export function deriveStealthSecret(params: {
  spendingKeyHash: string;
  routeId: string;
  hopIndex: number;
  outputIndex: number;
}): string {
  const { spendingKeyHash, routeId, hopIndex, outputIndex } = params;

  const context = `stealth:${routeId}:${hopIndex}:${outputIndex}`;
  const keyBytes = hexToBytes(spendingKeyHash);
  const contextBytes = new TextEncoder().encode(context);
  const seed = hmac(sha256, keyBytes, contextBytes);

  return bytesToHex(seed);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
