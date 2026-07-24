/**
 * noteBlinding — the secret that makes a note's commitment unguessable.
 *
 * THE PROBLEM IT SOLVES
 * ─────────────────────
 * A note's commitment is
 *
 *   commitment = poseidon(nullifier, poseidon(deposit_epoch, token_mint))
 *
 * (`stark/src/air/denominated_pool.rs::compute_pool_values`), and a withdrawal
 * MUST publish the nullifier — it is the double-spend guard and a PDA seed. With
 * `deposit_epoch = slot / 7200`, `token_mint` fixed per pool, and the nullifier
 * public, an observer enumerates a few thousand candidate epochs, recomputes the
 * commitment, and matches it to the exact deposit leaf. Anonymity set: one.
 *
 * Nothing on-chain requires that value to be an epoch:
 *   - C1's public inputs are `[nullifier, commitment]`
 *     (`p01_stark_verifier/src/lib.rs:104`) — the epoch is a PRIVATE witness and
 *     never appears on-chain.
 *   - `min_epoch` is ignored by the handler
 *     (`unshield_denominated_stark_v3.rs:387`: `let _ = (…, min_epoch, …)`).
 *   - The shield instruction takes only `(commitment, new_root, new_subtrees)`.
 *
 * So we put 63 bits of secret there instead, and the commitment stops being
 * computable from the nullifier.
 *
 * WHY A PRF AND NOT RANDOMNESS
 * ────────────────────────────
 * Random blinding would make notes unrecoverable without stored state — lose the
 * browser profile, lose the funds. Deriving it as a PRF of the wallet seed keeps
 * both properties at once: the owner recomputes it for any leaf index forever,
 * while an attacker without the seed faces 63 bits. It also removes the epoch
 * search from recovery entirely, which is what made scanning slow.
 *
 * This alone does NOT deliver unlinkability — the withdrawal still passes the
 * commitment as a public instruction argument. It removes the second, deeper
 * leak, so that hiding that argument (the C7 spend circuit) actually achieves
 * something. Both are required.
 */

import type { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const BLINDING_INFO = utf8ToBytes('p01:web:note-blinding:v1');

/**
 * 63-bit mask. The AIR reduces this input mod the Goldilocks prime
 * (2^64 − 2^32 + 1), so any u64 is *accepted*, but values above the prime alias
 * onto smaller ones. Staying under 2^63 keeps the mapping injective, so the
 * blinding we derive is exactly the blinding the circuit uses.
 */
const MASK_63 = (1n << 63n) - 1n;

/**
 * Derive a note's blinding from the pool seed, the pool, and the leaf index the
 * note occupies — the same inputs the note's other secrets use, so a recovering
 * client reproduces it with no stored state.
 */
export function deriveNoteBlinding(
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  leafIndex: number,
): bigint {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, leafIndex, true);
  const bytes = hkdf(
    sha256,
    walletSeed,
    undefined,
    concatBytes(BLINDING_INFO, poolPDA.toBytes(), idx),
    8,
  );
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n & MASK_63;
}
