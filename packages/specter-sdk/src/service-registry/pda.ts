import { PublicKey } from '@solana/web3.js';
import { REGISTRY_PROGRAM_ID } from '../constants';

/** PDA seed prefix used by `ServiceRegistry` (`b"service"`). */
export const SERVICE_REGISTRY_SEED = Buffer.from('service');

/** Max slug length (matches the program — PDA seed limit is 32 bytes). */
export const MAX_SLUG_LEN = 32;

/**
 * Derive the PDA for a service registry entry.
 *
 * Seeds: `[b"service", owner.key(), slug.as_bytes()]`.
 *
 * One merchant wallet can register multiple services (distinct slugs).
 *
 * @param owner - Merchant wallet that owns the service entry.
 * @param slug  - Per-owner unique identifier (UTF-8, max 32 bytes).
 * @param programId - Optional override for cross-cluster use.
 */
export function getServicePDA(
  owner: PublicKey,
  slug: string,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): [PublicKey, number] {
  if (slug.length === 0) {
    throw new Error('slug must not be empty');
  }
  const slugBytes = Buffer.from(slug, 'utf-8');
  if (slugBytes.length > MAX_SLUG_LEN) {
    throw new Error(`slug exceeds ${MAX_SLUG_LEN} bytes (${slugBytes.length})`);
  }
  return PublicKey.findProgramAddressSync(
    [SERVICE_REGISTRY_SEED, owner.toBuffer(), slugBytes],
    programId,
  );
}
