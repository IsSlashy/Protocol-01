//! Merkle Path STARK AIR
//!
//! Proves that a leaf exists in a Merkle tree with a given root.
//! Uses Poseidon hash2 (t=3) at each level.
//!
//! Trace layout (width = 6, length = next_pow2(DEPTH * 32)):
//!   col 0-2: Poseidon state (s0, s1, s2)
//!   col 3:   sibling (path element at this Merkle level)
//!   col 4:   direction (0 = leaf on left, 1 = leaf on right)
//!   col 5:   carry (previous hash output; leaf for first cycle)
//!
//! Each Merkle level is one 32-row hash cycle:
//!   Rows 0-29:  Poseidon rounds (state transitions)
//!   Rows 30-31: Padding (identity)
//!
//! Chaining between levels uses the carry column:
//!   carry[cycle N] = hash_output[cycle N-1]  (or leaf for cycle 0)
//!   state at hash start = mux(direction, carry, sibling)
//!
//! Public inputs: leaf, root
//! Private inputs: path_elements[DEPTH], path_indices[DEPTH]

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

pub const TRACE_WIDTH: usize = 6;
pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;
/// Canonical Merkle depth used for the on-chain DEEP-ALI verifier
/// (matches CONFIG_MERKLE_PATH in p01_stark_verifier).
pub const CANONICAL_DEPTH: usize = 15;
/// Canonical trace length for C3 (15 * 32 = 480, next power of 2 = 512).
pub const TRACE_LENGTH: usize = 512;
/// Number of transition constraints in C3 (merkle_path).
pub const MERKLE_PATH_NUM_CONSTRAINTS: usize = 11;
/// Number of periodic columns in C3 (merkle_path).
pub const MERKLE_PATH_NUM_PERIODIC: usize = 7;

/// Compute trace length for a given Merkle depth.
pub fn trace_length_for_depth(depth: usize) -> usize {
    let active = depth * HASH_CYCLE_LEN;
    active.next_power_of_two()
}

// ============================================================================
// Public inputs
// ============================================================================

#[derive(Clone, Debug)]
pub struct MerklePathPublicInputs {
    pub leaf: BaseElement,
    pub root: BaseElement,
    pub depth: usize,
}

impl ToElements<BaseElement> for MerklePathPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![self.leaf, self.root, BaseElement::new(self.depth as u64)]
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct MerklePathAir {
    context: AirContext<BaseElement>,
    leaf: BaseElement,
    root: BaseElement,
    depth: usize,
    trace_length: usize,
}

impl Air for MerklePathAir {
    type BaseField = BaseElement;
    type PublicInputs = MerklePathPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        let trace_length = trace_info.length();

        // Constraint degrees:
        // [0-2] Poseidon round: degree 7, periodic cycle = trace_length
        // [3-4] Hash start mux: degree 2, periodic cycle = trace_length
        // [5]   Hash start capacity: degree 1, periodic cycle = trace_length
        // [6]   Carry update at boundary: degree 1, periodic cycle = trace_length
        // [7]   Carry continuity: degree 1, periodic cycle = trace_length
        // [8-9] Sibling/direction continuity: degree 1, periodic cycle = trace_length
        // [10]  Direction binary: degree 2, periodic cycle = trace_length
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]),  // 0: poseidon s0
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]),  // 1: poseidon s1
            TransitionConstraintDegree::with_cycles(7, vec![trace_length, trace_length]),  // 2: poseidon s2
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),  // 3: mux s0
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),  // 4: mux s1
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),  // 5: capacity
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),  // 6: carry update
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),  // 7: carry cont.
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),  // 8: sib cont.
            TransitionConstraintDegree::with_cycles(1, vec![trace_length]),  // 9: dir cont.
            TransitionConstraintDegree::with_cycles(2, vec![trace_length]),  // 10: dir binary
        ];

        // Assertions: leaf carry at row 0, root output at last hash output row
        let num_assertions = 2;
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            leaf: pub_inputs.leaf,
            root: pub_inputs.root,
            depth: pub_inputs.depth,
            trace_length,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_merkle_path_periodic_columns(self.depth, self.trace_length)
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_merkle_path_transition(frame.current(), frame.next(), periodic_values, result);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        let output_row = (self.depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS;
        vec![
            // Carry at row 0 = leaf
            Assertion::single(5, 0, self.leaf),
            // Hash output of last cycle = root
            Assertion::single(0, output_row, self.root),
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
// [P2.2d-C3] Standalone periodic / transition functions — shared between the
// winterfell AIR trait and the compact-proof DEEP-ALI pipeline. Any change to
// these functions MUST be mirrored in `compute_quotient_lde_circuit_3`
// (stark/src/compact.rs) and `evaluate_transition_at_ood_circuit_3`
// (programs/p01_stark_verifier/src/verify.rs). Locked by parity tests.
// ============================================================================

/// Build the 7 periodic columns for merkle_path at a given depth + trace length.
/// Layout: [rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior].
pub fn build_merkle_path_periodic_columns(
    depth: usize,
    trace_length: usize,
) -> Vec<Vec<BaseElement>> {
    let active_rows = depth * HASH_CYCLE_LEN;

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mut rc0 = vec![BaseElement::ZERO; trace_length];
    let mut rc1 = vec![BaseElement::ZERO; trace_length];
    let mut rc2 = vec![BaseElement::ZERO; trace_length];
    for row in 0..active_rows {
        let pos_in_cycle = row % HASH_CYCLE_LEN;
        if pos_in_cycle < NUM_ROUNDS {
            rc0[row] = rc[pos_in_cycle * 3];
            rc1[row] = rc[pos_in_cycle * 3 + 1];
            rc2[row] = rc[pos_in_cycle * 3 + 2];
        }
    }

    let mut round_active = vec![BaseElement::ZERO; trace_length];
    for row in 0..active_rows {
        if row % HASH_CYCLE_LEN < NUM_ROUNDS {
            round_active[row] = BaseElement::ONE;
        }
    }

    let mut hash_start = vec![BaseElement::ZERO; trace_length];
    for cycle in 0..depth {
        hash_start[cycle * HASH_CYCLE_LEN] = BaseElement::ONE;
    }

    let mut is_boundary = vec![BaseElement::ZERO; trace_length];
    for cycle in 0..depth {
        is_boundary[cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1] = BaseElement::ONE;
    }

    let mut is_interior = vec![BaseElement::ZERO; trace_length];
    for row in 0..active_rows {
        let pos = row % HASH_CYCLE_LEN;
        if pos >= 1 && pos <= NUM_ROUNDS {
            is_interior[row] = BaseElement::ONE;
        }
    }

    vec![rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]
}

/// Evaluate the 11 transition constraints for merkle_path at `current/next`.
///
/// `periodic[0..7]`: [rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]
/// `result[0..11]`: [pos_s0, pos_s1, pos_s2, mux_s0, mux_s1, capacity,
///                   carry_update, carry_cont, sib_cont, dir_cont, dir_binary]
pub fn evaluate_merkle_path_transition<E: FieldElement>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), TRACE_WIDTH);
    debug_assert_eq!(next.len(), TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), MERKLE_PATH_NUM_PERIODIC);
    debug_assert_eq!(result.len(), MERKLE_PATH_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_active = periodic[3];
    let hash_start = periodic[4];
    let is_boundary = periodic[5];
    let is_interior = periodic[6];

    // ── Poseidon round ──
    let s0 = current[0] + rc0;
    let s1 = current[1] + rc1;
    let s2 = current[2] + rc2;
    let s0_7 = pow7(s0);
    let s1_7 = pow7(s1);
    let s2_7 = pow7(s2);
    let three = E::from(3u32);
    let ro0 = three * s0_7 + s1_7 + s2_7;
    let ro1 = s0_7 + three * s1_7 + s2_7;
    let ro2 = s0_7 + s1_7 + three * s2_7;

    let not_boundary = E::ONE - is_boundary;
    result[0] = not_boundary * (next[0] - current[0] - round_active * (ro0 - current[0]));
    result[1] = not_boundary * (next[1] - current[1] - round_active * (ro1 - current[1]));
    result[2] = not_boundary * (next[2] - current[2] - round_active * (ro2 - current[2]));

    // ── Hash start: state = mux(direction, carry, sibling) ──
    let dir = current[4];
    let sib = current[3];
    let carry = current[5];
    result[3] = hash_start * (current[0] - carry - dir * (sib - carry));
    result[4] = hash_start * (current[1] - sib - dir * (carry - sib));
    result[5] = hash_start * current[2];

    // ── Carry update at boundary ──
    result[6] = is_boundary * (next[5] - current[0]);

    // ── Carry continuity ──
    result[7] = (E::ONE - is_boundary) * (next[5] - current[5]);

    // ── Sibling/direction continuity within cycle ──
    result[8] = is_interior * (next[3] - current[3]);
    result[9] = is_interior * (next[4] - current[4]);

    // ── Direction binary ──
    result[10] = hash_start * dir * (E::ONE - dir);
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build the execution trace for a Merkle path proof.
pub fn build_merkle_trace(
    leaf: BaseElement,
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

    let mut carry = leaf;

    for level in 0..depth {
        let cycle_start = level * HASH_CYCLE_LEN;
        let sibling = path_elements[level];
        let dir = path_indices[level];
        let dir_felt = if dir == 0 { BaseElement::ZERO } else { BaseElement::ONE };

        // Determine hash inputs
        let (left, right) = if dir == 0 {
            (carry, sibling)
        } else {
            (sibling, carry)
        };

        // Initial state
        let mut state = [left, right, BaseElement::ZERO];

        // Write row 0
        trace[0][cycle_start] = state[0];
        trace[1][cycle_start] = state[1];
        trace[2][cycle_start] = state[2];
        trace[3][cycle_start] = sibling;
        trace[4][cycle_start] = dir_felt;
        trace[5][cycle_start] = carry;

        // Poseidon rounds 0..29
        for round in 0..NUM_ROUNDS {
            // Add round constants
            state[0] = state[0] + rc[round * 3];
            state[1] = state[1] + rc[round * 3 + 1];
            state[2] = state[2] + rc[round * 3 + 2];

            // Full S-box
            for s in &mut state {
                let x = *s;
                let x2 = x * x;
                let x4 = x2 * x2;
                *s = x4 * x2 * x;
            }

            // MDS
            let mut result = [BaseElement::ZERO; 3];
            for i in 0..3 {
                for j in 0..3 {
                    result[i] = result[i] + mds[i][j] * state[j];
                }
            }
            state = result;

            let row = cycle_start + round + 1;
            trace[0][row] = state[0];
            trace[1][row] = state[1];
            trace[2][row] = state[2];
            trace[3][row] = sibling;
            trace[4][row] = dir_felt;
            trace[5][row] = carry;
        }

        // Padding row 31 (copy of row 30)
        let pad_row = cycle_start + NUM_ROUNDS + 1;
        trace[0][pad_row] = state[0];
        trace[1][pad_row] = state[1];
        trace[2][pad_row] = state[2];
        trace[3][pad_row] = sibling;
        trace[4][pad_row] = dir_felt;
        trace[5][pad_row] = carry;

        // Update carry for next level
        carry = state[0];
    }

    // Fill padding rows beyond active hash cycles
    let last_active = depth * HASH_CYCLE_LEN;
    if last_active < trace_length {
        let last_state = [
            trace[0][last_active - 1],
            trace[1][last_active - 1],
            trace[2][last_active - 1],
        ];
        for row in last_active..trace_length {
            trace[0][row] = last_state[0];
            trace[1][row] = last_state[1];
            trace[2][row] = last_state[2];
            trace[3][row] = BaseElement::ZERO;
            trace[4][row] = BaseElement::ZERO;
            trace[5][row] = carry;
        }
    }

    trace
}

/// Compute the Merkle root from a leaf and path.
pub fn compute_merkle_root(
    leaf: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
) -> BaseElement {
    let mut current = leaf;
    for i in 0..path_elements.len() {
        let (left, right) = if path_indices[i] == 0 {
            (current, path_elements[i])
        } else {
            (path_elements[i], current)
        };
        current = poseidon::hash2(left, right);
    }
    current
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_tree(depth: usize) -> (BaseElement, Vec<BaseElement>, Vec<u8>, BaseElement) {
        // Create a simple Merkle tree with known values
        let leaf = BaseElement::new(42);
        let mut path_elements = Vec::new();
        let mut path_indices = Vec::new();

        for i in 0..depth {
            path_elements.push(BaseElement::new(100 + i as u64));
            path_indices.push((i % 2) as u8);
        }

        let root = compute_merkle_root(leaf, &path_elements, &path_indices);
        (leaf, path_elements, path_indices, root)
    }

    #[test]
    fn test_trace_length() {
        assert_eq!(trace_length_for_depth(15), 512);
        assert_eq!(trace_length_for_depth(16), 512);
        assert_eq!(trace_length_for_depth(17), 1024);
        assert_eq!(trace_length_for_depth(1), 32);
    }

    #[test]
    fn test_compute_merkle_root_deterministic() {
        let (leaf, elems, indices, root1) = make_test_tree(15);
        let root2 = compute_merkle_root(leaf, &elems, &indices);
        assert_eq!(root1, root2);
    }

    #[test]
    fn test_build_trace_output_matches_root() {
        let (leaf, elems, indices, root) = make_test_tree(15);
        let trace = build_merkle_trace(leaf, &elems, &indices);

        // Hash output of last cycle
        let output_row = 14 * HASH_CYCLE_LEN + NUM_ROUNDS; // row 478
        assert_eq!(trace[0][output_row], root);
    }

    #[test]
    fn test_build_trace_carry_column() {
        let (leaf, elems, indices, _root) = make_test_tree(3);
        let trace = build_merkle_trace(leaf, &elems, &indices);

        // Carry at row 0 = leaf
        assert_eq!(trace[5][0], leaf);

        // Carry at row 32 = output of cycle 0
        let output_0 = trace[0][NUM_ROUNDS]; // row 30
        assert_eq!(trace[5][32], output_0);

        // Carry at row 64 = output of cycle 1
        let output_1 = trace[0][32 + NUM_ROUNDS]; // row 62
        assert_eq!(trace[5][64], output_1);
    }

    #[test]
    fn test_build_trace_direction_column() {
        let (leaf, elems, indices, _root) = make_test_tree(3);
        let trace = build_merkle_trace(leaf, &elems, &indices);

        for cycle in 0..3 {
            let start = cycle * HASH_CYCLE_LEN;
            let expected_dir = if indices[cycle] == 0 {
                BaseElement::ZERO
            } else {
                BaseElement::ONE
            };
            // Direction constant within cycle
            for row in start..start + HASH_CYCLE_LEN {
                assert_eq!(trace[4][row], expected_dir, "dir mismatch at row {}", row);
            }
        }
    }

    #[test]
    fn test_build_trace_hash_start_state() {
        let (leaf, elems, indices, _root) = make_test_tree(3);
        let trace = build_merkle_trace(leaf, &elems, &indices);

        // Cycle 0: state = mux(dir, leaf, sibling)
        let dir0 = indices[0];
        let (left0, right0) = if dir0 == 0 {
            (leaf, elems[0])
        } else {
            (elems[0], leaf)
        };
        assert_eq!(trace[0][0], left0);
        assert_eq!(trace[1][0], right0);
        assert_eq!(trace[2][0], BaseElement::ZERO);
    }

    #[test]
    fn test_trace_padding_rows() {
        let (leaf, elems, indices, _root) = make_test_tree(3);
        let trace = build_merkle_trace(leaf, &elems, &indices);

        let trace_length = trace[0].len();
        let active_rows = 3 * HASH_CYCLE_LEN; // 96

        // Padding rows should have identity transitions
        for row in active_rows..trace_length - 1 {
            assert_eq!(trace[0][row], trace[0][row + 1], "padding not identity at row {}", row);
        }
    }

    #[test]
    fn test_different_paths_different_roots() {
        let leaf = BaseElement::new(42);
        let elems = vec![BaseElement::new(100); 3];

        let root_a = compute_merkle_root(leaf, &elems, &[0, 0, 0]);
        let root_b = compute_merkle_root(leaf, &elems, &[1, 0, 0]);
        assert_ne!(root_a, root_b);
    }

    #[test]
    fn test_winterfell_proof_depth_3() {
        use crate::prover::{prove_generic, verify_generic};

        let (leaf, elems, indices, root) = make_test_tree(3);
        let trace = build_merkle_trace(leaf, &elems, &indices);

        let pub_inputs = MerklePathPublicInputs { leaf, root, depth: 3 };

        let (proof, _) = prove_generic::<MerklePathAir>(trace, pub_inputs.clone())
            .expect("Merkle path proof generation failed");

        verify_generic::<MerklePathAir>(proof, pub_inputs)
            .expect("Merkle path proof verification failed");
    }

    #[test]
    fn test_winterfell_proof_depth_15() {
        use crate::prover::{prove_generic, verify_generic};

        let (leaf, elems, indices, root) = make_test_tree(15);
        let trace = build_merkle_trace(leaf, &elems, &indices);

        let pub_inputs = MerklePathPublicInputs { leaf, root, depth: 15 };

        let (proof, _) = prove_generic::<MerklePathAir>(trace, pub_inputs.clone())
            .expect("Depth-15 proof failed");

        verify_generic::<MerklePathAir>(proof, pub_inputs)
            .expect("Depth-15 verify failed");
    }
}
