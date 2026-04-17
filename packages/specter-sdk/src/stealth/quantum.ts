/**
 * P4.3 — Post-quantum wrapping for stealth spending keys.
 *
 * Stealth addresses are Ed25519 public keys that live on Solana natively. A
 * future quantum adversary who observes a stealth address on-chain could
 * recover the private key via Shor's algorithm and spend the funds. The
 * hybrid KEM (P4.1) only protects the *discovery* channel — not the claim.
 *
 * This module derives a second, hash-based key (WOTS+) from the same stealth
 * seed that already produces the Ed25519 keypair. Because both halves share
 * the seed, a recipient who can decapsulate the stealth shared secret can
 * reconstruct *both* keypairs without exchanging any extra material with the
 * sender.
 *
 * Intended use: claim proofs submit BOTH an Ed25519 signature and a WOTS+
 * signature over the same challenge. Verification passes only if both hold.
 * If Shor breaks Ed25519, the WOTS+ half still binds the claim to the seed;
 * if a (very unlikely) SHA-256 break invalidates WOTS+, the Ed25519 half
 * still binds. Security degrades only when BOTH primitives fall.
 *
 * The on-chain verifier that enforces "both sigs valid" is a separate task
 * (P4.6 roadmap entry) — this module is the client-side half so wallets can
 * start emitting proofs ahead of the on-chain cutover.
 *
 * WOTS+ is strictly one-time. Each stealth address has its own fresh seed, so
 * the per-payment WOTS+ keypair only ever signs one claim challenge.
 */
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import {
  generateWotsKeypair,
  wotsSign,
  wotsVerify,
  type WotsKeypair,
} from '../quantum/wots';
import {
  deriveSharedSecret,
  deriveHybridSharedSecret,
  deriveStealthSeed,
  kemDecapsulate,
  constantTimeEqual,
} from '../utils/crypto';

// ── Domain separators ─────────────────────────────────────────────────────

/**
 * HKDF info used to split the stealth seed into a PQ subkey. Using a distinct
 * info from the Ed25519 path (which uses `STEALTH_SEED_INFO`) keeps the two
 * keypairs independent: even knowing the Ed25519 seed does not leak the WOTS+
 * seed and vice versa.
 */
const STEALTH_WOTS_INFO = 'p01:stealth:wots-pq-v1';

/**
 * Claim-proof domain tag. Any input that would change a claim's meaning
 * (destination, stealth address, ephemeral pubkey, claimer spending pubkey)
 * is mixed into the WOTS+ challenge so a signature on one context can't be
 * replayed in another.
 */
const PQ_CLAIM_DOMAIN = new TextEncoder().encode('p01:claim:pq-v1');

// ── Public types ──────────────────────────────────────────────────────────

export interface PQClaimContext {
  /** The stealth address being claimed (32-byte Solana pubkey). */
  stealthAddress: PublicKey | Uint8Array;
  /** Sender's ephemeral X25519 pubkey from the announcement (32 bytes). */
  ephemeralPubKey: Uint8Array;
  /** Recipient's spending public key (32 bytes). */
  spendingPubKey: Uint8Array;
  /** Where the claim pays out to (32-byte Solana pubkey). */
  destinationPubKey: PublicKey | Uint8Array;
}

export interface PQClaimProof {
  /** WOTS+ signature (2144 bytes). */
  signature: Uint8Array;
  /** WOTS+ public key, required for on-chain verification (2144 bytes). */
  publicKey: Uint8Array;
  /** SHA-256 of the public key — the commitment an on-chain state is expected
   *  to store so the signature can be authenticated without transmitting the
   *  full public key in storage (32 bytes). */
  publicKeyHash: Uint8Array;
  /** The challenge that was signed (32 bytes). Returning it lets callers
   *  double-check the binding they built without recomputing. */
  challenge: Uint8Array;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function toKeyBytes(k: PublicKey | Uint8Array): Uint8Array {
  if (k instanceof PublicKey) return k.toBytes();
  if (!(k instanceof Uint8Array) || k.length !== 32) {
    throw new Error('Expected a 32-byte pubkey');
  }
  return k;
}

/**
 * Compute the WOTS+ challenge that binds a claim proof to its context.
 *
 * challenge = SHA-256(
 *   "p01:claim:pq-v1" ||
 *   stealthAddress (32) ||
 *   ephemeralPubKey (32) ||
 *   spendingPubKey (32) ||
 *   destinationPubKey (32)
 * )
 */
function computePQClaimChallenge(ctx: PQClaimContext): Uint8Array {
  const stealthBytes = toKeyBytes(ctx.stealthAddress);
  const destBytes = toKeyBytes(ctx.destinationPubKey);
  if (ctx.ephemeralPubKey.length !== 32) {
    throw new Error('ephemeralPubKey must be 32 bytes');
  }
  if (ctx.spendingPubKey.length !== 32) {
    throw new Error('spendingPubKey must be 32 bytes');
  }

  const input = new Uint8Array(PQ_CLAIM_DOMAIN.length + 32 * 4);
  let offset = 0;
  input.set(PQ_CLAIM_DOMAIN, offset);
  offset += PQ_CLAIM_DOMAIN.length;
  input.set(stealthBytes, offset);
  offset += 32;
  input.set(ctx.ephemeralPubKey, offset);
  offset += 32;
  input.set(ctx.spendingPubKey, offset);
  offset += 32;
  input.set(destBytes, offset);
  return sha256(input);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Derive a deterministic WOTS+ keypair from a stealth seed.
 *
 * Both sender (theoretically, though the sender doesn't need to) and recipient
 * reach the same keypair: `stealthSeed → HKDF(info="p01:stealth:wots-pq-v1") →
 * WOTS+ keygen`. Because HKDF uses a distinct info label from the Ed25519
 * stealth path, compromise of one keypair does not weaken the other.
 *
 * @param stealthSeed - 32-byte stealth seed from `deriveStealthSeed`
 */
export function deriveStealthWotsKeypair(stealthSeed: Uint8Array): WotsKeypair {
  if (stealthSeed.length !== 32) {
    throw new Error('stealthSeed must be 32 bytes');
  }
  const wotsSeed = hkdf(sha256, stealthSeed, undefined, STEALTH_WOTS_INFO, 32);
  return generateWotsKeypair(wotsSeed);
}

/**
 * Derive the stealth WOTS+ keypair straight from recipient-side material.
 *
 * Mirrors `deriveStealthPrivateKey` but produces the PQ half. Requires the
 * same inputs the recipient already has when scanning: viewing private key,
 * ephemeral pubkey, spending pubkey, and (for v2 hybrid) KEM secret +
 * ciphertext.
 */
export function deriveStealthWotsFromRecipient(
  spendingPubKey: Uint8Array,
  viewingPrivateKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  kemSecretKey?: Uint8Array,
  kemCiphertext?: Uint8Array,
): WotsKeypair {
  const classicSecret = deriveSharedSecret(viewingPrivateKey, ephemeralPubKey);

  let sharedSecret: Uint8Array;
  if (kemSecretKey && kemCiphertext) {
    const kemSharedSecret = kemDecapsulate(kemCiphertext, kemSecretKey);
    sharedSecret = deriveHybridSharedSecret(classicSecret, kemSharedSecret, {
      ephemeralPubKey,
      kemCiphertext,
    });
  } else {
    sharedSecret = classicSecret;
  }

  const stealthSeed = deriveStealthSeed(spendingPubKey, sharedSecret);
  return deriveStealthWotsKeypair(stealthSeed);
}

/**
 * Build a post-quantum claim proof.
 *
 * Signs `computePQClaimChallenge(ctx)` with the given WOTS+ keypair. The
 * challenge binds the proof to the stealth address, ephemeral pubkey, spending
 * pubkey, and destination — so the same signed blob cannot be replayed to
 * redirect the claim elsewhere.
 *
 * CRITICAL: the WOTS+ keypair must be fresh (never signed before). This is
 * naturally true when the keypair was derived from a per-payment stealth seed.
 */
export function buildClaimProofPQ(
  wotsKeypair: WotsKeypair,
  ctx: PQClaimContext,
): PQClaimProof {
  const challenge = computePQClaimChallenge(ctx);
  const sig = wotsSign(challenge, wotsKeypair);
  return {
    signature: sig.signature,
    publicKey: sig.publicKey,
    publicKeyHash: wotsKeypair.publicKeyHash,
    challenge,
  };
}

/**
 * Offline verification for a post-quantum claim proof.
 *
 * Recomputes the challenge from `ctx` (rejecting proofs whose embedded
 * challenge doesn't match the reconstructed one) and verifies the WOTS+
 * signature against the provided public key. Useful for local
 * sanity-checking before submitting to chain and for testing.
 */
export function verifyClaimProofPQ(
  proof: PQClaimProof,
  ctx: PQClaimContext,
): boolean {
  const expectedChallenge = computePQClaimChallenge(ctx);
  if (!constantTimeEqual(proof.challenge, expectedChallenge)) {
    return false;
  }
  const computedPkHash = sha256(proof.publicKey);
  if (!constantTimeEqual(computedPkHash, proof.publicKeyHash)) {
    return false;
  }
  return wotsVerify(
    proof.challenge,
    { signature: proof.signature, publicKey: proof.publicKey },
    proof.publicKeyHash,
  );
}
