//! Merkle Update STARK AIR
//!
//! Proves that replacing a single leaf in a Merkle tree transforms `old_root`
//! into `new_root`. The path elements and indices are shared: only the leaf
//! differs between the two hash chains. This is the fundamental building block
//! for trustless pool insertions without an on-chain Poseidon syscall.
//!
//! Trace layout (width = 10, length = next_pow2(DEPTH * 32)):
//!   col 0-2: Poseidon state for OLD path (leaf → old_root)
//!   col 3-5: Poseidon state for NEW path (leaf → new_root)
//!   col 6:   sibling (shared between old/new paths)
//!   col 7:   direction (shared, binary)
//!   col 8:   old_carry (old_leaf at row 0, chain of old hash outputs)
//!   col 9:   new_carry (new_leaf at row 0, chain of new hash outputs)
//!
//! Each Merkle level is one 32-row hash cycle:
//!   Rows 0-29:  Poseidon rounds (state transitions)
//!   Row 30:     Final Poseidon output (usable by next cycle as carry)
//!   Row 31:     Padding row (identity)
//!
//! Public inputs: old_leaf, new_leaf, old_root, new_root, depth
//! Private inputs: path_elements[DEPTH], path_indices[DEPTH]
//!
//! Soundness note: since both paths use the same sibling+direction columns,
//! a malicious prover cannot independently forge old and new paths — they are
//! bound together by the same witness.
//!
//! ## ⛔ C6 IS NOT ZERO-KNOWLEDGE, MEASURED 2026-08-29
//!
//! Four of these ten columns are fully determined by the published proof bytes.
//! `stark/tests/air_aware_recovery_c6.rs` recovers them and prints the numbers:
//!
//! ```text
//!   col 6  sibling      the authentication path      15 unknowns vs R = 90
//!   col 7  direction    the leaf index, in binary     15 unknowns
//!   col 8  old_carry    old_leaf -> ... -> old_root   16 segments, 2 public
//!   col 9  new_carry    new_leaf -> ... -> new_root   16 segments, 2 public
//! ```
//!
//! The cause is in this file: the builder writes ONE value across all 32 rows of
//! a cycle for those four columns (`:397-400`, `:445-448`, `:459-462`), so a
//! 512-row column carries fifteen unknowns, not 512. Equalities are linear, so
//! nobody has to invert Poseidon.
//!
//! ⚠️ The honest limit, because it is easy to overstate: `old_leaf`, `new_leaf`,
//! `old_root` and `new_root` are all PUBLIC inputs, so an observer holding the
//! tree could already walk it to the index and the siblings. This is not a new
//! linkage. It is a proof that C6 is not zero-knowledge, and it SIZES the mask.
//!
//! ## THE FIX, AND WHY C6 IS CHEAPER THAN C3 AND C7
//!
//! `R = 4 * num_queries + 2 = 90` free rows are needed. At `CANONICAL_DEPTH = 15`
//! the walk fills 480 of 512 rows and leaves 32 — short by 58. The tail is not
//! even free today: with the periodic flags at zero the Poseidon constraints
//! degenerate to `next[i] - current[i] = 0`, so the columns are PINNED constant,
//! which is one degree of freedom per column rather than 32.
//!
//! ✅ Cutting the depth to 12 frees 128 rows on all ten columns, margin 38.
//! `trace_length_for_depth(12) = next_pow2(384 + 1) = 512`, unchanged — so `n`,
//! `deg(Q)`, `quotient_segments = 8` and `rho = 1/16` all stay put, and the wire
//! does not grow by a byte. It is exactly the move C7 made (`air/spend.rs:317`).
//!
//! 🚨 **AND THE TOP-LEVEL WALK IS EASIER HERE THAN IT WAS FOR C7.** C7's plan
//! rejects `filled_subtrees` as the source of the three top siblings
//! (`air/spend.rs:153-161`) because it is an INSERTION FRONTIER: it holds one
//! value per level on the CURRENT insertion path, so it cannot supply the
//! siblings of an arbitrary historical leaf. That objection is right for C7, and
//! for C3 — both prove membership of a leaf deposited long ago.
//!
//! It does NOT apply to C6. C6 proves an INSERTION, and an insertion is always
//! at the frontier, which is what `filled_subtrees` IS. A depth-12 C6 folds both
//! subtree roots up the remaining three levels against the POOL ACCOUNT's own
//! stored frontier — no untrusted instruction data, no `is_valid_root` dance.
//!
//! ⛔ AND THE TRAP INSIDE THAT, WHICH IS A FUND-LOSS SHAPE. It must read the
//! **pool account's** `filled_subtrees`, NEVER the caller-supplied
//! `new_subtrees`. `verify_c6_proof_buffer` hashes exactly 40 bytes —
//! `[old_leaf, new_leaf, old_root, new_root, depth]` — so `new_subtrees` is
//! UNATTESTED and any depositor can write arbitrary bytes into it.
//!
//! ✅ The anonymity cost of this cut is ZERO, unlike C7's. C7 pays because a
//! spend then names one of 8 buckets — and at a bucket boundary an individual's
//! set can be 1 while the aggregate reports 0.001 bits (`air/spend.rs:196-202`).
//! C6 pays nothing: a leaf's bucket follows from its INSERTION INDEX, not from
//! this circuit's depth, so cutting the depth re-partitions nothing. And the
//! deposit already names its author — `depositor: Signer` is in the transaction
//! accounts, which `shield_denominated_v3.rs` states outright.
//!
//! ⚠️ The change is prover-AND-verifier lockstep and ends in a redeploy: gating
//! rows 480..511 off prover-side while the deployed verifier still checks them
//! is a disagreement, not a masking. See the plan's 30-item checklist.

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

pub const TRACE_WIDTH: usize = 10;
const HASH_CYCLE_LEN: usize = 32;
const NUM_ROUNDS: usize = 30;

/// Compute trace length for a given Merkle depth.
///
/// We force `trace_length > active_rows` so that the boundary transition
/// constraint at the last active row does not wrap around to row 0.
pub fn trace_length_for_depth(depth: usize) -> usize {
    let active = depth * HASH_CYCLE_LEN;
    (active + 1).next_power_of_two()
}

// ============================================================================
// Public inputs
// ============================================================================

#[derive(Clone, Debug)]
pub struct MerkleUpdatePublicInputs {
    pub old_leaf: BaseElement,
    pub new_leaf: BaseElement,
    pub old_root: BaseElement,
    pub new_root: BaseElement,
    pub depth: usize,
}

impl ToElements<BaseElement> for MerkleUpdatePublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.old_leaf,
            self.new_leaf,
            self.old_root,
            self.new_root,
            BaseElement::new(self.depth as u64),
        ]
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct MerkleUpdateAir {
    context: AirContext<BaseElement>,
    old_leaf: BaseElement,
    new_leaf: BaseElement,
    old_root: BaseElement,
    new_root: BaseElement,
    depth: usize,
    trace_length: usize,
}

impl Air for MerkleUpdateAir {
    type BaseField = BaseElement;
    type PublicInputs = MerkleUpdatePublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        let trace_length = trace_info.length();

        // Constraint degrees (two mirrored Poseidon pipelines + shared path):
        // [0-2]   OLD Poseidon round: degree 7
        // [3-5]   NEW Poseidon round: degree 7
        // [6-7]   OLD hash-start mux: degree 2
        // [8-9]   NEW hash-start mux: degree 2
        // [10]    OLD capacity: degree 1
        // [11]    NEW capacity: degree 1
        // [12]    OLD carry update at boundary: degree 1
        // [13]    NEW carry update at boundary: degree 1
        // [14]    OLD carry continuity: degree 1
        // [15]    NEW carry continuity: degree 1
        // [16-17] Sibling/direction continuity: degree 1
        // [18]    Direction binary: degree 2
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]), // 0
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]), // 1
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]), // 2
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]), // 3
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]), // 4
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]), // 5
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),               // 6
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),               // 7
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),               // 8
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),               // 9
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 10
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 11
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 12
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 13
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 14
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 15
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 16
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),               // 17
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),               // 18
        ];

        // Assertions: old+new leaf carry at row 0, old+new root at last hash output row.
        let num_assertions = 4;
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            old_leaf: pub_inputs.old_leaf,
            new_leaf: pub_inputs.new_leaf,
            old_root: pub_inputs.old_root,
            new_root: pub_inputs.new_root,
            depth: pub_inputs.depth,
            trace_length,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_merkle_update_periodic_columns(self.depth, self.trace_length)
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_merkle_update_transition(
            frame.current(),
            frame.next(),
            periodic_values,
            result,
        );
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        let output_row = (self.depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS;
        vec![
            // Old carry at row 0 = old_leaf
            Assertion::single(8, 0, self.old_leaf),
            // New carry at row 0 = new_leaf
            Assertion::single(9, 0, self.new_leaf),
            // OLD hash output of last cycle = old_root
            Assertion::single(0, output_row, self.old_root),
            // NEW hash output of last cycle = new_root
            Assertion::single(3, output_row, self.new_root),
        ]
    }
}

// ============================================================================
// Helper
// ============================================================================

#[inline(always)]
fn pow7<E: FieldElement>(x: E) -> E {
    let x2 = x * x;
    let x4 = x2 * x2;
    x4 * x2 * x
}

pub const MERKLE_UPDATE_NUM_CONSTRAINTS: usize = 19;
pub const MERKLE_UPDATE_NUM_PERIODIC: usize = 7;

/// Build the 7 periodic column value vectors for a circuit-6 trace.
///
/// Exposed so the prover can interpolate / inverse-NTT them for LDE and OOD
/// evaluations outside the AIR.
pub fn build_merkle_update_periodic_columns(
    depth: usize,
    trace_length: usize,
) -> Vec<Vec<BaseElement>> {
    let tl = trace_length;
    let active_rows = depth * HASH_CYCLE_LEN;

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mut rc0 = vec![BaseElement::ZERO; tl];
    let mut rc1 = vec![BaseElement::ZERO; tl];
    let mut rc2 = vec![BaseElement::ZERO; tl];

    for row in 0..active_rows {
        let pos_in_cycle = row % HASH_CYCLE_LEN;
        if pos_in_cycle < NUM_ROUNDS {
            rc0[row] = rc[pos_in_cycle * 3];
            rc1[row] = rc[pos_in_cycle * 3 + 1];
            rc2[row] = rc[pos_in_cycle * 3 + 2];
        }
    }

    let mut round_active = vec![BaseElement::ZERO; tl];
    for row in 0..active_rows {
        if row % HASH_CYCLE_LEN < NUM_ROUNDS {
            round_active[row] = BaseElement::ONE;
        }
    }

    let mut hash_start = vec![BaseElement::ZERO; tl];
    for cycle in 0..depth {
        hash_start[cycle * HASH_CYCLE_LEN] = BaseElement::ONE;
    }

    let mut is_boundary = vec![BaseElement::ZERO; tl];
    for cycle in 0..depth {
        is_boundary[cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1] = BaseElement::ONE;
    }

    let mut is_interior = vec![BaseElement::ZERO; tl];
    for row in 0..active_rows {
        let pos = row % HASH_CYCLE_LEN;
        if pos >= 1 && pos <= NUM_ROUNDS {
            is_interior[row] = BaseElement::ONE;
        }
    }

    vec![rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]
}

/// Standalone evaluator for circuit 6 transition constraints.
///
/// Mirrors `MerkleUpdateAir::evaluate_transition` so the prover can evaluate
/// the same constraints at LDE and OOD points without instantiating the AIR.
/// `current` / `next` must be length 10, `periodic` length 7, `result` length 19.
///
/// Periodic layout: `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]`.
pub fn evaluate_merkle_update_transition<E: FieldElement>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), TRACE_WIDTH);
    debug_assert_eq!(next.len(), TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), MERKLE_UPDATE_NUM_PERIODIC);
    debug_assert_eq!(result.len(), MERKLE_UPDATE_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_active = periodic[3];
    let hash_start = periodic[4];
    let is_boundary = periodic[5];
    let is_interior = periodic[6];

    let three = E::from(3u32);
    let not_boundary = E::ONE - is_boundary;

    // ── OLD Poseidon round (cols 0-2) ──
    let o0 = current[0] + rc0;
    let o1 = current[1] + rc1;
    let o2 = current[2] + rc2;
    let o0_7 = pow7(o0);
    let o1_7 = pow7(o1);
    let o2_7 = pow7(o2);
    let oro0 = three * o0_7 + o1_7 + o2_7;
    let oro1 = o0_7 + three * o1_7 + o2_7;
    let oro2 = o0_7 + o1_7 + three * o2_7;
    result[0] = not_boundary * (next[0] - current[0] - round_active * (oro0 - current[0]));
    result[1] = not_boundary * (next[1] - current[1] - round_active * (oro1 - current[1]));
    result[2] = not_boundary * (next[2] - current[2] - round_active * (oro2 - current[2]));

    // ── NEW Poseidon round (cols 3-5) ──
    let n0 = current[3] + rc0;
    let n1 = current[4] + rc1;
    let n2 = current[5] + rc2;
    let n0_7 = pow7(n0);
    let n1_7 = pow7(n1);
    let n2_7 = pow7(n2);
    let nro0 = three * n0_7 + n1_7 + n2_7;
    let nro1 = n0_7 + three * n1_7 + n2_7;
    let nro2 = n0_7 + n1_7 + three * n2_7;
    result[3] = not_boundary * (next[3] - current[3] - round_active * (nro0 - current[3]));
    result[4] = not_boundary * (next[4] - current[4] - round_active * (nro1 - current[4]));
    result[5] = not_boundary * (next[5] - current[5] - round_active * (nro2 - current[5]));

    // ── Hash start mux: state = mux(direction, carry, sibling) ──
    let dir = current[7];
    let sib = current[6];
    let old_carry = current[8];
    let new_carry = current[9];

    result[6] = hash_start * (current[0] - old_carry - dir * (sib - old_carry));
    result[7] = hash_start * (current[1] - sib - dir * (old_carry - sib));
    result[8] = hash_start * (current[3] - new_carry - dir * (sib - new_carry));
    result[9] = hash_start * (current[4] - sib - dir * (new_carry - sib));
    result[10] = hash_start * current[2];
    result[11] = hash_start * current[5];

    // ── Carry update at boundary ──
    result[12] = is_boundary * (next[8] - current[0]);
    result[13] = is_boundary * (next[9] - current[3]);

    // ── Carry continuity ──
    result[14] = (E::ONE - is_boundary) * (next[8] - current[8]);
    result[15] = (E::ONE - is_boundary) * (next[9] - current[9]);

    // ── Sibling/direction continuity within cycle ──
    result[16] = is_interior * (next[6] - current[6]);
    result[17] = is_interior * (next[7] - current[7]);

    // ── Direction binary ──
    result[18] = hash_start * dir * (E::ONE - dir);
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build the execution trace for a Merkle update proof.
///
/// Both old and new hash chains share the same `path_elements` and `path_indices`;
/// only the leaf differs.
pub fn build_merkle_update_trace(
    old_leaf: BaseElement,
    new_leaf: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
) -> Vec<Vec<BaseElement>> {
    let depth = path_elements.len();
    assert_eq!(depth, path_indices.len());
    assert!(depth > 0);

    let trace_length = trace_length_for_depth(depth);
    let mut trace = vec![vec![BaseElement::ZERO; trace_length]; TRACE_WIDTH];

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mds = &poseidon::constants::MDS_MATRIX_T3;

    let mut old_carry = old_leaf;
    let mut new_carry = new_leaf;

    for level in 0..depth {
        let cycle_start = level * HASH_CYCLE_LEN;
        let sibling = path_elements[level];
        let dir = path_indices[level];
        let dir_felt = if dir == 0 { BaseElement::ZERO } else { BaseElement::ONE };

        // Hash inputs for OLD path
        let (old_left, old_right) = if dir == 0 {
            (old_carry, sibling)
        } else {
            (sibling, old_carry)
        };
        // Hash inputs for NEW path
        let (new_left, new_right) = if dir == 0 {
            (new_carry, sibling)
        } else {
            (sibling, new_carry)
        };

        let mut old_state = [old_left, old_right, BaseElement::ZERO];
        let mut new_state = [new_left, new_right, BaseElement::ZERO];

        // Write row 0 of this cycle
        trace[0][cycle_start] = old_state[0];
        trace[1][cycle_start] = old_state[1];
        trace[2][cycle_start] = old_state[2];
        trace[3][cycle_start] = new_state[0];
        trace[4][cycle_start] = new_state[1];
        trace[5][cycle_start] = new_state[2];
        trace[6][cycle_start] = sibling;
        trace[7][cycle_start] = dir_felt;
        trace[8][cycle_start] = old_carry;
        trace[9][cycle_start] = new_carry;

        // Poseidon rounds 0..29 (rows 1..30 of this cycle)
        for round in 0..NUM_ROUNDS {
            // Add round constants
            old_state[0] = old_state[0] + rc[round * 3];
            old_state[1] = old_state[1] + rc[round * 3 + 1];
            old_state[2] = old_state[2] + rc[round * 3 + 2];
            new_state[0] = new_state[0] + rc[round * 3];
            new_state[1] = new_state[1] + rc[round * 3 + 1];
            new_state[2] = new_state[2] + rc[round * 3 + 2];

            // Full S-box
            for s in &mut old_state {
                let x = *s;
                let x2 = x * x;
                let x4 = x2 * x2;
                *s = x4 * x2 * x;
            }
            for s in &mut new_state {
                let x = *s;
                let x2 = x * x;
                let x4 = x2 * x2;
                *s = x4 * x2 * x;
            }

            // MDS
            let mut o = [BaseElement::ZERO; 3];
            let mut n = [BaseElement::ZERO; 3];
            for i in 0..3 {
                for j in 0..3 {
                    o[i] = o[i] + mds[i][j] * old_state[j];
                    n[i] = n[i] + mds[i][j] * new_state[j];
                }
            }
            old_state = o;
            new_state = n;

            let row = cycle_start + round + 1;
            trace[0][row] = old_state[0];
            trace[1][row] = old_state[1];
            trace[2][row] = old_state[2];
            trace[3][row] = new_state[0];
            trace[4][row] = new_state[1];
            trace[5][row] = new_state[2];
            trace[6][row] = sibling;
            trace[7][row] = dir_felt;
            trace[8][row] = old_carry;
            trace[9][row] = new_carry;
        }

        // Padding row 31 (copy of row 30, boundary position)
        let pad_row = cycle_start + NUM_ROUNDS + 1;
        trace[0][pad_row] = old_state[0];
        trace[1][pad_row] = old_state[1];
        trace[2][pad_row] = old_state[2];
        trace[3][pad_row] = new_state[0];
        trace[4][pad_row] = new_state[1];
        trace[5][pad_row] = new_state[2];
        trace[6][pad_row] = sibling;
        trace[7][pad_row] = dir_felt;
        trace[8][pad_row] = old_carry;
        trace[9][pad_row] = new_carry;

        // Update carries for next level
        old_carry = old_state[0];
        new_carry = new_state[0];
    }

    // Fill padding rows beyond active hash cycles
    let last_active = depth * HASH_CYCLE_LEN;
    if last_active < trace_length {
        let last_old = [
            trace[0][last_active - 1],
            trace[1][last_active - 1],
            trace[2][last_active - 1],
        ];
        let last_new = [
            trace[3][last_active - 1],
            trace[4][last_active - 1],
            trace[5][last_active - 1],
        ];
        for row in last_active..trace_length {
            trace[0][row] = last_old[0];
            trace[1][row] = last_old[1];
            trace[2][row] = last_old[2];
            trace[3][row] = last_new[0];
            trace[4][row] = last_new[1];
            trace[5][row] = last_new[2];
            trace[6][row] = BaseElement::ZERO;
            trace[7][row] = BaseElement::ZERO;
            trace[8][row] = old_carry;
            trace[9][row] = new_carry;
        }
    }

    trace
}

/// Compute both old and new roots from the shared path witness.
///
/// Convenience helper for clients and tests.
pub fn compute_update_roots(
    old_leaf: BaseElement,
    new_leaf: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
) -> (BaseElement, BaseElement) {
    let mut old_cur = old_leaf;
    let mut new_cur = new_leaf;
    for i in 0..path_elements.len() {
        let (ol, or) = if path_indices[i] == 0 {
            (old_cur, path_elements[i])
        } else {
            (path_elements[i], old_cur)
        };
        let (nl, nr) = if path_indices[i] == 0 {
            (new_cur, path_elements[i])
        } else {
            (path_elements[i], new_cur)
        };
        old_cur = poseidon::hash2(ol, or);
        new_cur = poseidon::hash2(nl, nr);
    }
    (old_cur, new_cur)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_update(
        depth: usize,
    ) -> (
        BaseElement,
        BaseElement,
        Vec<BaseElement>,
        Vec<u8>,
        BaseElement,
        BaseElement,
    ) {
        let old_leaf = BaseElement::new(42);
        let new_leaf = BaseElement::new(1337);
        let mut path_elements = Vec::new();
        let mut path_indices = Vec::new();
        for i in 0..depth {
            path_elements.push(BaseElement::new(100 + i as u64));
            path_indices.push((i % 2) as u8);
        }
        let (old_root, new_root) =
            compute_update_roots(old_leaf, new_leaf, &path_elements, &path_indices);
        (old_leaf, new_leaf, path_elements, path_indices, old_root, new_root)
    }

    #[test]
    fn test_trace_length() {
        // Always force at least one row of padding after active region so
        // wrap-around boundary constraints are satisfied.
        assert_eq!(trace_length_for_depth(1), 64);
        assert_eq!(trace_length_for_depth(7), 256);
        assert_eq!(trace_length_for_depth(8), 512);
        assert_eq!(trace_length_for_depth(9), 512);
        assert_eq!(trace_length_for_depth(15), 512);
        assert_eq!(trace_length_for_depth(16), 1024);
    }

    #[test]
    fn test_old_and_new_roots_differ() {
        let (_ol, _nl, elems, indices, old_root, new_root) = make_test_update(5);
        // Different leaves + same path ⇒ different roots (with overwhelming probability).
        assert_ne!(old_root, new_root);
        // Sanity: matches pure Poseidon chain for each leaf independently.
        let (old_alt, new_alt) = compute_update_roots(
            BaseElement::new(42),
            BaseElement::new(1337),
            &elems,
            &indices,
        );
        assert_eq!(old_alt, old_root);
        assert_eq!(new_alt, new_root);
    }

    #[test]
    fn test_same_leaf_same_root() {
        // If old_leaf == new_leaf, old_root == new_root (no-op update).
        let depth = 4;
        let path: Vec<BaseElement> = (0..depth).map(|i| BaseElement::new(50 + i)).collect();
        let idx: Vec<u8> = (0..depth).map(|i| (i % 2) as u8).collect();
        let (o, n) = compute_update_roots(BaseElement::new(7), BaseElement::new(7), &path, &idx);
        assert_eq!(o, n);
    }

    #[test]
    fn test_build_trace_outputs_match_roots() {
        let (ol, nl, elems, indices, old_root, new_root) = make_test_update(3);
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices);
        let output_row = 2 * HASH_CYCLE_LEN + NUM_ROUNDS; // last cycle's hash output
        assert_eq!(trace[0][output_row], old_root);
        assert_eq!(trace[3][output_row], new_root);
        // Carry at row 0
        assert_eq!(trace[8][0], ol);
        assert_eq!(trace[9][0], nl);
    }

    #[test]
    fn test_build_trace_shared_sibling_direction() {
        let (ol, nl, elems, indices, _o, _n) = make_test_update(3);
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices);
        for cycle in 0..3 {
            let start = cycle * HASH_CYCLE_LEN;
            let expected_sib = elems[cycle];
            let expected_dir = if indices[cycle] == 0 {
                BaseElement::ZERO
            } else {
                BaseElement::ONE
            };
            for row in start..start + HASH_CYCLE_LEN {
                assert_eq!(trace[6][row], expected_sib, "sib mismatch at row {row}");
                assert_eq!(trace[7][row], expected_dir, "dir mismatch at row {row}");
            }
        }
    }

    #[test]
    fn test_winterfell_proof_depth_3() {
        use crate::prover::{prove_generic, verify_generic};

        let (ol, nl, elems, indices, old_root, new_root) = make_test_update(3);
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices);

        let pub_inputs = MerkleUpdatePublicInputs {
            old_leaf: ol,
            new_leaf: nl,
            old_root,
            new_root,
            depth: 3,
        };

        let (proof, _) = prove_generic::<MerkleUpdateAir>(trace, pub_inputs.clone())
            .expect("Merkle update proof generation failed");
        verify_generic::<MerkleUpdateAir>(proof, pub_inputs)
            .expect("Merkle update proof verification failed");
    }

    #[test]
    fn test_winterfell_proof_depth_8() {
        use crate::prover::{prove_generic, verify_generic};

        let (ol, nl, elems, indices, old_root, new_root) = make_test_update(8);
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices);

        let pub_inputs = MerkleUpdatePublicInputs {
            old_leaf: ol,
            new_leaf: nl,
            old_root,
            new_root,
            depth: 8,
        };

        let (proof, _) = prove_generic::<MerkleUpdateAir>(trace, pub_inputs.clone())
            .expect("Depth-8 proof failed");
        verify_generic::<MerkleUpdateAir>(proof, pub_inputs)
            .expect("Depth-8 verify failed");
    }

    #[test]
    fn test_winterfell_rejects_wrong_new_root() {
        use crate::prover::{prove_generic, verify_generic};
        use std::panic;

        let (ol, nl, elems, indices, old_root, _new_root) = make_test_update(3);
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices);

        let pub_inputs = MerkleUpdatePublicInputs {
            old_leaf: ol,
            new_leaf: nl,
            old_root,
            new_root: BaseElement::new(0xdeadbeef), // tampered
            depth: 3,
        };

        // Winterfell's prover panics on assertion mismatch rather than returning Err.
        // Either panic or Err is an acceptable rejection of the tampered public input.
        let prev_hook = panic::take_hook();
        panic::set_hook(Box::new(|_| {}));
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            prove_generic::<MerkleUpdateAir>(trace, pub_inputs.clone())
        }));
        panic::set_hook(prev_hook);

        match result {
            Ok(Ok((proof, _))) => {
                let verify_result = verify_generic::<MerkleUpdateAir>(proof, pub_inputs);
                assert!(verify_result.is_err(), "verifier should reject wrong new_root");
            }
            Ok(Err(_)) | Err(_) => { /* prover returned Err or panicked — rejection */ }
        }
    }
}
