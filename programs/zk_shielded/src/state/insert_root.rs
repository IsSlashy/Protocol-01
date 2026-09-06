//! [C6-D12] Turning circuit 6's depth-12 SUBTREE transition into a pool-root
//! transition.
//!
//! # Why this module has to exist
//!
//! Circuit 6 used to prove an insertion into the whole depth-15 tree, so the
//! program could take its `new_root` public input and store it. On 2026-08-29
//! C6 was cut to depth 12 to free 128 trace rows for a blinding region -- 128
//! against `R = 4*22 + 2 = 90` published openings per column, which is what
//! stops `air_aware_recovery_c6.rs` from solving four of the ten columns out of
//! the published bytes alone.
//!
//! The cut costs nothing on the wire (`next_pow2(384) == next_pow2(480) == 512`,
//! so trace length, quotient segments, blowup and proof size are all unchanged
//! -- measured at 81,037 bytes before and after) and it costs exactly one thing:
//! C6's roots are now roots of a 12-level SUBTREE, and the top `depth - 12`
//! levels have to be walked on chain.
//!
//! ⛔ WITHOUT THIS WALK A C6 PROOF SAYS "this leaf was inserted into SOME
//! 12-level subtree", which any depositor satisfies with a subtree they built
//! themselves, and the program would store the resulting root as the pool's.
//! That is a mint.
//!
//! # Why it is not `spend_root::resolve_pool_root`
//!
//! 🚨 THE C7 WALK TAKES ITS SIBLINGS FROM THE CALLER, AND COPYING THAT HERE
//! WOULD BE THE BUG. It is safe there for a reason that does not transfer: C7
//! READS. Its resolved root is then required to be one the pool already knows
//! (`pool.is_valid_root`), so a forged sibling yields a root in no history and
//! the spend fails.
//!
//! C6 WRITES. The root it produces is new by definition, so there is no history
//! to check it against, and a caller-supplied sibling would let a depositor name
//! any pool root at all.
//!
//! ⛔ AND THE WRONG VALUE IS ALREADY IN SCOPE AT THE CALL SITE. The instruction
//! receives `new_subtrees: Vec<[u8; 32]>` from the depositor, and
//! `insert_with_root_v3` writes it straight into `filled_subtrees` under a
//! comment saying, correctly, "these values are NOT bound by the C6 proof".
//! Reaching for that argument here -- it is in scope, it has the right type, it
//! has almost the right name -- reintroduces the whole hole.
//!
//! # What actually binds the result
//!
//! The fold is SELF-VERIFYING, and that is the design. Both the old and the new
//! subtree root are folded through the SAME siblings, and the caller is required
//! to check that the old one reproduces the pool's CURRENT root -- authoritative
//! state that no depositor writes directly. So:
//!
//!   - a wrong sibling breaks the old fold, and the deposit fails closed;
//!   - a wrong `leaf_index` picks different direction bits, breaks the old fold,
//!     and the deposit fails closed;
//!   - a wrong `tree_depth` walks a different number of levels, breaks the old
//!     fold, and the deposit fails closed.
//!
//! None of those three needs its own check, and adding one would imply the
//! old-root equality is optional. It is not. `fold_insertion` returns BOTH roots
//! so a caller cannot reach the new one without having been handed the old one
//! to compare.
//!
//! # Cost
//!
//! `depth - 12` levels, two roots, one `hash2` each: 6 Poseidon hashes at the
//! default depth 15.
//!
//! MEASURED 2026-08-29 by `subscribe_v4_adversarial::the_walk_is_what_the_new_instruction_pays_for`
//! on the litesvm SBF VM, walking the SAME levels for C7:
//!
//!   tree_depth 13 (1 level):   61,049 CU
//!   tree_depth 14 (2 levels):  99,290 CU
//!   tree_depth 15 (3 levels): 129,988 CU
//!   => one Poseidon-GL hash2:  ~34,469 CU
//!
//! So this fold costs ~206,814 CU: 6 hashes at the default depth.
//!
//! 🚨 I FIRST WROTE 32,969 HERE, CARRIED FROM A PLAN DOCUMENT RATHER THAN
//! MEASURED. It was low by ~1,500 CU per hash, ~9,000 across the fold. The
//! number above is the one the harness printed.
//!
//! ⚠️ 206,814 IS ALREADY OVER THE 200,000 CU DEFAULT PER-INSTRUCTION LIMIT ON
//! ITS OWN, before the deposit's existing work. Every shield surface must send
//! `set_compute_unit_limit`, and the web app's 300,000 was not enough.

use super::merkle_tree_v3::MerkleTreeStateV3;
use super::poseidon_gl::{hash2, MODULUS};

// MEASURED 2026-09-06 by `eras_and_depth::the_walk_costs_one_poseidon_per_level_on_deposit_twice_and_on_spend_once`
// on the real `shield_denominated_v3` handler in litesvm, honest C6 public
// inputs, one honest deposit per depth after `migrate_tree_depth`:
//
//   tree_depth 15 (4 levels): 293,511 CU
//   tree_depth 16 (5 levels): 361,165 CU
//   tree_depth 17 (6 levels): 428,737 CU
//   tree_depth 18 (7 levels): 496,445 CU
//   tree_depth 19 (8 levels): 563,987 CU
//   => one level of the deposit fold (two `hash2`): ~67,619 CU
//
// So the whole deposit instruction at depth 19 is under 600,000 CU; the
// client budget of 1,000,000 covers it with room, and the 700,000 the web app
// sends today would too.

/// The depth circuit 6 proves, after the 2026-08-29 cut.
///
/// 🚨 DELIBERATELY NOT NAMED `CANONICAL_DEPTH`. That name means 15 in
/// `p01_stark_verifier::verify` (for C3) and in `p01_stark::air::merkle_path`,
/// and 12 in `p01_stark::air::merkle_update` and `p01_stark::air::spend`. One
/// name, two values, four files. `spend_root.rs` avoided it for the same reason
/// and recorded what happened when it was not avoided: a probe hashing at row
/// 478 instead of 382.
// [ZK-DEPTH-11 2026-08-30] 12 -> 11. The circuit gave up one level so its
// blinding region could grow; this instruction takes it. The walk is now
// FOUR levels on a depth-15 pool, at ~34,469 CU per on-chain `hash2`.
//
// ⛔ IT MUST EQUAL THE CIRCUIT'S `CANONICAL_DEPTH`. They are one number in
// two crates: too small and the walk folds a root the proof never attested,
// too large and it folds past the pool's own depth.
pub const INSERT_SUBTREE_DEPTH: u8 = 11;

/// The most top levels this program will ever walk: the depth-20 ceiling that
/// `MerkleTreeStateV3::LEN` budgets for, minus 12.
pub const MAX_TOP_LEVELS: usize = 8;

/// Failures that are the caller's, kept separate from "the old root did not
/// match" so the instruction can report which of the two happened. Collapsing
/// both into `InvalidProof` is what makes a geometry mismatch look like a bad
/// proof and sends the reader to the prover.
#[derive(Debug, PartialEq, Eq)]
pub enum InsertRootError {
    /// `tree_depth <= INSERT_SUBTREE_DEPTH`: nothing to walk, and the pool and
    /// the circuit disagree about geometry. Failing here rather than returning
    /// the subtree root unchanged is deliberate -- a zero-level walk would
    /// silently promote a subtree root to a pool root.
    PoolShallowerThanCircuit,
    /// The pool's own `filled_subtrees` is too short for the levels being
    /// walked. Corrupted account state, not a bad request.
    SubtreeStateTooShort,
    /// A stored value is not a canonical Goldilocks element, or its 32-byte
    /// encoding is not zero-padded. A non-canonical u64 is a distinct value
    /// mod p, so accepting one lets two byte strings name the same root -- the
    /// same aliasing shape as the nullifier defect closed on 2026-08-26.
    NonCanonicalFelt,
    /// `leaf_index` is outside the tree.
    LeafIndexOutOfRange,
}

/// The result of a fold. Carries the old root so a caller cannot use the new one
/// without it.
#[derive(Debug, PartialEq, Eq)]
pub struct FoldedInsertion {
    /// Fold of the OLD subtree root. ⛔ The caller MUST require this equals the
    /// tree's current root. Nothing else binds the siblings, the leaf index or
    /// the depth.
    pub old_pool_root: u64,
    /// Fold of the NEW subtree root. Meaningful only once `old_pool_root`
    /// matched.
    pub new_pool_root: u64,
    updated: [(u8, u64); MAX_TOP_LEVELS],
    updated_len: usize,
}

impl FoldedInsertion {
    /// The top-level `filled_subtrees` entries this insertion changes, as
    /// `(level, value)`.
    ///
    /// These are DERIVED, not accepted: they are running values of the same fold
    /// that just reproduced the pool's own root, so a depositor cannot steer
    /// them the way they can steer the instruction's `new_subtrees` argument.
    pub fn updated_subtrees(&self) -> &[(u8, u64)] {
        &self.updated[..self.updated_len]
    }
}

/// Fold the top `tree_depth - INSERT_SUBTREE_DEPTH` levels of an insertion.
///
/// `old_subtree_root` and `new_subtree_root` are C6's public inputs 2 and 3.
/// `filled_subtrees` MUST be the POOL ACCOUNT's own array, one entry per level,
/// bottom-up. `leaf_index` supplies the direction bits for levels 12 and up.
///
/// ⛔ THE CALLER MUST REQUIRE `old_pool_root == tree.root`. This function
/// deliberately does not take the tree, so it cannot be mistaken for the whole
/// check -- the same shape `resolve_pool_root` uses, for the same reason.
pub fn fold_insertion(
    old_subtree_root: u64,
    new_subtree_root: u64,
    leaf_index: u64,
    filled_subtrees: &[u64],
    tree_depth: u8,
) -> Result<FoldedInsertion, InsertRootError> {
    if tree_depth <= INSERT_SUBTREE_DEPTH {
        return Err(InsertRootError::PoolShallowerThanCircuit);
    }
    if tree_depth >= 64 || leaf_index >= (1u64 << tree_depth) {
        return Err(InsertRootError::LeafIndexOutOfRange);
    }
    if filled_subtrees.len() < tree_depth as usize {
        return Err(InsertRootError::SubtreeStateTooShort);
    }
    if old_subtree_root >= MODULUS || new_subtree_root >= MODULUS {
        return Err(InsertRootError::NonCanonicalFelt);
    }

    let mut old = old_subtree_root;
    let mut new = new_subtree_root;
    let mut updated = [(0u8, 0u64); MAX_TOP_LEVELS];
    let mut updated_len = 0usize;

    for level in INSERT_SUBTREE_DEPTH..tree_depth {
        let l = level as usize;
        if (leaf_index >> level) & 1 == 0 {
            // The running node is the LEFT child. Everything to its right is
            // still empty, so the sibling is the canonical empty-subtree root
            // for this level: a constant, not state, and therefore not
            // forgeable.
            let zero = felt_of(&MerkleTreeStateV3::ZEROS[l])?;

            // Recorded BEFORE the hash, because the incremental-tree rule
            // records the running value at this level, not its parent. Doing it
            // after would store the parent one level too low and every later
            // insert on this branch would fold against a wrong sibling.
            if updated_len < MAX_TOP_LEVELS {
                updated[updated_len] = (level, new);
                updated_len += 1;
            }

            old = hash2(old, zero);
            new = hash2(new, zero);
        } else {
            // The running node is the RIGHT child, so the left sibling is the
            // completed subtree the pool recorded.
            //
            // ⛔ POOL STATE. Never the instruction's `new_subtrees` argument.
            let sib = filled_subtrees[l];
            if sib >= MODULUS {
                return Err(InsertRootError::NonCanonicalFelt);
            }
            old = hash2(sib, old);
            new = hash2(sib, new);
        }
    }

    Ok(FoldedInsertion {
        old_pool_root: old,
        new_pool_root: new,
        updated,
        updated_len,
    })
}

/// Read the low 8 bytes of a 32-byte field element, rejecting non-canonical
/// values and non-zero padding.
///
/// The upper 24 bytes MUST be zero. Accepting garbage there would let two
/// different 32-byte arrays denote the same Goldilocks element.
fn felt_of(bytes: &[u8; 32]) -> Result<u64, InsertRootError> {
    if bytes[8..].iter().any(|b| *b != 0) {
        return Err(InsertRootError::NonCanonicalFelt);
    }
    let v = u64::from_le_bytes(bytes[..8].try_into().unwrap());
    if v >= MODULUS {
        return Err(InsertRootError::NonCanonicalFelt);
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEPTH: u8 = 15;

    fn zeros(level: usize) -> u64 {
        felt_of(&MerkleTreeStateV3::ZEROS[level]).unwrap()
    }

    /// A full, honest incremental tree, built the plain way.
    ///
    /// This is the reference the fold is measured against. It is deliberately
    /// NOT written in terms of `fold_insertion`: a reference that shares the
    /// implementation proves only that the code equals itself.
    struct RefTree {
        filled: Vec<u64>,
        root: u64,
        count: u64,
    }

    impl RefTree {
        fn new() -> Self {
            RefTree {
                filled: (0..DEPTH as usize).map(zeros).collect(),
                root: zeros(DEPTH as usize),
                count: 0,
            }
        }

        fn insert(&mut self, leaf: u64) -> u64 {
            let index = self.count;
            let mut cur = leaf;
            let mut idx = index;
            for level in 0..DEPTH as usize {
                if idx % 2 == 0 {
                    self.filled[level] = cur;
                    cur = hash2(cur, zeros(level));
                } else {
                    cur = hash2(self.filled[level], cur);
                }
                idx /= 2;
            }
            self.root = cur;
            self.count += 1;
            index
        }

        /// The depth-12 subtree root the leaf at `index` lives under, which is
        /// what C6 would attest.
        fn subtree_root(&self, upto: u64) -> u64 {
            // Rebuild from scratch: the subtree containing leaves
            // [bucket*4096, bucket*4096 + 4096).
            let bucket = upto >> INSERT_SUBTREE_DEPTH;
            let lo = bucket << INSERT_SUBTREE_DEPTH;
            let mut level: Vec<u64> = (0..(1u64 << INSERT_SUBTREE_DEPTH))
                .map(|i| {
                    let g = lo + i;
                    if g < upto {
                        leaf_value(g)
                    } else {
                        0
                    }
                })
                .collect();
            for l in 0..INSERT_SUBTREE_DEPTH as usize {
                let _ = l;
                level = level.chunks(2).map(|c| hash2(c[0], c[1])).collect();
            }
            level[0]
        }
    }

    fn leaf_value(i: u64) -> u64 {
        1_000_003 + i * 7
    }

    /// The fold reproduces exactly what the honest incremental tree produces.
    ///
    /// Walks the first 40 insertions -- all inside bucket 0, so every top-level
    /// direction bit is 0 and the walk is entirely against ZEROS.
    #[test]
    fn the_fold_reproduces_the_honest_root_inside_the_first_bucket() {
        let mut t = RefTree::new();
        for i in 0..40u64 {
            let old_pool = t.root;
            let old_sub = t.subtree_root(i);
            let index = t.insert(leaf_value(i));
            let new_sub = t.subtree_root(i + 1);

            let f = fold_insertion(old_sub, new_sub, index, &t.filled, DEPTH)
                .expect("fold must succeed");
            assert_eq!(
                f.old_pool_root, old_pool,
                "insert {i}: the old fold did not reproduce the pool root",
            );
            assert_eq!(
                f.new_pool_root, t.root,
                "insert {i}: the new fold did not reproduce the honest new root",
            );
        }
    }

    /// ⛔ THE ATTACK THIS MODULE EXISTS TO STOP.
    ///
    /// A depositor invents a subtree of their own and proves an insertion into
    /// it. The C6 proof is perfectly honest about that subtree. The fold then
    /// fails, because the OLD subtree root they had to start from is not the one
    /// the pool actually holds, so the old fold does not reproduce the pool root.
    #[test]
    fn a_subtree_the_pool_does_not_hold_cannot_reach_the_pool_root() {
        let mut t = RefTree::new();
        for i in 0..5u64 {
            t.insert(leaf_value(i));
        }
        let honest_old_sub = t.subtree_root(5);
        let forged_old_sub = honest_old_sub ^ 0x5EED;
        let forged_new_sub = hash2(forged_old_sub, 42);

        let f = fold_insertion(forged_old_sub, forged_new_sub, 5, &t.filled, DEPTH)
            .expect("the fold itself is arithmetic and still runs");
        assert_ne!(
            f.old_pool_root, t.root,
            "a forged subtree reproduced the pool root: the fold binds nothing",
        );
    }

    /// A wrong leaf index picks different direction bits and breaks the old
    /// fold. No separate index check is needed, and this is the measurement that
    /// says so.
    #[test]
    fn a_wrong_leaf_index_breaks_the_old_fold() {
        let mut t = RefTree::new();
        for i in 0..3u64 {
            t.insert(leaf_value(i));
        }
        let old_sub = t.subtree_root(3);
        let index = t.insert(leaf_value(3));
        let new_sub = t.subtree_root(4);

        let honest = fold_insertion(old_sub, new_sub, index, &t.filled, DEPTH).unwrap();
        assert_eq!(honest.old_pool_root, {
            // recompute the pre-insert root the honest way
            let mut u = RefTree::new();
            for i in 0..3u64 {
                u.insert(leaf_value(i));
            }
            u.root
        });

        // Move the index into another bucket: the direction bits at levels
        // 12..15 change, so the walk takes a different shape.
        let lied = index + (1u64 << INSERT_SUBTREE_DEPTH);
        let f = fold_insertion(old_sub, new_sub, lied, &t.filled, DEPTH).unwrap();
        assert_ne!(
            f.old_pool_root, honest.old_pool_root,
            "the leaf index is not bound into the fold",
        );
    }

    /// A forged top-level sibling breaks the old fold.
    #[test]
    fn a_forged_top_level_sibling_breaks_the_old_fold() {
        let mut t = RefTree::new();
        for i in 0..7u64 {
            t.insert(leaf_value(i));
        }
        let old_sub = t.subtree_root(7);
        let new_sub = hash2(old_sub, 1);
        let index = 7u64 + (1u64 << INSERT_SUBTREE_DEPTH); // force a 1 bit at level 12

        let honest = fold_insertion(old_sub, new_sub, index, &t.filled, DEPTH).unwrap();
        let mut tampered = t.filled.clone();
        tampered[INSERT_SUBTREE_DEPTH as usize] ^= 0xBEEF;
        let forged = fold_insertion(old_sub, new_sub, index, &tampered, DEPTH).unwrap();
        assert_ne!(
            honest.old_pool_root, forged.old_pool_root,
            "the level-12 sibling is not bound into the fold",
        );
    }

    /// The updated subtree entries are the ones the honest tree writes.
    ///
    /// This is what makes the caller-supplied `new_subtrees` argument
    /// unnecessary at the top levels rather than merely unused.
    #[test]
    fn the_derived_subtrees_match_the_honest_tree() {
        let mut t = RefTree::new();
        for i in 0..20u64 {
            let old_sub = t.subtree_root(i);
            let before = t.filled.clone();
            let index = t.insert(leaf_value(i));
            let new_sub = t.subtree_root(i + 1);

            let f = fold_insertion(old_sub, new_sub, index, &before, DEPTH).unwrap();
            for (level, value) in f.updated_subtrees() {
                assert_eq!(
                    *value, t.filled[*level as usize],
                    "insert {i}: derived subtree at level {level} disagrees with the honest tree",
                );
            }
        }
    }

    /// Every caller error is reported and none is swallowed into a silent
    /// success.
    #[test]
    fn every_caller_error_is_reported_and_not_swallowed() {
        let filled = vec![7u64; DEPTH as usize];

        assert_eq!(
            fold_insertion(1, 2, 0, &filled, INSERT_SUBTREE_DEPTH),
            Err(InsertRootError::PoolShallowerThanCircuit),
            "a pool at exactly the circuit depth must not silently skip the walk",
        );
        assert_eq!(
            fold_insertion(1, 2, 1u64 << DEPTH, &filled, DEPTH),
            Err(InsertRootError::LeafIndexOutOfRange),
        );
        assert_eq!(
            fold_insertion(1, 2, 0, &filled[..4], DEPTH),
            Err(InsertRootError::SubtreeStateTooShort),
        );
        assert_eq!(
            fold_insertion(MODULUS, 2, 0, &filled, DEPTH),
            Err(InsertRootError::NonCanonicalFelt),
        );
        assert_eq!(
            fold_insertion(1, MODULUS, 0, &filled, DEPTH),
            Err(InsertRootError::NonCanonicalFelt),
        );

        // A non-canonical stored sibling is only READ when the direction bit is
        // 1, so the rejection has to be checked on that branch specifically.
        let mut bad = filled.clone();
        bad[INSERT_SUBTREE_DEPTH as usize] = MODULUS;
        assert_eq!(
            fold_insertion(1, 2, 1u64 << INSERT_SUBTREE_DEPTH, &bad, DEPTH),
            Err(InsertRootError::NonCanonicalFelt),
        );
    }

    /// The default pool needs four levels, and the walk is not a no-op.
    ///
    /// [ZK-DEPTH-11 2026-08-30] 3 -> 4. The fold now does EIGHT `hash2` calls,
    /// not six -- four levels, old root and new root -- so ~275,752 CU at the
    /// ~34,469 measured per hash. The shield compute budget must follow.
    #[test]
    fn the_default_pool_needs_four_levels() {
        assert_eq!(
            crate::state::pool_v3::DenominatedPoolV3::DEFAULT_TREE_DEPTH - INSERT_SUBTREE_DEPTH,
            4,
            "the levels this module walks changed; the CU budget and the shield \
             compute-unit limit both move with it",
        );

        // And a subtree root is NOT a pool root: three levels of hashing sit
        // between them. If this ever passed, the fold would be doing nothing.
        let f = fold_insertion(123, 456, 0, &vec![0u64; DEPTH as usize], DEPTH).unwrap();
        assert_ne!(f.old_pool_root, 123);
        assert_ne!(f.new_pool_root, 456);
    }

    /// C6's depth and C7's are the same number, and they must stay that way.
    ///
    /// Not a tautology: they are two independent constants in two modules, and
    /// the pool's `filled_subtrees` is shared by both paths. If the insert side
    /// were cut to 13 and the spend side left at 12, deposits would write
    /// subtree entries at levels the spend walk does not read.
    #[test]
    fn the_insert_and_spend_subtree_depths_agree() {
        assert_eq!(
            INSERT_SUBTREE_DEPTH,
            crate::state::spend_root::SPEND_SUBTREE_DEPTH,
            "C6 and C7 must cut the tree at the same level",
        );
    }
}
