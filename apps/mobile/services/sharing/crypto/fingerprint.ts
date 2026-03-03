/**
 * Visual Fingerprint — Anti-MITM verification for BLE sessions
 *
 * Both devices compute the same fingerprint from their exchanged public keys.
 * Users visually compare the displayed codes (like Signal safety numbers).
 *
 * Algorithm:
 *   1. Sort both public keys lexicographically (base64)
 *   2. Concatenate: sortedKey1 + ":" + sortedKey2
 *   3. SHA-512 (nacl.hash) → take first 24 bytes
 *   4. Split into 6 blocks of 4 hex chars → "A3F2 · 9B1C · E7D0 · ..."
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

/**
 * Compute a deterministic visual fingerprint from two X25519 public keys.
 *
 * @param localPubKey  - Our ephemeral public key (base64)
 * @param remotePubKey - Peer's ephemeral public key (base64)
 * @returns 6-block hex string, e.g. "A3F2 · 9B1C · E7D0 · 4A2B · F1C8 · 3D6E"
 */
export function computeFingerprint(
  localPubKey: string,
  remotePubKey: string,
): string {
  // Sort lexicographically so both sides get the same result
  const sorted = [localPubKey, remotePubKey].sort();
  const combined = `${sorted[0]}:${sorted[1]}`;

  // SHA-512 via nacl.hash
  const hash = nacl.hash(new TextEncoder().encode(combined));

  // Take first 24 bytes → 6 blocks of 4 hex chars
  const blocks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const block = Array.from(hash.slice(offset, offset + 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    blocks.push(block);
  }

  return blocks.join(' · ');
}

/**
 * Compare two fingerprints (constant-time-ish to avoid timing leaks).
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
