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
pub const HASH_CYCLE_LEN: usize = 32;
const NUM_ROUNDS: usize = 30;

/// Compute trace length for a given Merkle depth.
///
/// We force `trace_length > active_rows` so that the boundary transition
/// constraint at the last active row does not wrap around to row 0.
pub fn trace_length_for_depth(depth: usize) -> usize {
    let active = depth * HASH_CYCLE_LEN;
    (active + 1).next_power_of_two()
}

/// The depth C6 proves in-circuit.
///
/// CHANGED 15 -> 12 on 2026-08-29. The pool tree is STILL depth 15; the
/// remaining three levels are folded on chain by the deposit instruction
/// against the POOL ACCOUNT's `filled_subtrees`. NEVER the caller-supplied
/// `new_subtrees`: `verify_c6_proof_buffer` hashes exactly 40 bytes, so
/// `new_subtrees` is UNATTESTED and any depositor can write into it. That read
/// is a fund-loss shape, not a style choice.
///
/// Unlike C7 and C3, `filled_subtrees` IS the right source here: C6 proves an
/// INSERTION, and an insertion is always at the frontier.
pub const CANONICAL_DEPTH: usize = 12;

/// `trace_length_for_depth(12) = next_pow2(384+1) = 512`, IDENTICAL to what
/// depth 15 gave. So `n`, `deg(Q)`, `quotient_segments = 8` and rho all stay
/// put, and the wire does not grow by one byte.
pub const CANONICAL_TRACE_LENGTH: usize = 512;

/// First cycle carrying no witness, existing only to be blinded.
pub const FIRST_FREE_CYCLE: usize = CANONICAL_DEPTH; // 12

/// First trace row free on every one of the ten columns.
pub const FIRST_FREE_ROW: usize = FIRST_FREE_CYCLE * HASH_CYCLE_LEN; // 384

/// Blinding positions per column.
///
/// ```text
///   MASK_ROWS = 512 - 384 = 128
///   R         = 4 * MERKLE_UPDATE_NUM_QUERIES + 2 = 4*22 + 2 = 90
///   128 > 90, margin 38.
///
///   depth 15 -> 32  < 90   <- before this change: NOT zero-knowledge
///   depth 14 -> 64  < 90
///   depth 13 -> 96  > 90   margin 6, one query bump kills it
///   depth 12 -> 128 > 90   margin 38   <- chosen
/// ```
pub const MASK_ROWS: usize = CANONICAL_TRACE_LENGTH - FIRST_FREE_ROW; // 128

/// Mask elements `build_merkle_update_trace` requires at `depth`. Kept
/// depth-generic so the shallow-depth tests in this file keep compiling.
pub fn mask_len_for_depth(depth: usize) -> usize {
    (trace_length_for_depth(depth) - depth * HASH_CYCLE_LEN) * TRACE_WIDTH
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
/// 7 -> 9 on 2026-08-29. Appended: [7] `active`, [8] `not_boundary_active`.
/// ORDER IS FROZEN - the RLC uses `alpha^i` and the coefficient emitter indexes
/// positionally. Append only, never insert.
pub const MERKLE_UPDATE_NUM_PERIODIC: usize = 9;

/// Build the 9 periodic column value vectors for a circuit-6 trace.
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
/// at or past `first_free_row` are switched off by [7]/[8] instead. Deliberate:
/// a depth-bounded `rc0` at depth 12 is zero over FOUR truncated cycles and its
/// interpolant is DENSE - 4,096 B of rodata per column, seven times over. Fully
/// periodic they interpolate to stride-16 polynomials byte-identical to C7's,
/// so the verifier shares one table set and C6's new rodata cost is ZERO.
///
/// On rows `0..first_free_row` the new construction equals the old one value
/// for value, so no witness row changes meaning.
pub fn build_merkle_update_periodic_columns(
    depth: usize,
    trace_length: usize,
) -> Vec<Vec<BaseElement>> {
    let tl = trace_length;
    let first_free_row = depth * HASH_CYCLE_LEN;
    assert!(
        first_free_row < tl,
        "C6 depth {depth} leaves no free row in a {tl}-row trace",
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
        // pos 31 includes row 511: that transition is exempt (winterfell's
        // single transition exemption) and killed by the (x - g^{n-1}) factor
        // in compute_quotient_lde_circuit_6. Including it is what keeps this
        // column 32-periodic, which is the whole point.
        if pos == HASH_CYCLE_LEN - 1 {
            is_boundary[row] = BaseElement::ONE;
        }
        if pos >= 1 && pos <= NUM_ROUNDS {
            is_interior[row] = BaseElement::ONE;
        }
    }

    // -- APPENDED 2026-08-29: the two gates that make C6 zero-knowledge --
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
    // updates fire there. Left on, they demand mask[384][8] == old_root and
    // mask[384][9] == new_root - unsatisfiable with fresh randomness, and
    // republishing both roots inside the blinding region if it were satisfied.
    // Stopping one row early makes the 383 -> 384 transition entirely free.
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

/// Standalone evaluator for circuit 6 transition constraints.
///
/// Mirrors `MerkleUpdateAir::evaluate_transition` so the prover can evaluate
/// the same constraints at LDE and OOD points without instantiating the AIR.
/// `current` / `next` must be length 10, `periodic` length 9, `result` length 19.
///
/// Periodic layout, NINE names and the body reads all nine:
/// `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior,
///   active, not_boundary_active]`
///
/// `not_boundary` is GONE from this function. Every use is now `nba`.
/// Reintroducing `E::ONE - is_boundary` anywhere below re-opens the tail
/// pinning that `stark/tests/air_aware_recovery_c6.rs` measures.
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
    let active = periodic[7];
    let nba = periodic[8]; // not_boundary_active

    let three = E::from(3u32);

    // Gated helpers. Each is TWO periodic factors on a base-1 or base-2
    // constraint, so degree_bound stays 3 and next_pow2 stays 4 - well under
    // the 8 that the degree-7 Poseidon constraints set.
    let hash_start_a = hash_start * active;
    let boundary_a = is_boundary * active;
    let is_interior_a = is_interior * active;

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
    result[0] = nba * (next[0] - current[0] - round_active * (oro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - round_active * (oro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - round_active * (oro2 - current[2]));

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
    result[3] = nba * (next[3] - current[3] - round_active * (nro0 - current[3]));
    result[4] = nba * (next[4] - current[4] - round_active * (nro1 - current[4]));
    result[5] = nba * (next[5] - current[5] - round_active * (nro2 - current[5]));

    // ── Hash start mux: state = mux(direction, carry, sibling) ──
    let dir = current[7];
    let sib = current[6];
    let old_carry = current[8];
    let new_carry = current[9];

    result[6] = hash_start_a * (current[0] - old_carry - dir * (sib - old_carry));
    result[7] = hash_start_a * (current[1] - sib - dir * (old_carry - sib));
    result[8] = hash_start_a * (current[3] - new_carry - dir * (sib - new_carry));
    result[9] = hash_start_a * (current[4] - sib - dir * (new_carry - sib));
    result[10] = hash_start_a * current[2];
    result[11] = hash_start_a * current[5];

    // ── Carry update at boundary ──
    // `active` is what makes row 383 free. is_boundary[383] = 1, so without it
    // these two demand mask[384][8] == old_root and mask[384][9] == new_root,
    // which republishes both roots inside the blinding region.
    result[12] = boundary_a * (next[8] - current[0]);
    result[13] = boundary_a * (next[9] - current[3]);

    // ── Carry continuity ──
    // Was `(E::ONE - is_boundary) * ...`, which is 1 on every mask row and froze
    // cols 8 and 9 flat across the tail - one of the four columns
    // air_aware_recovery_c6.rs recovers.
    result[14] = nba * (next[8] - current[8]);
    result[15] = nba * (next[9] - current[9]);

    // ── Sibling/direction continuity within cycle ──
    result[16] = is_interior_a * (next[6] - current[6]);
    result[17] = is_interior_a * (next[7] - current[7]);

    // ── Direction binary ──
    result[18] = hash_start_a * dir * (E::ONE - dir);
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build the execution trace for a Merkle update proof.
///
/// Both old and new hash chains share the same `path_elements` and `path_indices`;
/// only the leaf differs.
/// `mask` is the blinding material for rows `depth*32 .. trace_length` of every
/// column, laid out ROW-MAJOR as `mask_len_for_depth(depth)` elements: element
/// `i * TRACE_WIDTH + col`. At the canonical depth that is
/// `MASK_ROWS * TRACE_WIDTH = 128 * 10 = 1280`.
///
/// It is a REQUIRED argument and not an `Option` on purpose. A default would be
/// a zero-filled or witness-derived mask, which is exactly the failure this
/// design exists to prevent, and a caller who has not thought about randomness
/// should not compile.
///
/// It MUST be fresh CSPRNG output, redrawn for every proof.
pub fn build_merkle_update_trace(
    old_leaf: BaseElement,
    new_leaf: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
    mask: &[BaseElement],
) -> Vec<Vec<BaseElement>> {
    let depth = path_elements.len();
    assert_eq!(depth, path_indices.len());
    assert!(depth > 0);
    assert_eq!(
        mask.len(),
        mask_len_for_depth(depth),
        "C6 at depth {depth} needs {} blinding elements ({} rows x {TRACE_WIDTH} columns), got {}",
        mask_len_for_depth(depth),
        trace_length_for_depth(depth) - depth * HASH_CYCLE_LEN,
        mask.len(),
    );

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

    // -- Blinding region, rows depth*32 .. trace_length, ALL TEN COLUMNS --
    //
    // THIS IS THE ZERO-KNOWLEDGE ARGUMENT AND IT IS THE WHOLE POINT OF DEPTH 12.
    // Every transition constraint is gated off here by `active` /
    // `not_boundary_active`, so these rows are unconstrained and the prover
    // writes INDEPENDENT UNIFORM field elements into them, redrawn per proof.
    //
    // The counting: the wire publishes four trace rows per query plus two
    // out-of-domain openings, so R = 4 * 22 + 2 = 90 evaluations per column.
    // MASK_ROWS = 128 > 90, margin 38.
    //
    // WHAT THIS REPLACES, AND WHY IT WAS THE BUG. The old loop wrote the FROZEN
    // last state into these rows and a literal ZERO into cols 6 and 7. Cols 6-9
    // then carried one value per 32-row cycle across the whole trace, so a
    // 512-row column held fifteen unknowns against 90 published evaluations.
    // Equalities are linear, so nobody had to invert Poseidon:
    // `stark/tests/air_aware_recovery_c6.rs` recovers four of the ten columns
    // from the published bytes today, and that test going RED is what this
    // change is for.
    //
    // `mask` MUST be fresh CSPRNG output per proof. A chain, a counter or
    // anything derived from the witness collapses these values to one degree of
    // freedom and the attack comes straight back.
    let first_free_row = depth * HASH_CYCLE_LEN;
    for (i, row) in (first_free_row..trace_length).enumerate() {
        for col in 0..TRACE_WIDTH {
            trace[col][row] = mask[i * TRACE_WIDTH + col];
        }
    }
    // `old_carry` / `new_carry` are no longer read after the walk; the blinding
    // region replaces the copy that used to consume them.
    let _ = (old_carry, new_carry);

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


/// A deterministic mask for the tests in this file.
///
/// Adequate for exercising the TRACE SHAPE, and inadequate for any secrecy
/// claim: the blinding region is only hiding if its values are unpredictable.
/// The shipping path draws from `getrandom` inside the wasm entry and refuses to
/// build without a CSPRNG.
#[cfg(test)]
pub(crate) fn deterministic_test_mask(depth: usize) -> Vec<BaseElement> {
    let mut z: u64 = 0x9E37_79B9_7F4A_7C15 ^ (depth as u64) << 32 | 1;
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
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices, &deterministic_test_mask(indices.len()));
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
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices, &deterministic_test_mask(indices.len()));
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
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices, &deterministic_test_mask(indices.len()));

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
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices, &deterministic_test_mask(indices.len()));

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
        let trace = build_merkle_update_trace(ol, nl, &elems, &indices, &deterministic_test_mask(indices.len()));

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
