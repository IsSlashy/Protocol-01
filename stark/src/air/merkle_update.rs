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
fn trace_length_for_depth(depth: usize) -> usize {
    let active = depth * HASH_CYCLE_LEN;
    active.next_power_of_two()
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
        let tl = self.trace_length;
        let active_rows = self.depth * HASH_CYCLE_LEN;

        // Round constants (period = trace_length, repeating every 32 rows within active zone)
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

        // round_active: 1 for Poseidon round positions (0..NUM_ROUNDS) in active cycles
        let mut round_active = vec![BaseElement::ZERO; tl];
        for row in 0..active_rows {
            if row % HASH_CYCLE_LEN < NUM_ROUNDS {
                round_active[row] = BaseElement::ONE;
            }
        }

        // hash_start: 1 at the first row of each active hash cycle
        let mut hash_start = vec![BaseElement::ZERO; tl];
        for cycle in 0..self.depth {
            hash_start[cycle * HASH_CYCLE_LEN] = BaseElement::ONE;
        }

        // is_boundary: 1 at the last row of each active hash cycle (pos 31)
        let mut is_boundary = vec![BaseElement::ZERO; tl];
        for cycle in 0..self.depth {
            is_boundary[cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1] = BaseElement::ONE;
        }

        // is_interior: 1 for positions 1..=30 within each active hash cycle
        let mut is_interior = vec![BaseElement::ZERO; tl];
        for row in 0..active_rows {
            let pos = row % HASH_CYCLE_LEN;
            if pos >= 1 && pos <= NUM_ROUNDS {
                is_interior[row] = BaseElement::ONE;
            }
        }

        vec![rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        let current = frame.current();
        let next = frame.next();

        let rc0 = periodic_values[0];
        let rc1 = periodic_values[1];
        let rc2 = periodic_values[2];
        let round_active = periodic_values[3];
        let hash_start = periodic_values[4];
        let is_boundary = periodic_values[5];
        let is_interior = periodic_values[6];

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
        // OLD: state_0 = old_carry + dir * (sib - old_carry)
        //      state_1 = sib + dir * (old_carry - sib)
        // NEW: state_3 = new_carry + dir * (sib - new_carry)
        //      state_4 = sib + dir * (new_carry - sib)
        // Capacity (state_2, state_5) = 0 at hash start.
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
        // At row 31→32 (boundary), next_carry = hash output (state[0] / state[3]).
        result[12] = is_boundary * (next[8] - current[0]);
        result[13] = is_boundary * (next[9] - current[3]);

        // ── Carry continuity ──
        // Outside boundaries, carries don't change.
        result[14] = (E::ONE - is_boundary) * (next[8] - current[8]);
        result[15] = (E::ONE - is_boundary) * (next[9] - current[9]);

        // ── Sibling/direction continuity within cycle ──
        result[16] = is_interior * (next[6] - current[6]);
        result[17] = is_interior * (next[7] - current[7]);

        // ── Direction binary (at hash_start only, carried through by continuity) ──
        result[18] = hash_start * dir * (E::ONE - dir);
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
        assert_eq!(trace_length_for_depth(1), 32);
        assert_eq!(trace_length_for_depth(7), 256);
        assert_eq!(trace_length_for_depth(8), 256);
        assert_eq!(trace_length_for_depth(9), 512);
        assert_eq!(trace_length_for_depth(15), 512);
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

        let (ol, nl, elems, indices, old_root, _new_root) = make_test_update(3);
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices);

        let pub_inputs = MerkleUpdatePublicInputs {
            old_leaf: ol,
            new_leaf: nl,
            old_root,
            new_root: BaseElement::new(0xdeadbeef), // tampered
            depth: 3,
        };

        // Prover may succeed (trace is honest) but verifier must reject on assertion mismatch.
        // OR prover may fail at assertion-commitment stage — either outcome is acceptable.
        let prove_result = prove_generic::<MerkleUpdateAir>(trace, pub_inputs.clone());
        match prove_result {
            Ok((proof, _)) => {
                let verify_result = verify_generic::<MerkleUpdateAir>(proof, pub_inputs);
                assert!(verify_result.is_err(), "verifier should reject wrong new_root");
            }
            Err(_) => { /* prover panicked/errored — also acceptable */ }
        }
    }
}
