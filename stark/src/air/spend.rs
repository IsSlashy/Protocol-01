//! C7 — "spend" STARK AIR (unlinkable denominated withdrawal)
//!
//! Merges C1 (`denominated_pool`, the commitment derivation) and C3
//! (`merkle_path`, the membership proof) into ONE width-10 / 512-row trace so
//! that the note commitment never has to leave the circuit as a public input.
//!
//! This module is **purely additive**. It copies constraint bodies out of
//! `merkle_path.rs`, `denominated_pool.rs` and `transfer.rs`; it must never
//! edit them. Circuits 0-6 are frozen: the deployed verifier
//! `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` is byte-reproducible from
//! `836bc9cb` and the RLC uses `alpha^i` over the constraint order.
//!
//! ```text
//! width 10, length 512, blowup 16 -> LDE 8192, merkle_depth 13, 22 queries, ffps 32
//!
//! col 0-2  Merkle Poseidon state      16 cycles (15 real levels + 1 dummy)
//! col 3    sibling
//! col 4    direction bit
//! col 5    carry              (row 0 = leaf = the commitment)
//! col 6-8  Commitment Poseidon state  16 cycles (3 real + 13 dummy)
//! col 9    commit_hold        globally constant column
//!
//! cycle 0  rows  0- 31  nullifier  = P(nullifier_preimage, secret)  out col6@row30
//! cycle 1  rows 32- 63  blind_hash = P(blinding, token_mint)        out col6@row62
//! cycle 2  rows 64- 95  commitment = P(nullifier, blind_hash)       out col6@row94
//! cycles 3-15           dummy Poseidons, P(0, 0), nothing reads them
//!
//! merkle levels 0-14    rows 0-479, root at col0@row478
//! merkle cycle 15       rows 480-511, dummy P(root, 0), dir = 0, sib = 0
//! ```
//!
//! # Why all 16 cycles are genuine on BOTH pipelines
//!
//! This is the CU optimisation, and it has to be in the trace from the first
//! line rather than retrofitted. If either pipeline stops hashing at cycle 3
//! (commitment) or cycle 15 (Merkle), the shared periodic columns stop being
//! 32-periodic, their interpolants stop being stride-16 sparse, and the
//! on-chain verifier has to evaluate each of them with a dense 512-coefficient
//! Horner (~48K CU and ~4 KB of rodata *each*) instead of
//! `eval_periodic_stride16_at_z` (36 muls). C6 (`merkle_update.rs:206-259`)
//! bounds its periodic loops by `active_rows = depth * 32` and pays that price
//! on all seven of its columns; C7 must not copy that idiom.
//!
//! Consequences that the on-chain side MUST honour (see the handoff note):
//!   * there are **no padding rows**. Every row 0..511 is an active Poseidon
//!     round on both pipelines, so the `active_rows = 15 * hash_cycle_len`
//!     guard at `verify.rs:3220` is WRONG for C7 and must be absent.
//!   * `is_boundary` is set at row 511 as well (unlike `transfer.rs:331`).
//!     That transition is the wrap row: winterfell exempts it
//!     (`num_transition_exemptions == 1`) and the compact prover multiplies by
//!     `(x - g^{n-1})` before dividing by the vanishing polynomial, so nothing
//!     reads the value. Including it is what keeps the column 32-periodic.
//!   * the per-query step-4 check cannot be cloned from C3 (`for col in
//!     3..trace_width { next == current }` would freeze the live commitment
//!     pipeline at cols 6-8) nor from C6 (`for col in 6..` would demand cols
//!     3-5 round-advance). It has to be written from this layout.
//!
//! # The hold column
//!
//! Transition constraints are local (row i -> row i+1), so row 94 cannot be
//! related to row 0 directly. Col 9 is forced constant on every transition,
//! pinned at row 94 to the commitment output and equated at row 0 to the
//! Merkle carry. That binds `leaf == commitment` with NO boundary assertion
//! and NO public input carrying the commitment:
//!
//! ```text
//! [15] (next[9] - current[9]) = 0                       every transition row
//! [16] commit_out_flag(row 94) * (current[9] - current[6])
//! [17] row0_flag(row 0)       * (current[5] - current[9])
//! ```
//!
//! # 🚨 PRIVACY: the hold column is published in the proof bytes
//!
//! Constraint [15] makes col 9 a DEGREE-0 polynomial. Its LDE evaluation is
//! the commitment at all 8192 positions, trace-aligned or not, and
//! `compact.rs:4046-4137` serialises `ood_current[col]`, `ood_next[col]` and
//! `lde[col][pos] / lde[col][next_pos]` for EVERY column of EVERY query with
//! no filter. In a C7 proof the commitment therefore appears verbatim as an
//! 8-byte LE u64 roughly 46 times, in a blob that is uploaded as public
//! instruction data. See `docs/C7_SPEND_CIRCUIT_PLAN.md:440-454`, and the
//! `hold_column_is_constant_which_publishes_the_commitment` test below, which
//! pins the property so it cannot be quietly forgotten.
//!
//! Taking the commitment out of the instruction puts it into the proof. This
//! AIR implements the plan's specified design ([15] ungated) because the
//! geometry and the constraint list are frozen inputs to Step 3, but C7 is NOT
//! zero-knowledge and must not be described as unlinkable until this is
//! resolved. The cheapest additive mitigation, if it is taken, is to APPEND an
//! 11th periodic column `hold_active` (1 on rows 0..93, 0 afterwards) at index
//! 10 and gate [15] with it — that changes constraint [15]'s BODY but not its
//! INDEX, and appends to the periodic vector rather than inserting into it, so
//! it stays compatible with the frozen order as long as it happens before
//! Step 4 bakes the coefficients. It reduces the leak to the ~25% of proofs
//! with a trace-aligned query in rows 0-94; it does not remove it. Col 5 (the
//! Merkle carry) also holds the commitment on rows 0-31 regardless.
//!
//! Public inputs: `[nullifier, root, rh0, rh1, rh2, rh3]` — SIX felts. The
//! recipient hash is the full 256 bits split into four u64s; one felt would be
//! 64-bit binding. `depth` is NOT a public input — it is fixed at 15 by the
//! layout.

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
pub const TRACE_LENGTH: usize = 512;
pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;
/// Number of 32-row hash cycles on the 512-row trace. BOTH pipelines run all
/// of them; see the module docs.
pub const NUM_HASH_CYCLES: usize = TRACE_LENGTH / HASH_CYCLE_LEN; // 16

/// Merkle depth. Fixed by the layout, NOT a public input.
pub const CANONICAL_DEPTH: usize = 15;

/// Number of transition constraints. Indices 0..=17.
///   [0]-[10]  Merkle pipeline   (verbatim from `merkle_path.rs:260-283`)
///   [11]-[13] Commitment Poseidon (from `denominated_pool.rs:241-243`, +6 cols)
///   [14]      Commitment chain edge (`denominated_pool.rs:247`, +6 cols)
///   [15]-[17] Hold column
pub const SPEND_NUM_CONSTRAINTS: usize = 18;

/// Number of periodic columns. Order is FROZEN — Step 4's emitter and Step 6's
/// `compute_c7_periodic_at_z` index it positionally.
///   0-6  stride-16 eligible, emitted at NATURAL LENGTH 32
///   7-9  one-hot, emitted at length 512
pub const SPEND_NUM_PERIODIC: usize = 10;

pub const SPEND_NUM_PUBLIC_INPUTS: usize = 6;
pub const SPEND_NUM_BOUNDARY_ASSERTIONS: usize = 6;

/// Row on which the nullifier appears at col 6 (cycle 0 output).
pub const ROW_NULLIFIER_OUT: usize = NUM_ROUNDS; // 30
/// Row on which `blind_hash` appears at col 6 (cycle 1 output).
pub const ROW_BLIND_HASH_OUT: usize = HASH_CYCLE_LEN + NUM_ROUNDS; // 62
/// Row on which the chain edge fires: `next[7]@64 == current[6]@63`.
pub const ROW_CHAIN: usize = 2 * HASH_CYCLE_LEN - 1; // 63
/// Row on which cycle 2 starts (its left input is the public nullifier).
pub const ROW_COMMIT_IN: usize = 2 * HASH_CYCLE_LEN; // 64
/// Row on which the commitment appears at col 6 (cycle 2 output).
pub const ROW_COMMITMENT_OUT: usize = 2 * HASH_CYCLE_LEN + NUM_ROUNDS; // 94
/// Row on which the Merkle root appears at col 0 (level 14 output).
pub const ROW_MERKLE_ROOT_OUT: usize = (CANONICAL_DEPTH - 1) * HASH_CYCLE_LEN + NUM_ROUNDS; // 478

/// 🚨 Rows on which the MERKLE pipeline (cols 0-2, 5) runs genuine Poseidon
/// rounds: ALL of them. C7 has no padding rows — the 16th cycle at rows
/// 480-511 is a real (dummy-input) hash. Copying C3's
/// `active_rows = 15 * hash_cycle_len` guard into `verify_constraints_spend`
/// would deterministically reject every honest proof with a trace-aligned
/// query in rows 480-511.
pub const SPEND_MERKLE_ACTIVE_ROWS: usize = TRACE_LENGTH;
/// 🚨 Same for the COMMITMENT pipeline (cols 6-8): all 512 rows are active.
pub const SPEND_COMMIT_ACTIVE_ROWS: usize = TRACE_LENGTH;
/// Merkle cycles whose output anybody reads (levels 0..14). Cycle 15 is dummy.
pub const SPEND_MERKLE_MEANINGFUL_CYCLES: usize = CANONICAL_DEPTH; // 15
/// Commitment cycles whose output anybody reads. Cycles 3..15 are dummy.
pub const SPEND_COMMIT_MEANINGFUL_CYCLES: usize = 3;

/// The six boundary assertions, in the ONE order that is load-bearing.
///
/// `(column, row, source)` where `source == Some(i)` means `public_inputs[i]`
/// and `source == None` means `BaseElement::ZERO`.
///
/// This order is the exponent order of `alpha_bnd^j` in
/// `fold_boundary_quotient` and must be mirrored byte-identically into
/// `compact.rs::boundary_assertions_for_circuit` arm 7 and
/// `verify.rs::get_boundary_assertions` arm 7. Reading it from this one table
/// instead of hand-typing it three times is what keeps the `pi(i)` zero-fill
/// at `compact.rs:1224` from silently binding a trace cell to zero.
///
/// NONE of these carries the commitment or the leaf — see
/// `boundary_spec_carries_neither_commitment_nor_leaf`.
pub const SPEND_BOUNDARY_SPEC: [(usize, usize, Option<usize>); SPEND_NUM_BOUNDARY_ASSERTIONS] = [
    (6, ROW_NULLIFIER_OUT, Some(0)),   // nullifier output, public input 0
    (6, ROW_COMMIT_IN, Some(0)),       // cycle-2 LEFT input == the same nullifier
    (8, 0, None),                      // capacity, cycle 0
    (8, HASH_CYCLE_LEN, None),         // capacity, cycle 1
    (8, 2 * HASH_CYCLE_LEN, None),     // capacity, cycle 2
    (0, ROW_MERKLE_ROOT_OUT, Some(1)), // Merkle root, public input 1
];

// ============================================================================
// Public inputs
// ============================================================================

/// `[nullifier, root, rh0, rh1, rh2, rh3]`.
///
/// `recipient_hash` is `sha256(recipient_pubkey)` split into four LE u64s. It
/// occupies no trace column and no constraint: the binding is
/// Fiat-Shamir-transcript-only, exactly as C3's `depth` is.
#[derive(Clone, Debug)]
pub struct SpendPublicInputs {
    pub nullifier: BaseElement,
    pub root: BaseElement,
    pub recipient_hash: [BaseElement; 4],
}

impl SpendPublicInputs {
    /// Flatten in the frozen order. `pub_bytes` for Step 4 is this vector,
    /// each element as 8 LE bytes: 48 bytes total.
    pub fn to_vec(&self) -> Vec<BaseElement> {
        vec![
            self.nullifier,
            self.root,
            self.recipient_hash[0],
            self.recipient_hash[1],
            self.recipient_hash[2],
            self.recipient_hash[3],
        ]
    }
}

impl ToElements<BaseElement> for SpendPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        self.to_vec()
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct SpendAir {
    context: AirContext<BaseElement>,
    public_inputs: Vec<BaseElement>,
}

impl Air for SpendAir {
    type BaseField = BaseElement;
    type PublicInputs = SpendPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        assert_eq!(
            trace_info.length(),
            TRACE_LENGTH,
            "C7 trace length is fixed at {TRACE_LENGTH}"
        );
        assert_eq!(
            trace_info.main_trace_width(),
            TRACE_WIDTH,
            "C7 trace width is fixed at {TRACE_WIDTH}"
        );

        let degrees = spend_constraint_degrees();
        assert_eq!(degrees.len(), SPEND_NUM_CONSTRAINTS);

        let public_inputs = pub_inputs.to_vec();
        assert_eq!(
            public_inputs.len(),
            SPEND_NUM_PUBLIC_INPUTS,
            "C7 takes exactly {SPEND_NUM_PUBLIC_INPUTS} public inputs"
        );

        let context = AirContext::new(
            trace_info,
            degrees,
            SPEND_NUM_BOUNDARY_ASSERTIONS,
            options,
        );

        Self { context, public_inputs }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_spend_periodic_columns()
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_spend_transition(frame.current(), frame.next(), periodic_values, result);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        spend_boundary_assertions(&self.public_inputs)
    }
}

/// The 18 constraint degrees, in the frozen constraint order.
///
/// The declared cycle lengths must match the ACTUAL periodic column lengths
/// emitted by `build_spend_periodic_columns`: 32 for the seven shared columns,
/// 512 for the three one-hot flags. This is *tighter* than C5's
/// `vec![HASH_CYCLE_LEN, TRACE_LENGTH]` (max evaluation degree 4569 vs 4584)
/// because C7's `is_boundary` is 32-periodic too.
///
/// Nothing here may multiply a `pow7` term by another trace column: base
/// degree 8 would push `ce_blowup_factor` from 8 to 16 and change the proof's
/// degree structure under every downstream assumption.
pub fn spend_constraint_degrees() -> Vec<TransitionConstraintDegree> {
    vec![
        // ── Merkle pipeline, cols 0-5 ──
        // [0-2] Poseidon round: gated by round_flag(32) and is_boundary(32)
        TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, HASH_CYCLE_LEN]), // 0
        TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, HASH_CYCLE_LEN]), // 1
        TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, HASH_CYCLE_LEN]), // 2
        TransitionConstraintDegree::with_cycles(2, vec![HASH_CYCLE_LEN]),                 // 3 mux s0
        TransitionConstraintDegree::with_cycles(2, vec![HASH_CYCLE_LEN]),                 // 4 mux s1
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN]),                 // 5 capacity
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN]),                 // 6 carry update
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN]),                 // 7 carry cont.
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN]),                 // 8 sib cont.
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN]),                 // 9 dir cont.
        TransitionConstraintDegree::with_cycles(2, vec![HASH_CYCLE_LEN]),                 // 10 dir binary
        // ── Commitment pipeline, cols 6-8 ──
        TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, HASH_CYCLE_LEN]), // 11
        TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, HASH_CYCLE_LEN]), // 12
        TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, HASH_CYCLE_LEN]), // 13
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),                   // 14 chain
        // ── Hold column, col 9 ──
        TransitionConstraintDegree::new(1),                                               // 15 (ungated)
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),                   // 16
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),                   // 17
    ]
}

/// Build the six boundary assertions from `SPEND_BOUNDARY_SPEC`.
///
/// Panics on an arity slip rather than zero-filling — `compact.rs:1224`'s
/// `pi()` closure and `verify.rs`'s `if public_inputs.len() > n` ladders both
/// fail OPEN, which silently binds a trace cell to zero.
pub fn spend_boundary_assertions(public_inputs: &[BaseElement]) -> Vec<Assertion<BaseElement>> {
    assert_eq!(
        public_inputs.len(),
        SPEND_NUM_PUBLIC_INPUTS,
        "C7 boundary assertions need exactly {SPEND_NUM_PUBLIC_INPUTS} public inputs"
    );
    SPEND_BOUNDARY_SPEC
        .iter()
        .map(|&(col, row, source)| {
            let value = match source {
                Some(i) => public_inputs[i],
                None => BaseElement::ZERO,
            };
            Assertion::single(col, row, value)
        })
        .collect()
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
// Periodic columns
// ============================================================================

/// Build the 10 periodic columns for circuit 7.
///
/// Layout — FROZEN, indexed positionally by Step 4's emitter and Step 6's
/// `compute_c7_periodic_at_z`:
///
/// ```text
///  0 rc0             len  32   stride-16
///  1 rc1             len  32   stride-16
///  2 rc2             len  32   stride-16
///  3 round_flag      len  32   stride-16   1 on pos < 30
///  4 is_boundary     len  32   stride-16   1 on pos == 31 (INCLUDING row 511)
///  5 hash_start      len  32   stride-16   1 on pos == 0
///  6 is_interior     len  32   stride-16   1 on pos in 1..=30
///  7 chain_flag      len 512   one-hot @ row 63
///  8 commit_out_flag len 512   one-hot @ row 94
///  9 row0_flag       len 512   one-hot @ row 0
/// ```
///
/// THE API CONTRACT IS THE VECTOR LENGTH. Columns 0-6 are returned at their
/// natural period 32 so that 32-periodicity cannot be broken by editing one
/// row; winterfell and `compute_quotient_lde_circuit_*`'s `materialise`
/// closure (`compact.rs:1018-1030`) tile them back onto 512. A length-32
/// emission and a hand-tiled length-512 emission are byte-identical
/// downstream, so the length-32 form is free safety.
///
/// Takes NO arguments: depth is fixed at 15 and passing it invites the
/// degrade shape that `boundary_assertions_for_circuit` arms 3 and 6 have.
pub fn build_spend_periodic_columns() -> Vec<Vec<BaseElement>> {
    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    // ── period 32, shared by BOTH pipelines ──
    let mut rc0 = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    let mut rc1 = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    let mut rc2 = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    let mut round_flag = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    for pos in 0..NUM_ROUNDS {
        rc0[pos] = rc[pos * 3];
        rc1[pos] = rc[pos * 3 + 1];
        rc2[pos] = rc[pos * 3 + 2];
        round_flag[pos] = BaseElement::ONE;
    }

    // is_boundary at pos 31 => rows 31, 63, ..., 511. Row 511 IS included:
    // that transition is exempt (winterfell) and killed by the `(x - g^{n-1})`
    // factor (compact prover), and including it is what keeps this column
    // 32-periodic. `transfer.rs:331` skips it and pays ~48-101K CU for it.
    let mut is_boundary = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    is_boundary[HASH_CYCLE_LEN - 1] = BaseElement::ONE;

    let mut hash_start = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    hash_start[0] = BaseElement::ONE;

    let mut is_interior = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    for pos in 1..=NUM_ROUNDS {
        is_interior[pos] = BaseElement::ONE;
    }

    // ── period 512, one-hot ──
    let make_flag = |row: usize| -> Vec<BaseElement> {
        let mut f = vec![BaseElement::ZERO; TRACE_LENGTH];
        f[row] = BaseElement::ONE;
        f
    };

    let chain_flag = make_flag(ROW_CHAIN); // 63
    let commit_out_flag = make_flag(ROW_COMMITMENT_OUT); // 94
    let row0_flag = make_flag(0);

    vec![
        rc0,             // 0
        rc1,             // 1
        rc2,             // 2
        round_flag,      // 3
        is_boundary,     // 4
        hash_start,      // 5
        is_interior,     // 6
        chain_flag,      // 7
        commit_out_flag, // 8
        row0_flag,       // 9
    ]
}

// ============================================================================
// Transition constraints
// ============================================================================

/// Evaluate the 18 transition constraints for circuit 7.
///
/// Any change here MUST be mirrored in `compute_quotient_lde_circuit_7`
/// (`stark/src/compact.rs`) and `evaluate_transition_at_ood_circuit_7`
/// (`programs/p01_stark_verifier/src/verify.rs`). Constraint ORDER is
/// load-bearing (the RLC uses `alpha^i`): append at index 18, never insert.
///
/// `periodic[0..10]`:
///   `[rc0, rc1, rc2, round_flag, is_boundary, hash_start, is_interior,
///     chain_flag, commit_out_flag, row0_flag]`
///
/// `result[0..18]`:
///   `[m_pos_s0, m_pos_s1, m_pos_s2, m_mux_s0, m_mux_s1, m_capacity,
///     m_carry_update, m_carry_cont, m_sib_cont, m_dir_cont, m_dir_binary,
///     c_pos_s0, c_pos_s1, c_pos_s2, c_chain,
///     hold_const, hold_pin_commit, hold_pin_leaf]`
pub fn evaluate_spend_transition<E: FieldElement>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), TRACE_WIDTH);
    debug_assert_eq!(next.len(), TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), SPEND_NUM_PERIODIC);
    debug_assert_eq!(result.len(), SPEND_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_flag = periodic[3];
    let is_boundary = periodic[4];
    let hash_start = periodic[5];
    let is_interior = periodic[6];
    let chain_flag = periodic[7];
    let commit_out_flag = periodic[8];
    let row0_flag = periodic[9];

    let three = E::from(3u32);
    let not_boundary = E::ONE - is_boundary;

    // ────────────────────────────────────────────────────────────────────
    // [0]-[10] Merkle pipeline (cols 0-5).
    // Copied VERBATIM from `merkle_path.rs:247-283`. C7's cols 0-5 are the
    // same columns C3 uses, so there is zero re-indexing. Do NOT copy from
    // `merkle_update.rs`, whose cols are 6 = sibling, 7 = direction,
    // 8/9 = carries.
    // ────────────────────────────────────────────────────────────────────
    let s0 = current[0] + rc0;
    let s1 = current[1] + rc1;
    let s2 = current[2] + rc2;
    let s0_7 = pow7(s0);
    let s1_7 = pow7(s1);
    let s2_7 = pow7(s2);
    let ro0 = three * s0_7 + s1_7 + s2_7;
    let ro1 = s0_7 + three * s1_7 + s2_7;
    let ro2 = s0_7 + s1_7 + three * s2_7;

    result[0] = not_boundary * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = not_boundary * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = not_boundary * (next[2] - current[2] - round_flag * (ro2 - current[2]));

    // Hash start: state = mux(direction, carry, sibling)
    let dir = current[4];
    let sib = current[3];
    let carry = current[5];
    result[3] = hash_start * (current[0] - carry - dir * (sib - carry));
    result[4] = hash_start * (current[1] - sib - dir * (carry - sib));
    result[5] = hash_start * current[2];

    // Carry update at boundary / carry continuity off-boundary
    result[6] = is_boundary * (next[5] - current[0]);
    result[7] = not_boundary * (next[5] - current[5]);

    // Sibling/direction continuity within a cycle
    result[8] = is_interior * (next[3] - current[3]);
    result[9] = is_interior * (next[4] - current[4]);

    // Direction binary
    result[10] = hash_start * dir * (E::ONE - dir);

    // ────────────────────────────────────────────────────────────────────
    // [11]-[14] Commitment pipeline (cols 6-8).
    // `denominated_pool.rs:226-247` with a uniform +6 column shift.
    // ────────────────────────────────────────────────────────────────────
    let t0 = current[6] + rc0;
    let t1 = current[7] + rc1;
    let t2 = current[8] + rc2;
    let t0_7 = pow7(t0);
    let t1_7 = pow7(t1);
    let t2_7 = pow7(t2);
    let co0 = three * t0_7 + t1_7 + t2_7;
    let co1 = t0_7 + three * t1_7 + t2_7;
    let co2 = t0_7 + t1_7 + three * t2_7;

    result[11] = not_boundary * (next[6] - current[6] - round_flag * (co0 - current[6]));
    result[12] = not_boundary * (next[7] - current[7] - round_flag * (co1 - current[7]));
    result[13] = not_boundary * (next[8] - current[8] - round_flag * (co2 - current[8]));

    // Chain: blind_hash (col 6 @ row 63) -> cycle 2's RIGHT input (col 7 @ 64).
    // Without this, blind_hash is a free prover choice and the commitment at
    // row 94 is whatever the prover wants — [16]/[17] would then bind a value
    // the prover controls end to end.
    result[14] = chain_flag * (next[7] - current[6]);

    // ────────────────────────────────────────────────────────────────────
    // [15]-[17] Hold column (col 9). See the module-level privacy note:
    // [15] is the only ungated constraint in the crate and it makes col 9 a
    // degree-0 polynomial, which the serializer publishes verbatim.
    // ────────────────────────────────────────────────────────────────────
    result[15] = next[9] - current[9];
    result[16] = commit_out_flag * (current[9] - current[6]);
    result[17] = row0_flag * (current[5] - current[9]);
}

// ============================================================================
// Witness values
// ============================================================================

/// Compute `(nullifier, blind_hash, commitment)` without building the trace.
///
/// DELEGATES to `denominated_pool::compute_pool_values` rather than
/// re-deriving the Poseidon chain. Any independent re-implementation is a
/// divergence risk that surfaces months later as an unspendable legacy note.
/// The client twin is `createCommitmentV3`
/// (`apps/web/lib/privacy/pool/denominatedPool.ts:808-822`).
///
/// 🔒 LEGACY CONTRACT: the `blinding` slot accepts ANY field element. It is
/// the historical `deposit_epoch` position — for notes shielded before
/// commitment blinding it holds a real small epoch (the unspent leaf-30 note
/// of the 0.1 SOL pool is one). Never add a boundary assertion at col 6 or
/// col 7 row 32, a range check, a bit decomposition, or promote it to a public
/// input: all four brick that note with no recovery path.
///
/// NOTE the returned `commitment` is witness/test-only. `build_spend_trace`
/// deliberately does NOT return it, so that `generate_spend_compact_proof`
/// cannot have it in a local variable one keystroke away from `pub_bytes`.
pub fn compute_spend_values(
    nullifier_preimage: BaseElement,
    secret: BaseElement,
    blinding: BaseElement,
    token_mint: BaseElement,
) -> (BaseElement, BaseElement, BaseElement) {
    let (nullifier, commitment) = crate::air::denominated_pool::compute_pool_values(
        nullifier_preimage,
        secret,
        blinding,
        token_mint,
    );
    let blind_hash = poseidon::hash2(blinding, token_mint);
    debug_assert_eq!(
        poseidon::hash2(nullifier, blind_hash),
        commitment,
        "C7 diverged from the C1 commitment formula"
    );
    (nullifier, blind_hash, commitment)
}

/// Compute the Merkle root from a leaf and a path (same as `merkle_path`).
pub fn compute_spend_root(
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
// Trace generation
// ============================================================================

/// Build the C7 execution trace.
///
/// Returns `(trace, nullifier, root)` — the two PUBLIC values, and nothing
/// else. The commitment stays inside the trace on purpose.
pub fn build_spend_trace(
    nullifier_preimage: BaseElement,
    secret: BaseElement,
    blinding: BaseElement,
    token_mint: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement) {
    assert_eq!(
        path_elements.len(),
        CANONICAL_DEPTH,
        "C7 depth is fixed at {CANONICAL_DEPTH}"
    );
    assert_eq!(path_indices.len(), CANONICAL_DEPTH);

    let mut trace = vec![vec![BaseElement::ZERO; TRACE_LENGTH]; TRACE_WIDTH];

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mds = &poseidon::constants::MDS_MATRIX_T3;

    // One genuine 32-row Poseidon cycle into cols `base..base+2`.
    // Rows start..start+29 are the rounds, start+30 holds the output and
    // start+31 repeats it (the free-transition row). Modelled on
    // `transfer.rs:538-582`, which proves that 16 genuinely-hashed cycles on a
    // 512-row trace prove and verify — C5 ships exactly this shape.
    let run_hash = |trace: &mut Vec<Vec<BaseElement>>,
                    base: usize,
                    cycle: usize,
                    in0: BaseElement,
                    in1: BaseElement|
     -> BaseElement {
        let start = cycle * HASH_CYCLE_LEN;
        let mut state = [in0, in1, BaseElement::ZERO];

        trace[base][start] = state[0];
        trace[base + 1][start] = state[1];
        trace[base + 2][start] = state[2];

        for round in 0..NUM_ROUNDS {
            state[0] = state[0] + rc[round * 3];
            state[1] = state[1] + rc[round * 3 + 1];
            state[2] = state[2] + rc[round * 3 + 2];
            for s in &mut state {
                let x = *s;
                let x2 = x * x;
                let x4 = x2 * x2;
                *s = x4 * x2 * x;
            }
            let mut res = [BaseElement::ZERO; 3];
            for i in 0..3 {
                for j in 0..3 {
                    res[i] = res[i] + mds[i][j] * state[j];
                }
            }
            state = res;

            let row = start + round + 1;
            trace[base][row] = state[0];
            trace[base + 1][row] = state[1];
            trace[base + 2][row] = state[2];
        }

        // Free-transition row (pos 31), copy of the output row.
        let pad = start + NUM_ROUNDS + 1;
        trace[base][pad] = state[0];
        trace[base + 1][pad] = state[1];
        trace[base + 2][pad] = state[2];

        state[0]
    };

    // ── Commitment pipeline, cols 6-8 ──────────────────────────────────
    let nullifier = run_hash(&mut trace, 6, 0, nullifier_preimage, secret);
    let blind_hash = run_hash(&mut trace, 6, 1, blinding, token_mint);
    let commitment = run_hash(&mut trace, 6, 2, nullifier, blind_hash);
    // Cycles 3-15: dummy Poseidons on P(0, 0). Nothing reads them; they exist
    // solely so the shared periodic columns stay 32-periodic.
    for cycle in SPEND_COMMIT_MEANINGFUL_CYCLES..NUM_HASH_CYCLES {
        let _ = run_hash(&mut trace, 6, cycle, BaseElement::ZERO, BaseElement::ZERO);
    }

    debug_assert_eq!(
        compute_spend_values(nullifier_preimage, secret, blinding, token_mint),
        (nullifier, blind_hash, commitment)
    );

    // ── Merkle pipeline, cols 0-2 + witness cols 3-5 ───────────────────
    // The leaf is the commitment — it is NEVER a public input and NEVER a
    // boundary assertion. Constraint [17] is the only thing binding it.
    let mut carry = commitment;

    let write_witness = |trace: &mut Vec<Vec<BaseElement>>,
                             cycle: usize,
                             sibling: BaseElement,
                             dir_felt: BaseElement,
                             carry: BaseElement| {
        let start = cycle * HASH_CYCLE_LEN;
        for row in start..start + HASH_CYCLE_LEN {
            trace[3][row] = sibling;
            trace[4][row] = dir_felt;
            trace[5][row] = carry;
        }
    };

    for level in 0..CANONICAL_DEPTH {
        let sibling = path_elements[level];
        let dir = path_indices[level];
        assert!(dir <= 1, "C7 direction bits must be 0 or 1");
        let dir_felt = if dir == 0 { BaseElement::ZERO } else { BaseElement::ONE };

        write_witness(&mut trace, level, sibling, dir_felt, carry);

        let (left, right) = if dir == 0 { (carry, sibling) } else { (sibling, carry) };
        carry = run_hash(&mut trace, 0, level, left, right);
    }
    let root = carry;

    // Dummy 16th Merkle cycle at rows 480-511. It is NOT free: constraint [6]
    // at row 479 forces carry@480 == root, and the hash-start mux then forces
    // cols 0/1 from (carry, sibling, direction). With dir = 0 and sib = 0 the
    // cycle hashes P(root, 0), the direction-binary constraint is satisfied
    // and the capacity is 0. Do NOT identity-pad these rows the way
    // `merkle_update.rs:469-494` and `merkle_path.rs:378-394` do — with a
    // 32-periodic round_flag that fails the prover's own constraints.
    write_witness(
        &mut trace,
        CANONICAL_DEPTH,
        BaseElement::ZERO,
        BaseElement::ZERO,
        root,
    );
    let _ = run_hash(&mut trace, 0, CANONICAL_DEPTH, root, BaseElement::ZERO);

    // ── Hold column, col 9 ─────────────────────────────────────────────
    for row in 0..TRACE_LENGTH {
        trace[9][row] = commitment;
    }

    debug_assert_eq!(trace[6][ROW_NULLIFIER_OUT], nullifier);
    debug_assert_eq!(trace[6][ROW_BLIND_HASH_OUT], blind_hash);
    debug_assert_eq!(trace[6][ROW_COMMITMENT_OUT], commitment);
    debug_assert_eq!(trace[0][ROW_MERKLE_ROOT_OUT], root);

    (trace, nullifier, root)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── fixtures ────────────────────────────────────────────────────────

    const NP: u64 = 111;
    const SECRET: u64 = 222;
    const MINT: u64 = 444;
    /// A LEGACY note: the third slot holds a real small epoch, not a 63-bit
    /// PRF blinding. Everything must stay provable for it.
    const LEGACY_BLINDING: u64 = 42;

    fn test_path() -> (Vec<BaseElement>, Vec<u8>) {
        let mut elems = Vec::new();
        let mut idx = Vec::new();
        for i in 0..CANONICAL_DEPTH {
            elems.push(BaseElement::new(1000 + i as u64));
            idx.push((i % 2) as u8);
        }
        (elems, idx)
    }

    fn honest() -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement, BaseElement) {
        let (elems, idx) = test_path();
        let (trace, nullifier, root) = build_spend_trace(
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
            &elems,
            &idx,
        );
        let (_, _, commitment) = compute_spend_values(
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
        );
        (trace, nullifier, root, commitment)
    }

    fn pub_inputs(nullifier: BaseElement, root: BaseElement) -> SpendPublicInputs {
        SpendPublicInputs {
            nullifier,
            root,
            recipient_hash: [
                BaseElement::new(0x0123_4567_89ab_cdef),
                BaseElement::new(0xfedc_ba98_7654_3210),
                BaseElement::new(1),
                BaseElement::new(2),
            ],
        }
    }

    /// Tile the mixed-length periodic columns onto the full trace domain.
    /// This is exactly what winterfell's `validate` and `compact.rs`'s
    /// `materialise` closure do at trace-aligned points.
    fn materialise(cols: &[Vec<BaseElement>]) -> Vec<Vec<BaseElement>> {
        cols.iter()
            .map(|c| (0..TRACE_LENGTH).map(|i| c[i % c.len()]).collect())
            .collect()
    }

    /// Evaluate all 18 constraints at every enforced transition row
    /// (0..=510 — row 511's transition is the exempt wrap row).
    fn eval_all(trace: &[Vec<BaseElement>]) -> Vec<[BaseElement; SPEND_NUM_CONSTRAINTS]> {
        let periodic = materialise(&build_spend_periodic_columns());
        let mut out = Vec::with_capacity(TRACE_LENGTH - 1);
        for row in 0..TRACE_LENGTH - 1 {
            let current: Vec<BaseElement> = (0..TRACE_WIDTH).map(|c| trace[c][row]).collect();
            let next: Vec<BaseElement> = (0..TRACE_WIDTH).map(|c| trace[c][row + 1]).collect();
            let p: Vec<BaseElement> =
                (0..SPEND_NUM_PERIODIC).map(|j| periodic[j][row]).collect();
            let mut result = [BaseElement::ZERO; SPEND_NUM_CONSTRAINTS];
            evaluate_spend_transition(&current, &next, &p, &mut result);
            out.push(result);
        }
        out
    }

    // ── shape pins ──────────────────────────────────────────────────────

    #[test]
    fn constraint_and_periodic_counts_are_frozen() {
        assert_eq!(TRACE_WIDTH, 10);
        assert_eq!(TRACE_LENGTH, 512);
        assert_eq!(SPEND_NUM_CONSTRAINTS, 18);
        assert_eq!(SPEND_NUM_PERIODIC, 10);
        assert_eq!(SPEND_NUM_PUBLIC_INPUTS, 6);
        assert_eq!(SPEND_NUM_BOUNDARY_ASSERTIONS, 6);
        assert_eq!(build_spend_periodic_columns().len(), SPEND_NUM_PERIODIC);
        assert_eq!(ROW_COMMITMENT_OUT, 94);
        assert_eq!(ROW_MERKLE_ROOT_OUT, 478);
        assert_eq!(ROW_CHAIN, 63);
    }

    #[test]
    fn constraint_degrees_stay_inside_the_blowup() {
        // Measured, not asserted: winterfell's own arithmetic is
        //   base*(n-1) + sum_i (n/c_i)*(c_i - 1)
        // and ce_blowup_factor = max_i next_pow2(base_i + |cycles_i| - 1).
        let degrees = spend_constraint_degrees();
        assert_eq!(degrees.len(), SPEND_NUM_CONSTRAINTS);

        let max_eval = degrees
            .iter()
            .map(|d| d.get_evaluation_degree(TRACE_LENGTH))
            .max()
            .unwrap();
        // 7*511 + 16*31 + 16*31 = 3577 + 496 + 496
        assert_eq!(max_eval, 4569, "C7 max transition evaluation degree drifted");

        let min_blowup = degrees.iter().map(|d| d.min_blowup_factor()).max().unwrap();
        assert_eq!(min_blowup, 8, "ce_blowup_factor drifted; blowup 16 is the ceiling");

        // Composition polynomial degree after dividing by the transition
        // divisor (degree n - 1), against the constraint-evaluation domain.
        let composition_degree = max_eval - (TRACE_LENGTH - 1);
        let ce_domain = TRACE_LENGTH * min_blowup;
        assert_eq!(composition_degree, 4058);
        assert!(composition_degree < ce_domain, "composition degree exceeds the CE domain");

        // And the live AirContext agrees.
        let (trace, nullifier, root, _) = honest();
        let info = winterfell::TraceInfo::new(TRACE_WIDTH, TRACE_LENGTH);
        let options = winterfell::ProofOptions::new(
            32,
            16,
            0,
            winterfell::FieldExtension::None,
            8,
            31,
        );
        let air = SpendAir::new(info, pub_inputs(nullifier, root), options);
        assert_eq!(air.ce_blowup_factor(), 8);
        assert_eq!(air.context().num_constraint_composition_columns(), 8);
        assert_eq!(air.get_assertions().len(), SPEND_NUM_BOUNDARY_ASSERTIONS);
        assert_eq!(air.get_periodic_column_values().len(), SPEND_NUM_PERIODIC);
        let _ = trace;
    }

    #[test]
    fn periodic_column_lengths_are_the_api_contract() {
        let cols = build_spend_periodic_columns();
        // 0-6 at natural period 32 => stride-16 sparse on the 512 domain.
        for i in 0..7 {
            assert_eq!(cols[i].len(), HASH_CYCLE_LEN, "periodic column {i} must be length 32");
        }
        // 7-9 one-hot at length 512.
        for i in 7..SPEND_NUM_PERIODIC {
            assert_eq!(cols[i].len(), TRACE_LENGTH, "periodic column {i} must be length 512");
            let ones = cols[i].iter().filter(|v| **v == BaseElement::ONE).count();
            let zeros = cols[i].iter().filter(|v| **v == BaseElement::ZERO).count();
            assert_eq!(ones, 1, "periodic column {i} must be one-hot");
            assert_eq!(ones + zeros, TRACE_LENGTH);
        }
        assert_eq!(cols[7][ROW_CHAIN], BaseElement::ONE);
        assert_eq!(cols[8][ROW_COMMITMENT_OUT], BaseElement::ONE);
        assert_eq!(cols[9][0], BaseElement::ONE);
    }

    #[test]
    fn is_boundary_includes_row_511() {
        // The single `if row < TRACE_LENGTH - 1` at transfer.rs:331 is what
        // forced C5_IS_BOUNDARY_COEFFS onto dense Horner. C7 must not have it.
        let cols = build_spend_periodic_columns();
        let tiled = materialise(&cols);
        assert_eq!(tiled[4][511], BaseElement::ONE);
        for cycle in 0..NUM_HASH_CYCLES {
            assert_eq!(tiled[4][cycle * HASH_CYCLE_LEN + 31], BaseElement::ONE);
        }
    }

    #[test]
    fn shared_periodic_columns_are_stride16_sparse() {
        // `eval_periodic_stride16_at_z` (verify.rs:1256-1302) is only correct
        // for columns whose interpolant over the 512-point domain has non-zero
        // coefficients ONLY at indices divisible by 16 — and its stride check
        // is a `debug_assert`, skipped in release. A column that quietly stops
        // being 32-periodic passes every test here and then fails on chain as
        // an opaque DeepAliFailed. Pin it.
        use winterfell::math::fft;

        let cols = build_spend_periodic_columns();
        let inv_twiddles = fft::get_inv_twiddles::<BaseElement>(TRACE_LENGTH);
        for (i, col) in cols.iter().enumerate().take(7) {
            let mut values: Vec<BaseElement> =
                (0..TRACE_LENGTH).map(|r| col[r % col.len()]).collect();
            fft::interpolate_poly(&mut values, &inv_twiddles);
            for (k, c) in values.iter().enumerate() {
                if k % 16 != 0 {
                    assert_eq!(
                        *c,
                        BaseElement::ZERO,
                        "periodic column {i} has a non-stride-16 coefficient at index {k}"
                    );
                }
            }
        }
    }

    #[test]
    fn boundary_spec_carries_neither_commitment_nor_leaf() {
        let (_, nullifier, root, commitment) = honest();
        let pi = pub_inputs(nullifier, root).to_vec();
        let assertions = spend_boundary_assertions(&pi);
        assert_eq!(assertions.len(), SPEND_NUM_BOUNDARY_ASSERTIONS);

        for (idx, &(col, row, source)) in SPEND_BOUNDARY_SPEC.iter().enumerate() {
            // Never the hold column, never the Merkle carry at row 0.
            assert_ne!(col, 9, "assertion {idx} targets the hold column");
            assert!(!(col == 5 && row == 0), "assertion {idx} targets the leaf");
            if let Some(i) = source {
                assert_ne!(pi[i], commitment, "assertion {idx} carries the commitment");
            }
        }
        // And the frozen order itself.
        assert_eq!(
            SPEND_BOUNDARY_SPEC,
            [
                (6, 30, Some(0)),
                (6, 64, Some(0)),
                (8, 0, None),
                (8, 32, None),
                (8, 64, None),
                (0, 478, Some(1)),
            ]
        );
    }

    #[test]
    #[should_panic(expected = "exactly 6 public inputs")]
    fn boundary_assertions_reject_an_arity_slip() {
        // compact.rs:1224's `pi()` and verify.rs's ladders both zero-fill
        // instead of erroring. This is the only guard.
        let _ = spend_boundary_assertions(&[BaseElement::ONE; 5]);
    }

    // ── the commitment formula ──────────────────────────────────────────

    #[test]
    fn compute_spend_values_delegates_to_the_c1_formula() {
        let (np, s, b, m) = (
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
        );
        let (nullifier, blind_hash, commitment) = compute_spend_values(np, s, b, m);
        let (c1_nullifier, c1_commitment) =
            crate::air::denominated_pool::compute_pool_values(np, s, b, m);
        assert_eq!(nullifier, c1_nullifier);
        assert_eq!(commitment, c1_commitment);
        assert_eq!(blind_hash, poseidon::hash2(b, m));
        assert_eq!(commitment, poseidon::hash2(nullifier, blind_hash));
    }

    /// The client's `createCommitmentV3`, reproduced argument for argument:
    /// truncate each input to its low 64 bits, reduce mod Goldilocks, then
    /// three `hash2` calls in this exact order. The truncation happens on the
    /// Rust side at the wasm i64 FFI boundary, where JS `ToBigInt64` wraps
    /// mod 2^64; `BaseElement::new` then reduces mod p.
    fn create_commitment_v3(np: u128, secret: u128, deposit_epoch: u128, token_mint: u128) -> BaseElement {
        let g = |x: u128| BaseElement::new(x as u64); // `as u64` == `& U64_MASK_V3`
        let nullifier = poseidon::hash2(g(np), g(secret));
        let epoch_hash = poseidon::hash2(g(deposit_epoch), g(token_mint));
        poseidon::hash2(nullifier, epoch_hash)
    }

    #[test]
    fn legacy_note_commitment_matches_create_commitment_v3() {
        // blinding = 42, i.e. a real small epoch. This is the note class that
        // has no other withdrawal route (leaf 30 of the 0.1 SOL pool).
        let expected = create_commitment_v3(
            NP as u128,
            SECRET as u128,
            LEGACY_BLINDING as u128,
            MINT as u128,
        );

        let (_, _, commitment) = compute_spend_values(
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
        );
        assert_eq!(commitment, expected, "C7 witness diverged from createCommitmentV3");

        // ... and the trace carries the same value in all three places that
        // matter: the commitment output, the hold column, and the leaf.
        let (trace, _, _, trace_commitment) = honest();
        assert_eq!(trace_commitment, expected);
        assert_eq!(trace[6][ROW_COMMITMENT_OUT], expected);
        assert_eq!(trace[9][0], expected);
        assert_eq!(trace[5][0], expected, "leaf must be the commitment");
    }

    #[test]
    fn commitment_matches_create_commitment_v3_under_u64_truncation() {
        // The clients hand over BN254-reduced 254-bit values and rely on the
        // wasm boundary wrapping mod 2^64. Widening the export signature to
        // "fix" the truncation would compute a different commitment from the
        // one in the tree for essentially every note.
        let big_np: u128 = (1u128 << 100) + 111;
        let big_secret: u128 = (1u128 << 90) + 222;
        let expected = create_commitment_v3(big_np, big_secret, 42, MINT as u128);
        let (_, _, commitment) = compute_spend_values(
            BaseElement::new(big_np as u64),
            BaseElement::new(big_secret as u64),
            BaseElement::new(42),
            BaseElement::new(MINT),
        );
        assert_eq!(commitment, expected);
    }

    #[test]
    fn blinding_slot_accepts_any_field_element() {
        // No range check, anywhere, ever. A 63-bit PRF blinding and a small
        // legacy epoch must both build a valid trace.
        let (elems, idx) = test_path();
        for blinding in [1u64, 42, (1u64 << 63) - 1, u64::MAX - 1] {
            let (trace, _, _) = build_spend_trace(
                BaseElement::new(NP),
                BaseElement::new(SECRET),
                BaseElement::new(blinding),
                BaseElement::new(MINT),
                &elems,
                &idx,
            );
            for (i, r) in eval_all(&trace).into_iter().enumerate() {
                for (c, v) in r.iter().enumerate() {
                    assert_eq!(*v, BaseElement::ZERO, "blinding {blinding}: constraint {c} at row {i}");
                }
            }
        }
    }

    // ── trace structure ─────────────────────────────────────────────────

    #[test]
    fn trace_shape_and_landmarks() {
        let (trace, nullifier, root, commitment) = honest();
        assert_eq!(trace.len(), TRACE_WIDTH);
        for col in &trace {
            assert_eq!(col.len(), TRACE_LENGTH);
        }
        assert_eq!(trace[6][ROW_NULLIFIER_OUT], nullifier);
        assert_eq!(trace[6][ROW_COMMIT_IN], nullifier, "cycle-2 left input");
        assert_eq!(trace[7][ROW_COMMIT_IN], trace[6][ROW_BLIND_HASH_OUT], "cycle-2 right input");
        assert_eq!(trace[8][0], BaseElement::ZERO);
        assert_eq!(trace[8][HASH_CYCLE_LEN], BaseElement::ZERO);
        assert_eq!(trace[8][2 * HASH_CYCLE_LEN], BaseElement::ZERO);
        assert_eq!(trace[6][ROW_COMMITMENT_OUT], commitment);
        assert_eq!(trace[0][ROW_MERKLE_ROOT_OUT], root);
        assert_eq!(trace[5][0], commitment, "leaf = commitment");

        // The independently computed root agrees.
        let (elems, idx) = test_path();
        assert_eq!(root, compute_spend_root(commitment, &elems, &idx));
    }

    #[test]
    fn both_pipelines_run_all_sixteen_genuine_cycles() {
        // If either pipeline stops hashing, the shared periodic columns stop
        // being 32-periodic and every one of them goes dense on chain.
        let (trace, _, root, _) = honest();

        // Commitment pipeline: every cycle start has capacity 0 and every
        // cycle's output row is a real Poseidon of its own inputs.
        for cycle in 0..NUM_HASH_CYCLES {
            let start = cycle * HASH_CYCLE_LEN;
            assert_eq!(trace[8][start], BaseElement::ZERO, "cycle {cycle} capacity");
            let out = poseidon::hash2(trace[6][start], trace[7][start]);
            assert_eq!(trace[6][start + NUM_ROUNDS], out, "commit cycle {cycle}");
        }

        // Merkle pipeline: same, including the 16th dummy level P(root, 0).
        for cycle in 0..NUM_HASH_CYCLES {
            let start = cycle * HASH_CYCLE_LEN;
            assert_eq!(trace[2][start], BaseElement::ZERO, "merkle cycle {cycle} capacity");
            let out = poseidon::hash2(trace[0][start], trace[1][start]);
            assert_eq!(trace[0][start + NUM_ROUNDS], out, "merkle cycle {cycle}");
        }
        let dummy_start = CANONICAL_DEPTH * HASH_CYCLE_LEN; // 480
        assert_eq!(trace[5][dummy_start], root, "carry@480 must be the root");
        assert_eq!(trace[3][dummy_start], BaseElement::ZERO, "dummy sibling");
        assert_eq!(trace[4][dummy_start], BaseElement::ZERO, "dummy direction");
        assert_eq!(trace[0][dummy_start], root);
        assert_eq!(trace[1][dummy_start], BaseElement::ZERO);
    }

    // ── the gate: honest trace satisfies every constraint ───────────────

    #[test]
    fn honest_trace_evaluates_every_constraint_to_zero() {
        let (trace, _, _, _) = honest();
        for (row, result) in eval_all(&trace).into_iter().enumerate() {
            for (c, v) in result.iter().enumerate() {
                assert_eq!(
                    *v,
                    BaseElement::ZERO,
                    "constraint {c} did not evaluate to ZERO at transition row {row}"
                );
            }
        }
    }

    #[test]
    fn honest_trace_satisfies_every_boundary_assertion() {
        let (trace, nullifier, root, _) = honest();
        let pi = pub_inputs(nullifier, root).to_vec();
        for (idx, &(col, row, source)) in SPEND_BOUNDARY_SPEC.iter().enumerate() {
            let expected = match source {
                Some(i) => pi[i],
                None => BaseElement::ZERO,
            };
            assert_eq!(trace[col][row], expected, "boundary assertion {idx}");
        }
    }

    // ── the leak, pinned ────────────────────────────────────────────────

    #[test]
    fn hold_column_is_constant_which_publishes_the_commitment() {
        // 🚨 This test does NOT assert a good property. It pins the fact that
        // constraint [15] makes col 9 a degree-0 polynomial, so its LDE value
        // is the commitment at all 8192 positions and the serializer emits it
        // verbatim in ood_current[9], ood_next[9] and every query's trace
        // values — ~46 plaintext copies in a blob uploaded as public
        // instruction data. C7 is NOT zero-knowledge. See the module docs.
        let (trace, _, _, commitment) = honest();
        assert!(
            trace[9].iter().all(|v| *v == commitment),
            "col 9 is constant by construction"
        );
        // Col 5 (the Merkle carry) additionally holds it on rows 0-31.
        for row in 0..HASH_CYCLE_LEN {
            assert_eq!(trace[5][row], commitment);
        }
    }

    // ── negative tests ──────────────────────────────────────────────────

    #[test]
    fn untied_hold_column_violates_constraint_16() {
        // Forgery 1 of the plan's Step 5: both Poseidon pipelines honest, but
        // col 9 pinned to a value that is NOT the commitment output at row 94,
        // and the Merkle leaf set to that value. Prove membership of a leaf
        // you did not compute.
        let (mut trace, _, _, commitment) = honest();
        let forged = commitment + BaseElement::ONE;
        for row in 0..TRACE_LENGTH {
            trace[9][row] = forged;
        }
        let results = eval_all(&trace);
        // [15] still holds — the column is still constant.
        assert!(results.iter().all(|r| r[15] == BaseElement::ZERO));
        // [16] fires at row 94.
        assert_ne!(results[ROW_COMMITMENT_OUT][16], BaseElement::ZERO);
        // [17] fires at row 0 as well, because the leaf still is the real
        // commitment.
        assert_ne!(results[0][17], BaseElement::ZERO);
    }

    #[test]
    fn leaf_not_equal_commitment_violates_constraint_17() {
        // Forgery 2: col 9 correctly equals the commitment, but the Merkle
        // carry at row 0 is a different leaf. This is "spend someone else's
        // note with your own nullifier" — the pool drain. Constraint [17] is
        // the ONLY thing that catches it: C7 drops C3's (col5, row0, leaf)
        // boundary assertion on purpose.
        let (mut trace, _, _, _) = honest();
        trace[5][0] = trace[5][0] + BaseElement::new(7);
        let results = eval_all(&trace);
        assert_ne!(results[0][17], BaseElement::ZERO, "[17] must reject a foreign leaf");
    }

    #[test]
    fn a_non_constant_hold_column_violates_constraint_15() {
        let (mut trace, _, _, _) = honest();
        trace[9][200] = trace[9][200] + BaseElement::ONE;
        let results = eval_all(&trace);
        assert_ne!(results[199][15], BaseElement::ZERO);
        assert_ne!(results[200][15], BaseElement::ZERO);
    }

    #[test]
    fn forged_blind_hash_violates_the_chain_constraint_14() {
        // Without [14], blind_hash is a free prover choice and the commitment
        // at row 94 is whatever the prover wants.
        let (mut trace, _, _, _) = honest();
        trace[7][ROW_COMMIT_IN] = trace[7][ROW_COMMIT_IN] + BaseElement::ONE;
        let results = eval_all(&trace);
        assert_ne!(results[ROW_CHAIN][14], BaseElement::ZERO);
    }

    #[test]
    fn non_binary_direction_bit_violates_constraint_10() {
        let (mut trace, _, _, _) = honest();
        for row in 0..HASH_CYCLE_LEN {
            trace[4][row] = BaseElement::new(2);
        }
        let results = eval_all(&trace);
        assert_ne!(results[0][10], BaseElement::ZERO);
    }

    #[test]
    fn sibling_mutated_mid_cycle_violates_constraint_8() {
        let (mut trace, _, _, _) = honest();
        trace[3][10] = trace[3][10] + BaseElement::ONE;
        let results = eval_all(&trace);
        // is_interior fires on the transitions into and out of row 10.
        assert_ne!(results[9][8], BaseElement::ZERO);
        assert_ne!(results[10][8], BaseElement::ZERO);
    }

    #[test]
    fn broken_carry_update_violates_constraint_6() {
        let (mut trace, _, _, _) = honest();
        // Rewrite the carry of Merkle level 1 so it is not level 0's output.
        for row in HASH_CYCLE_LEN..2 * HASH_CYCLE_LEN {
            trace[5][row] = trace[5][row] + BaseElement::ONE;
        }
        let results = eval_all(&trace);
        assert_ne!(results[HASH_CYCLE_LEN - 1][6], BaseElement::ZERO);
    }

    // ── winterfell round trip ───────────────────────────────────────────

    #[test]
    fn test_winterfell_proof() {
        // ⚠️ This exercises `default_proof_options()` — 32 queries, FRI max
        // remainder degree 31 — NOT the shipping compact geometry (22 queries,
        // ffps 32, merkle_depth 13). A green run proves the constraint system
        // is self-consistent and that the honest trace satisfies it. It proves
        // nothing about C7/C6 config distinguishability, the 22-query
        // soundness, or the on-chain CU.
        use crate::prover::{prove_generic, verify_generic};

        let (trace, nullifier, root, _) = honest();
        let pi = pub_inputs(nullifier, root);

        let (proof, _) = prove_generic::<SpendAir>(trace, pi.clone())
            .expect("C7 spend proof generation failed");
        verify_generic::<SpendAir>(proof, pi).expect("C7 spend proof verification failed");
    }

    #[test]
    fn test_wrong_nullifier_fails_prove() {
        // Cloned from denominated_pool.rs:451-483.
        use crate::prover::{prove_generic, verify_generic};

        let (trace, _, root, _) = honest();
        let wrong = pub_inputs(BaseElement::new(999), root);

        let result = std::panic::catch_unwind(|| {
            prove_generic::<SpendAir>(trace, wrong.clone())
        });

        match result {
            Err(_) => { /* prover panicked — acceptable */ }
            Ok(Err(_)) => { /* prover returned error — acceptable */ }
            Ok(Ok((proof, _))) => {
                let verify = verify_generic::<SpendAir>(proof, wrong);
                assert!(
                    verify.is_err(),
                    "Proof with wrong nullifier must fail either prove or verify"
                );
            }
        }
    }

    #[test]
    fn test_wrong_root_fails_prove() {
        use crate::prover::{prove_generic, verify_generic};

        let (trace, nullifier, _, _) = honest();
        let wrong = pub_inputs(nullifier, BaseElement::new(1234));

        let result = std::panic::catch_unwind(|| {
            prove_generic::<SpendAir>(trace, wrong.clone())
        });

        match result {
            Err(_) => {}
            Ok(Err(_)) => {}
            Ok(Ok((proof, _))) => {
                let verify = verify_generic::<SpendAir>(proof, wrong);
                assert!(verify.is_err(), "Proof with wrong root must fail");
            }
        }
    }

    #[test]
    fn test_forged_leaf_fails_prove() {
        // The pool drain, through the full winterfell path this time: the
        // trace is honest except that the Merkle pipeline proves membership of
        // a leaf that is not the commitment.
        use crate::prover::{prove_generic, verify_generic};

        let (elems, idx) = test_path();
        let (mut trace, nullifier, _, _) = honest();

        // Re-run the Merkle pipeline from a foreign leaf, leaving the
        // commitment pipeline and the hold column untouched.
        let foreign_leaf = BaseElement::new(0xdead_beef);
        let forged_root = compute_spend_root(foreign_leaf, &elems, &idx);

        // Swap the Merkle half for one rooted at the foreign leaf.
        let mut carry = foreign_leaf;
        for level in 0..CANONICAL_DEPTH {
            let sibling = elems[level];
            let dir = idx[level];
            let dir_felt = if dir == 0 { BaseElement::ZERO } else { BaseElement::ONE };
            let start = level * HASH_CYCLE_LEN;
            for row in start..start + HASH_CYCLE_LEN {
                trace[3][row] = sibling;
                trace[4][row] = dir_felt;
                trace[5][row] = carry;
            }
            let (l, r) = if dir == 0 { (carry, sibling) } else { (sibling, carry) };
            let mut state = [l, r, BaseElement::ZERO];
            trace[0][start] = state[0];
            trace[1][start] = state[1];
            trace[2][start] = state[2];
            let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
            let mds = &poseidon::constants::MDS_MATRIX_T3;
            for round in 0..NUM_ROUNDS {
                for i in 0..3 {
                    state[i] = state[i] + rc[round * 3 + i];
                }
                for s in &mut state {
                    let x = *s;
                    let x2 = x * x;
                    let x4 = x2 * x2;
                    *s = x4 * x2 * x;
                }
                let mut res = [BaseElement::ZERO; 3];
                for i in 0..3 {
                    for j in 0..3 {
                        res[i] = res[i] + mds[i][j] * state[j];
                    }
                }
                state = res;
                let row = start + round + 1;
                trace[0][row] = state[0];
                trace[1][row] = state[1];
                trace[2][row] = state[2];
            }
            trace[0][start + 31] = state[0];
            trace[1][start + 31] = state[1];
            trace[2][start + 31] = state[2];
            carry = state[0];
        }
        // 16th dummy cycle over the forged root.
        {
            let start = CANONICAL_DEPTH * HASH_CYCLE_LEN;
            for row in start..start + HASH_CYCLE_LEN {
                trace[3][row] = BaseElement::ZERO;
                trace[4][row] = BaseElement::ZERO;
                trace[5][row] = carry;
            }
            let mut state = [carry, BaseElement::ZERO, BaseElement::ZERO];
            trace[0][start] = state[0];
            trace[1][start] = state[1];
            trace[2][start] = state[2];
            let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
            let mds = &poseidon::constants::MDS_MATRIX_T3;
            for round in 0..NUM_ROUNDS {
                for i in 0..3 {
                    state[i] = state[i] + rc[round * 3 + i];
                }
                for s in &mut state {
                    let x = *s;
                    let x2 = x * x;
                    let x4 = x2 * x2;
                    *s = x4 * x2 * x;
                }
                let mut res = [BaseElement::ZERO; 3];
                for i in 0..3 {
                    for j in 0..3 {
                        res[i] = res[i] + mds[i][j] * state[j];
                    }
                }
                state = res;
                let row = start + round + 1;
                trace[0][row] = state[0];
                trace[1][row] = state[1];
                trace[2][row] = state[2];
            }
            trace[0][start + 31] = state[0];
            trace[1][start + 31] = state[1];
            trace[2][start + 31] = state[2];
        }

        // The AIR must reject: [17] ties col5@row0 to the hold column, which
        // still carries the real commitment.
        let results = eval_all(&trace);
        assert_ne!(results[0][17], BaseElement::ZERO);

        let pi = pub_inputs(nullifier, forged_root);
        let result = std::panic::catch_unwind(|| prove_generic::<SpendAir>(trace, pi.clone()));
        match result {
            Err(_) => {}
            Ok(Err(_)) => {}
            Ok(Ok((proof, _))) => {
                assert!(
                    verify_generic::<SpendAir>(proof, pi).is_err(),
                    "a forged leaf must not verify"
                );
            }
        }
    }
}
