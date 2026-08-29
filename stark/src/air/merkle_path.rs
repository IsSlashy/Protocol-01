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

/// The depth C3 proves in-circuit.
///
/// CHANGED 15 -> 12 on 2026-08-29, for the same reason C6 and C7 were cut: the
/// blinding region needs more free rows than the wire publishes openings, and at
/// depth 15 there were 32 free rows against `R = 4*22 + 2 = 90`.
///
/// The pool tree is STILL depth 15. C3 proves membership in a 12-level SUBTREE
/// and the spending instruction walks the remaining levels.
///
/// ✅ AND FOR C3 THAT WALK ALREADY EXISTS. `state::spend_root::resolve_pool_root`
/// was written for C7, which has exactly this shape: it takes the subtree root,
/// walks caller-supplied siblings, and the caller then requires the result to be
/// a root the pool ALREADY KNOWS. Caller-supplied siblings are safe here because
/// C3 READS -- a forged sibling yields a root in no history and the spend fails.
///
/// ⛔ DO NOT REACH FOR `state::insert_root::fold_insertion` INSTEAD. That one is
/// the write-side twin, built for C6, and it reads the pool's own
/// `filled_subtrees` because an insertion produces a root no history can check.
/// The two are not interchangeable in either direction.
pub const CANONICAL_DEPTH: usize = 12;

/// Canonical trace length for C3.
///
/// `trace_length_for_depth(12) = next_pow2(384) = 512`, IDENTICAL to what depth
/// 15 gave (`next_pow2(480) = 512`). So `n`, `deg(Q)`, `quotient_segments` and
/// rho all stay put and the wire does not grow by one byte -- the same free
/// trade C6 measured at 81,037 bytes before and after.
pub const TRACE_LENGTH: usize = 512;

/// First cycle carrying no witness, existing only to be blinded.
pub const FIRST_FREE_CYCLE: usize = CANONICAL_DEPTH; // 12

/// First trace row free on every one of the six columns.
pub const FIRST_FREE_ROW: usize = FIRST_FREE_CYCLE * HASH_CYCLE_LEN; // 384

/// Blinding positions per column.
///
/// ```text
///   MASK_ROWS = 512 - 384 = 128
///   R         = 4 * MERKLE_PATH_NUM_QUERIES + 2 = 4*22 + 2 = 90
///   128 > 90, margin 38.
///
///   depth 15 -> 32  < 90   <- before this change: NOT zero-knowledge
///   depth 13 -> 96  > 90   margin 6, one query bump kills it
///   depth 12 -> 128 > 90   margin 38   <- chosen
/// ```
///
/// 🚨 THE OLD TAIL WAS NOT FREE, IT WAS FORCED, and that is why the depth had to
/// move at all. With the periodic flags at zero the Poseidon constraints
/// degenerate to `next[i] - current[i] = 0`, which PINS each column constant
/// across the tail: one degree of freedom per column, not 32. That is what
/// `stark/tests/air_aware_recovery_c3.rs` exploits to recover the path and the
/// leaf index from 90 published openings.
pub const MASK_ROWS: usize = TRACE_LENGTH - FIRST_FREE_ROW; // 128

/// Number of transition constraints in C3 (merkle_path).
pub const MERKLE_PATH_NUM_CONSTRAINTS: usize = 11;

/// 7 -> 9 on 2026-08-29. Appended: [7] `active`, [8] `not_boundary_active`.
/// ORDER IS FROZEN - the RLC uses `alpha^i` and the coefficient emitter indexes
/// positionally. Append only, never insert.
pub const MERKLE_PATH_NUM_PERIODIC: usize = 9;

/// Compute trace length for a given Merkle depth.
pub fn trace_length_for_depth(depth: usize) -> usize {
    let active = depth * HASH_CYCLE_LEN;
    active.next_power_of_two()
}

/// Mask elements `build_merkle_trace` requires at `depth`. Kept depth-generic so
/// the shallow-depth tests in this file keep compiling.
pub fn mask_len_for_depth(depth: usize) -> usize {
    (trace_length_for_depth(depth) - depth * HASH_CYCLE_LEN) * TRACE_WIDTH
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
/// Build the 9 periodic column value vectors for a circuit-3 trace.
///
/// Layout, FROZEN:
/// ```text
///   0 rc0                  32-periodic
///   1 rc1                  32-periodic
///   2 rc2                  32-periodic
///   3 round_active         32-periodic  (1 on pos 0..=29)
///   4 hash_start           32-periodic  (1 on pos 0)
///   5 is_boundary          32-periodic  (1 on pos 31)
///   6 is_interior          32-periodic  (1 on pos 1..=30)
///   7 active               DENSE, 1 on rows 0..=first_free_row-2   APPENDED
///   8 not_boundary_active  DENSE, active AND not_boundary          APPENDED
/// ```
///
/// COLUMNS 0-6 ARE NO LONGER DEPTH-BOUNDED. They tile the whole trace, and rows
/// at or past `first_free_row` are switched off by [7]/[8] instead.
///
/// ✅ THAT CHANGE IS WHAT MAKES THE RODATA COST ZERO, and it is not cosmetic. A
/// depth-bounded `rc0` at depth 12 is zero across four truncated cycles, so its
/// interpolant is DENSE: 4,096 bytes of on-chain rodata per column, seven times
/// over. Fully periodic they interpolate to stride-16 polynomials that are
/// byte-identical to C6's and C7's, so the verifier shares one table set and C3
/// adds none. C6 measured this: its phase 1 got 3,857 CU CHEAPER, because the
/// Lagrange correction over the truncated tail disappeared with the truncation.
///
/// On rows `0..first_free_row` the new construction equals the old one value for
/// value, so no witness row changes meaning.
pub fn build_merkle_path_periodic_columns(
    depth: usize,
    trace_length: usize,
) -> Vec<Vec<BaseElement>> {
    let tl = trace_length;
    let first_free_row = depth * HASH_CYCLE_LEN;
    assert!(
        first_free_row < tl,
        "C3 depth {depth} leaves no free row in a {tl}-row trace",
    );

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mut rc0 = vec![BaseElement::ZERO; tl];
    let mut rc1 = vec![BaseElement::ZERO; tl];
    let mut rc2 = vec![BaseElement::ZERO; tl];
    let mut round_active = vec![BaseElement::ZERO; tl];
    let mut hash_start = vec![BaseElement::ZERO; tl];
    let mut is_boundary = vec![BaseElement::ZERO; tl];
    let mut is_interior = vec![BaseElement::ZERO; tl];

    for row in 0..tl {
        let pos = row % HASH_CYCLE_LEN;
        if pos < NUM_ROUNDS {
            rc0[row] = rc[pos * 3];
            rc1[row] = rc[pos * 3 + 1];
            rc2[row] = rc[pos * 3 + 2];
            round_active[row] = BaseElement::ONE;
        }
        if pos == 0 {
            hash_start[row] = BaseElement::ONE;
        }
        // pos 31 includes row 511: that transition is exempt (the single
        // transition exemption) and killed by the (x - g^{n-1}) factor in the
        // quotient. Including it is what keeps this column 32-periodic, which is
        // the whole point.
        if pos == HASH_CYCLE_LEN - 1 {
            is_boundary[row] = BaseElement::ONE;
        }
        if pos >= 1 && pos <= NUM_ROUNDS {
            is_interior[row] = BaseElement::ONE;
        }
    }

    // -- APPENDED 2026-08-29: the two gates that make C3 zero-knowledge --
    //
    // `not_boundary_active` is `active` pre-multiplied with `not_boundary`. It
    // is a SEPARATE COLUMN rather than a product formed in the constraint body
    // ON PURPOSE: the degree-7 Poseidon constraints may carry exactly TWO
    // periodic factors. A third makes degree_bound = 7 + 3 - 1 = 9, whose
    // next_power_of_two is 16, so ce_blowup_factor goes 8 -> 16 and the whole
    // proof structure changes with it.
    //
    // THE BOUND IS `first_free_row - 1`, NOT `first_free_row`.
    //
    // These are TRANSITION constraints: the one at row i reads row i+1. Row 383
    // is a cycle boundary (11*32+31), so is_boundary[383] = 1 and the carry
    // update `result[6] = is_boundary * (next[5] - current[0])` fires there --
    // demanding that a masked row equal the running hash, which is
    // unsatisfiable with fresh randomness, and which would republish that hash
    // inside the blinding region if it were satisfied. Stopping one row early
    // makes the 383 -> 384 transition entirely free.
    let mut active = vec![BaseElement::ZERO; tl];
    let mut not_boundary_active = vec![BaseElement::ZERO; tl];
    for row in 0..(first_free_row - 1) {
        active[row] = BaseElement::ONE;
        if row % HASH_CYCLE_LEN != HASH_CYCLE_LEN - 1 {
            not_boundary_active[row] = BaseElement::ONE;
        }
    }

    vec![
        rc0,                 // 0
        rc1,                 // 1
        rc2,                 // 2
        round_active,        // 3
        hash_start,          // 4
        is_boundary,         // 5
        is_interior,         // 6
        active,              // 7  APPENDED
        not_boundary_active, // 8  APPENDED
    ]
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
    let active = periodic[7];
    let nba = periodic[8];

    // Every gate below is pre-multiplied by `active` exactly once, and the
    // Poseidon rows use `nba` rather than `1 - is_boundary`.
    //
    // 🚨 `not_boundary` IS GONE FROM THIS FUNCTION, AND `E::ONE - is_boundary`
    // MUST NOT COME BACK ANYWHERE BELOW. The two agree on every row of the walk
    // and differ only across rows 384..511 -- so the substitution rejects NO
    // honest proof, passes every existing test, and silently re-imposes the
    // Poseidon rounds on the 128 blinding rows. That is the exact state
    // `stark/tests/air_aware_recovery_c3.rs` recovers the path and the leaf
    // index from.
    //
    // ⚠️ COUNT THE PERIODIC FACTORS BEFORE EDITING. Each line carries AT MOST
    // TWO. `result[0..3]` spend theirs on `nba` and `round_active` over a
    // degree-7 body; a third factor takes ce_blowup_factor from 8 to 16 and
    // changes the proof structure.
    let hash_start_a = hash_start * active;
    let is_boundary_a = is_boundary * active;
    let is_interior_a = is_interior * active;

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

    result[0] = nba * (next[0] - current[0] - round_active * (ro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - round_active * (ro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - round_active * (ro2 - current[2]));

    // ── Hash start: state = mux(direction, carry, sibling) ──
    let dir = current[4];
    let sib = current[3];
    let carry = current[5];
    result[3] = hash_start_a * (current[0] - carry - dir * (sib - carry));
    result[4] = hash_start_a * (current[1] - sib - dir * (carry - sib));
    result[5] = hash_start_a * current[2];

    // ── Carry update at boundary ──
    result[6] = is_boundary_a * (next[5] - current[0]);

    // ── Carry continuity ──
    result[7] = nba * (next[5] - current[5]);

    // ── Sibling/direction continuity within cycle ──
    result[8] = is_interior_a * (next[3] - current[3]);
    result[9] = is_interior_a * (next[4] - current[4]);

    // ── Direction binary ──
    result[10] = hash_start_a * dir * (E::ONE - dir);
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build the execution trace for a Merkle path proof.
///
/// `mask` supplies the blinding region: `mask_len_for_depth(depth)` elements
/// laid out ROW-MAJOR as `i * TRACE_WIDTH + col`. At the canonical depth that is
/// `MASK_ROWS * TRACE_WIDTH = 128 * 6 = 768`.
///
/// ⛔ IT IS A REQUIRED ARGUMENT AND NOT AN `Option` ON PURPOSE. A default would
/// be a zero-filled or witness-derived mask, which is exactly the failure this
/// design exists to prevent, and a caller who has not thought about randomness
/// should not compile.
///
/// It MUST be fresh CSPRNG output, redrawn for every proof. Two C3 proofs over
/// the same path with the same mask publish the same bytes, which re-links
/// precisely what the mask exists to unlink.
pub fn build_merkle_trace(
    leaf: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
    mask: &[BaseElement],
) -> Vec<Vec<BaseElement>> {
    let depth = path_elements.len();
    assert_eq!(depth, path_indices.len());
    assert!(depth > 0);

    let trace_length = trace_length_for_depth(depth);
    assert_eq!(
        mask.len(),
        mask_len_for_depth(depth),
        "C3 at depth {depth} needs {} blinding elements ({} rows x {TRACE_WIDTH} columns), got {}",
        mask_len_for_depth(depth),
        trace_length - depth * HASH_CYCLE_LEN,
        mask.len(),
    );
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

    // -- THE BLINDING REGION, 2026-08-29 --
    //
    // 🚨 WHAT THIS REPLACES IS THE ENTIRE DEFECT. The old body copied the last
    // Poseidon state across every padding row and held `carry` constant. Those
    // rows looked free and were not: they were a FUNCTION of the witness, and
    // each column contributed ONE unknown across the whole tail instead of one
    // per row. `air_aware_recovery_c3.rs` turns exactly that into a linear
    // system with 15 unknowns against 90 published openings and solves it for
    // the path and the leaf index.
    //
    // Fresh uniform values make each of the 128 rows its own unknown, so the
    // count goes the other way: 128 * 6 unknowns against 90 openings per column.
    let last_active = depth * HASH_CYCLE_LEN;
    for row in last_active..trace_length {
        let base = (row - last_active) * TRACE_WIDTH;
        for col in 0..TRACE_WIDTH {
            trace[col][row] = mask[base + col];
        }
    }

    // `carry` is consumed by the walk above; the tail no longer holds it.
    let _ = carry;

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


/// A deterministic mask for the tests in this file.
///
/// Adequate for exercising the TRACE SHAPE, and inadequate for any secrecy
/// claim: the blinding region only hides if its values are unpredictable. The
/// shipping path draws from `getrandom` inside the wasm entry and refuses to
/// build without a CSPRNG.
#[cfg(test)]
fn deterministic_test_mask(depth: usize) -> Vec<BaseElement> {
    let mut z: u64 = 0xC3_5EED_0000 ^ ((depth as u64) << 32) | 1;
    (0..mask_len_for_depth(depth))
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            BaseElement::new(z % 0xFFFF_FFFF_0000_0001)
        })
        .collect()
}

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
        let trace = build_merkle_trace(leaf, &elems, &indices, &deterministic_test_mask(elems.len()));

        // Hash output of last cycle
        let output_row = 14 * HASH_CYCLE_LEN + NUM_ROUNDS; // row 478
        assert_eq!(trace[0][output_row], root);
    }

    #[test]
    fn test_build_trace_carry_column() {
        let (leaf, elems, indices, _root) = make_test_tree(3);
        let trace = build_merkle_trace(leaf, &elems, &indices, &deterministic_test_mask(elems.len()));

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
        let trace = build_merkle_trace(leaf, &elems, &indices, &deterministic_test_mask(elems.len()));

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
        let trace = build_merkle_trace(leaf, &elems, &indices, &deterministic_test_mask(elems.len()));

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

    /// INVERTED 2026-08-29. It used to demand `trace[0][row] == trace[0][row+1]`
    /// across the tail and it passed, which is what the defect looked like from
    /// the inside.
    ///
    /// Identity transitions are exactly what made the tail recoverable. Each
    /// column contributed ONE unknown across all 128 rows instead of one per
    /// row, so `air_aware_recovery_c3.rs` could close a linear system with 15
    /// unknowns against 90 published openings and read the path and the leaf
    /// index straight out of it.
    ///
    /// The rows must now be INDEPENDENT. This asserts the thing the old test
    /// forbade.
    #[test]
    fn the_tail_is_no_longer_identity_because_identity_was_the_leak() {
        let (leaf, elems, indices, _root) = make_test_tree(3);
        let mask = deterministic_test_mask(elems.len());
        let trace = build_merkle_trace(leaf, &elems, &indices, &mask);

        let trace_length = trace[0].len();
        let active_rows = 3 * HASH_CYCLE_LEN; // 96
        assert!(active_rows < trace_length, "this witness must leave a tail");

        // Every masked cell is the mask, laid out row-major. Written as an
        // equality against `mask` rather than a "not equal to the neighbour"
        // check: the latter would pass on any garbage, including a mask that
        // was dropped and replaced by a counter.
        for row in active_rows..trace_length {
            let base = (row - active_rows) * TRACE_WIDTH;
            for col in 0..TRACE_WIDTH {
                assert_eq!(
                    trace[col][row], mask[base + col],
                    "blinding cell ({row}, {col}) is not the mask element it was handed",
                );
            }
        }

        // And the identity the old test demanded must NOT hold, or the mask is
        // constant and hides nothing.
        let identical = (active_rows..trace_length - 1)
            .filter(|&row| trace[0][row] == trace[0][row + 1])
            .count();
        assert_eq!(
            identical, 0,
            "{identical} tail rows still repeat their predecessor: that is the pinned tail the              depth cut was supposed to remove",
        );
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
        let trace = build_merkle_trace(leaf, &elems, &indices, &deterministic_test_mask(elems.len()));

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
        let trace = build_merkle_trace(leaf, &elems, &indices, &deterministic_test_mask(elems.len()));

        let pub_inputs = MerklePathPublicInputs { leaf, root, depth: 15 };

        let (proof, _) = prove_generic::<MerklePathAir>(trace, pub_inputs.clone())
            .expect("Depth-15 proof failed");

        verify_generic::<MerklePathAir>(proof, pub_inputs)
            .expect("Depth-15 verify failed");
    }
}
