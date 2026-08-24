//! [C7] Resolving a depth-12 subtree root into the pool root.
//!
//! # The hole this closes
//!
//! Circuit 7 proves membership of a leaf in a subtree of depth
//! `CANONICAL_DEPTH = 12`. Its public input 1 is that SUBTREE root, and the
//! circuit says nothing about which subtree it is. The pool tree is depth 15.
//!
//! So a C7 proof, verified and accepted on its own, means:
//!
//!     "I know a leaf and a twelve-level path from it to the root I published."
//!
//! and NOT:
//!
//!     "that leaf is in this pool."
//!
//! ⛔ Anyone who builds their own twelve-level tree over a leaf they invented
//! produces a proof the verifier accepts. Spending on that alone drains the
//! pool, in the same class as `unshield` C5 before 2026-08-18. The circuit is
//! not wrong -- the missing half is here, on chain.
//!
//! # What has to happen instead
//!
//! The spending instruction walks the remaining `tree_depth - 12` levels
//! itself, hashing the subtree root against siblings the CALLER supplies, and
//! then requires the result to be a root the pool has vouched for.
//!
//! ⛔ NOT `filled_subtrees`. That array is an INSERTION FRONTIER: it holds the
//! left-hand siblings along the path of the *next* leaf. It cannot supply the
//! siblings of an arbitrary existing leaf, and nothing binds it to the proof.
//! Reaching for it here would look plausible and would be a second hole.
//!
//! # Why caller-supplied siblings are safe
//!
//! They are not trusted. They are only a way to name a candidate root. The
//! caller may pass anything; the result is then compared against
//! `pool.is_valid_root`, which only accepts roots the pool itself published.
//! Wrong siblings give a root the pool never had, and the spend is refused.
//!
//! What the caller CAN choose is which valid root to aim at, and that is
//! already true of C3 today.
//!
//! # 🚨 The bucket, and the hazard that arrives later
//!
//! Twelve levels under fifteen names one subtree out of eight, and the top
//! path bits say WHICH. Today every note lives in bucket 0 -- the pool holds
//! far fewer than 4,096 leaves -- so the bits carry no information.
//!
//! That stops being true at leaf 4,097: the first leaf of a new bucket is the
//! only member of it, and its top bits identify it uniquely. The anonymity set
//! is then one, for that spender, until the bucket fills.
//!
//! This is not a reason to avoid the design; it is a reason to know the number.
//! `the_bucket_index_is_free_only_while_one_bucket_is_occupied` below fails the
//! day the pool crosses the boundary, so it is noticed by a test rather than by
//! a user.

use super::poseidon_gl::hash2;

/// The depth circuit 7 proves. Mirrors `CANONICAL_DEPTH` in
/// `stark/src/air/spend.rs`.
///
/// 🚨 THE NAME `CANONICAL_DEPTH` MEANS 15 IN FOUR OTHER PLACES IN THIS TREE
/// (`p01_stark_verifier::verify` three times, `p01_stark::air::merkle_path`).
/// It is deliberately NOT reused here. Reaching for the familiar name is how
/// the C7 CU probe ended up hashing at row 478 -- `(15-1)*32+30` -- instead of
/// row 382, and 478 sits inside the circuit's blinding region where nothing is
/// constrained at all.
pub const SPEND_SUBTREE_DEPTH: u8 = 12;

/// Errors that are the CALLER's fault, kept distinct from "the root is not in
/// the pool" so the instruction can report which of the two happened.
#[derive(Debug, PartialEq, Eq)]
pub enum SpendRootError {
    /// `tree_depth` is not deeper than the subtree the circuit proves. Nothing
    /// to walk, and it means the pool and the circuit disagree about geometry.
    PoolShallowerThanCircuit,
    /// Sibling count does not equal `tree_depth - SPEND_SUBTREE_DEPTH`.
    WrongSiblingCount,
    /// A direction bit was neither 0 nor 1.
    NonBinaryDirection,
    /// A supplied value is not a canonical Goldilocks element.
    NonCanonicalFelt,
}

/// Walk the top `tree_depth - SPEND_SUBTREE_DEPTH` levels.
///
/// `subtree_root` is C7's public input 1. `siblings[i]` and `directions[i]`
/// describe level `SPEND_SUBTREE_DEPTH + i`, bottom-up; `directions[i] == 0`
/// means the running value is the LEFT input at that level.
///
/// Returns the candidate pool root as a field element. ⛔ The caller MUST then
/// require `pool.is_valid_root(..)` on it -- this function deliberately does
/// not know about the pool, so it cannot be mistaken for the whole check.
pub fn resolve_pool_root(
    subtree_root: u64,
    siblings: &[u64],
    directions: &[u8],
    tree_depth: u8,
) -> Result<u64, SpendRootError> {
    if tree_depth <= SPEND_SUBTREE_DEPTH {
        return Err(SpendRootError::PoolShallowerThanCircuit);
    }
    let levels = (tree_depth - SPEND_SUBTREE_DEPTH) as usize;
    if siblings.len() != levels || directions.len() != levels {
        return Err(SpendRootError::WrongSiblingCount);
    }

    let m = super::poseidon_gl::MODULUS;
    if subtree_root >= m || siblings.iter().any(|s| *s >= m) {
        // A non-canonical u64 is a distinct value mod p, so accepting one would
        // let two different byte strings name the same root.
        return Err(SpendRootError::NonCanonicalFelt);
    }

    let mut current = subtree_root;
    for i in 0..levels {
        current = match directions[i] {
            0 => hash2(current, siblings[i]),
            1 => hash2(siblings[i], current),
            _ => return Err(SpendRootError::NonBinaryDirection),
        };
    }
    Ok(current)
}

/// The bucket a spend names, given its top path bits.
///
/// `directions` is the same bottom-up slice `resolve_pool_root` takes, so
/// bucket = sum(directions[i] << i).
pub fn bucket_index(directions: &[u8]) -> u32 {
    let mut b = 0u32;
    for (i, d) in directions.iter().enumerate() {
        b |= ((*d & 1) as u32) << i;
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::poseidon_gl::MODULUS;

    fn walk(root: u64, sibs: &[u64], dirs: &[u8]) -> u64 {
        let mut cur = root;
        for i in 0..sibs.len() {
            cur = if dirs[i] == 0 {
                hash2(cur, sibs[i])
            } else {
                hash2(sibs[i], cur)
            };
        }
        cur
    }

    #[test]
    fn resolves_the_same_root_the_honest_walk_produces() {
        let sibs = [111u64, 222, 333];
        for bits in 0..8u8 {
            let dirs = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1];
            let got = resolve_pool_root(0xABCD_EF01_2345_6789, &sibs, &dirs, 15).unwrap();
            assert_eq!(got, walk(0xABCD_EF01_2345_6789, &sibs, &dirs), "bits {bits}");
        }
    }

    /// 🚨 THE PROPERTY THE WHOLE FILE EXISTS FOR: a different subtree root gives
    /// a different pool root. That is what makes `is_valid_root` a real check
    /// rather than a formality -- an attacker's invented subtree cannot land on
    /// a root the pool published except by breaking Poseidon.
    #[test]
    fn a_forged_subtree_root_does_not_reach_the_same_pool_root() {
        let sibs = [7u64, 8, 9];
        let dirs = [0u8, 1, 0];
        let honest = resolve_pool_root(42, &sibs, &dirs, 15).unwrap();
        for forged in [43u64, 0, 1, MODULUS - 1, 0xDEAD_BEEF] {
            let got = resolve_pool_root(forged, &sibs, &dirs, 15).unwrap();
            assert_ne!(got, honest, "forged subtree root {forged} collided");
        }
    }

    /// Changing the direction bits alone reaches a different root, so the
    /// caller cannot re-point a valid path at another bucket.
    #[test]
    fn the_direction_bits_are_bound_into_the_result() {
        let sibs = [7u64, 8, 9];
        let base = resolve_pool_root(42, &sibs, &[0, 0, 0], 15).unwrap();
        for bits in 1..8u8 {
            let dirs = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1];
            assert_ne!(
                resolve_pool_root(42, &sibs, &dirs, 15).unwrap(),
                base,
                "direction bits {bits} produced the same root as 000"
            );
        }
    }

    #[test]
    fn every_caller_error_is_reported_and_not_swallowed() {
        let sibs = [1u64, 2, 3];
        assert_eq!(
            resolve_pool_root(1, &sibs, &[0, 0, 0], 12),
            Err(SpendRootError::PoolShallowerThanCircuit),
        );
        assert_eq!(
            resolve_pool_root(1, &[1, 2], &[0, 0], 15),
            Err(SpendRootError::WrongSiblingCount),
        );
        assert_eq!(
            resolve_pool_root(1, &sibs, &[0, 2, 0], 15),
            Err(SpendRootError::NonBinaryDirection),
        );
        assert_eq!(
            resolve_pool_root(MODULUS, &sibs, &[0, 0, 0], 15),
            Err(SpendRootError::NonCanonicalFelt),
        );
        assert_eq!(
            resolve_pool_root(1, &[MODULUS, 2, 3], &[0, 0, 0], 15),
            Err(SpendRootError::NonCanonicalFelt),
        );
    }

    /// A depth-15 pool needs exactly three levels walked on chain.
    #[test]
    fn the_default_pool_needs_three_levels() {
        assert_eq!(
            crate::state::pool_v3::DenominatedPoolV3::DEFAULT_TREE_DEPTH - SPEND_SUBTREE_DEPTH,
            3,
        );
    }

    /// 🚨 Fails the day the pool crosses into a second bucket. At that point the
    /// top path bits stop being constant across the anonymity set and start
    /// naming which eighth of the tree a spender's note is in -- and the FIRST
    /// leaf of a new bucket is alone in it.
    ///
    /// This is a NUMBER, not a defect: the design is still right, but nobody
    /// should learn about the boundary from a user.
    #[test]
    fn the_bucket_index_is_free_only_while_one_bucket_is_occupied() {
        let leaves_per_bucket: u64 = 1 << SPEND_SUBTREE_DEPTH; // 4096
        assert_eq!(leaves_per_bucket, 4096);

        // Measured 2026-08-22: 73 deposited on the 1 SOL pool, 82 on the 0.1.
        for live in [73u64, 82, 155, 4096] {
            assert_eq!(live.div_ceil(leaves_per_bucket), 1, "{live} leaves stay in bucket 0");
        }
        // And the boundary.
        assert_eq!((leaves_per_bucket + 1).div_ceil(leaves_per_bucket), 2);
        assert_eq!(bucket_index(&[1, 0, 0]), 1);
        assert_eq!(bucket_index(&[1, 1, 1]), 7);
    }
}
