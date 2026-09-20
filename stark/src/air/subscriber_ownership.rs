//! Subscriber Ownership STARK AIR
//!
//! Proves knowledge of `subscriber_secret` such that:
//!   Poseidon(subscriber_secret) == commitment
//!
//! This is the simplest Protocol 01 circuit — a direct port of
//! `circuits/subscriber_ownership.circom` to a STARK AIR.
//!
//! # Two shapes live in this file, and only one ships
//!
//! ## The LEGACY shape (`SubscriberOwnershipAir`, `build_trace`)
//!
//! Execution trace layout (width = 3, length = 32 rows):
//!   Row 0:     Initial Poseidon state [subscriber_secret, 0, 0]
//!   Rows 1-30: State after each Poseidon round (30 rounds total)
//!   Row 31:    Copy of row 30 (padding for power-of-2 trace length)
//!
//! ⛔ RETIRED FROM THE SHIPPING PATH ON 2026-09-11. Every committed value of
//! this trace is a deterministic function of the secret, and the wire publishes
//! `4 * 27 + 2 = 110` evaluations of a degree-31 column, so plain Lagrange
//! interpolation returns the secret: MEASURED by
//! `stark/tests/witness_recovery_positive_control.rs`, which is kept green ON
//! PURPOSE as the positive control of the masked shape below. The legacy
//! generator (`compact::generate_compact_proof`) and the legacy verifier path
//! stay compiled for that reason and for the soundness probes that drive them;
//! no client emits a legacy C0 proof any more.
//!
//! ## The MASKED shape (`SubscriberOwnershipMaskedAir`, `build_masked_trace`)
//!
//! [ZK-MASK-C0 2026-09-11] Trace layout (committed width = 5, length = 512):
//!   cols 0-2: Poseidon state, rows 0..31 exactly as above
//!   col 3:    ZK lift column (constrained by [3] alone, see `ZK_LIFT_COL`)
//!   col 4:    randomizer column (uniform on every row, enters no constraint)
//!   rows  32..511  THE BLINDING REGION on cols 0..3, fresh CSPRNG per proof
//!
//! Same structure as every other masked circuit (C1..C7): a row mask against
//! the `R = 4 * 22 + 2 = 90` openings a 22-query wire publishes (480 free rows,
//! margin 390), a randomizer column whose 512 coefficients cover the ~250
//! functionals the FRI/DEEP channel publishes (MEASURED,
//! `stark/tests/full_wire_ledger.rs`), and a lift column so the blinding
//! reaches every quotient block. It runs on the GENERIC compact pipeline
//! (`QuotientSpec::Circuit0`) with C7's terminal shape (ffps 32, bound 2) at 22
//! queries, so its parser tuple `(5, 13, 8, 22, 7, 32)` differs from C1's
//! `(5, 13, 8, 27, 8, 16)` in two fields a re-count cannot forge.
//!
//! The public input is unchanged (`commitment = trace[0][30]`), so
//! `pause_private_stark` / `resume_private_stark` and `p01_quantum_wallet`,
//! which read `sha256(commitment_le)` off the proof buffer, do not move.
//!
//! Transition constraints (masked shape):
//!   [0-2]  nba * (next - current - flag * (round_out - current))
//!   [3]    hold31 * nba * v * state0^6            (the ZK degree lift)
//!
//! Boundary constraints (both shapes):
//!   - state[0][1] = 0  (second input is zero for hash1)
//!   - state[0][2] = 0  (capacity is zero)
//!   - state[30][0] = commitment  (output matches public input)

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;
use crate::BlindingMask;

// ============================================================================
// Public inputs
// ============================================================================

/// Public inputs for the subscriber ownership proof.
#[derive(Clone, Debug)]
pub struct SubscriberOwnershipPublicInputs {
    /// The Poseidon commitment: Poseidon(subscriber_secret)
    pub commitment: BaseElement,
}

impl ToElements<BaseElement> for SubscriberOwnershipPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![self.commitment]
    }
}

// ============================================================================
// LEGACY AIR definition (retired from the shipping path, see the module doc)
// ============================================================================

/// Trace width: 3 columns (Poseidon state for t=3)
const TRACE_WIDTH: usize = 3;

/// Trace length: must be a power of 2 for FFT.
/// We need 31 rows (initial + 30 rounds), padded to 32.
const TRACE_LENGTH: usize = 32;

/// Number of Poseidon rounds for t=3: 4 full + 22 partial + 4 full = 30
/// For simplicity, all rounds use full S-box in this POC.
const NUM_ROUNDS: usize = 30;

pub struct SubscriberOwnershipAir {
    context: AirContext<BaseElement>,
    commitment: BaseElement,
}

impl Air for SubscriberOwnershipAir {
    type BaseField = BaseElement;
    type PublicInputs = SubscriberOwnershipPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH]),
        ];

        let num_assertions = 3; // s1[0]=0, s2[0]=0, s0[30]=commitment
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            commitment: pub_inputs.commitment,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    /// Provide round constants and round flag as periodic columns.
    ///
    /// Column layout (each has length TRACE_LENGTH = 32):
    ///   periodic_values[0] = RC0 (round constant for state[0])
    ///   periodic_values[1] = RC1 (round constant for state[1])
    ///   periodic_values[2] = RC2 (round constant for state[2])
    ///   periodic_values[3] = round_flag (1 for active rounds 0..29, 0 for padding 30..31)
    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

        let mut rc0 = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut rc1 = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut rc2 = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut flag = vec![BaseElement::ZERO; TRACE_LENGTH];

        for round in 0..NUM_ROUNDS {
            rc0[round] = rc[round * 3];
            rc1[round] = rc[round * 3 + 1];
            rc2[round] = rc[round * 3 + 2];
            flag[round] = BaseElement::ONE;
        }
        // rows 30..31: flag=0, rc=0 (padding, constraint reduces to next=current)

        vec![rc0, rc1, rc2, flag]
    }

    /// Transition constraints: enforce Poseidon round function between consecutive rows.
    ///
    /// result[i] = next[i] - current[i] - flag * (round_output[i] - current[i])
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
        let flag = periodic_values[3];

        let s0 = current[0] + rc0;
        let s1 = current[1] + rc1;
        let s2 = current[2] + rc2;

        let s0_7 = pow7(s0);
        let s1_7 = pow7(s1);
        let s2_7 = pow7(s2);

        let three = E::from(3u32);
        let round_out_0 = three * s0_7 + s1_7 + s2_7;
        let round_out_1 = s0_7 + three * s1_7 + s2_7;
        let round_out_2 = s0_7 + s1_7 + three * s2_7;

        result[0] = next[0] - current[0] - flag * (round_out_0 - current[0]);
        result[1] = next[1] - current[1] - flag * (round_out_1 - current[1]);
        result[2] = next[2] - current[2] - flag * (round_out_2 - current[2]);
    }

    /// Boundary constraints anchor the proof to public inputs.
    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        vec![
            Assertion::single(1, 0, BaseElement::ZERO),
            Assertion::single(2, 0, BaseElement::ZERO),
            Assertion::single(0, NUM_ROUNDS, self.commitment),
        ]
    }
}

#[inline(always)]
fn pow7<E: FieldElement>(x: E) -> E {
    let x2 = x * x;
    let x4 = x2 * x2;
    x4 * x2 * x
}

// ============================================================================
// LEGACY trace generation (prover side)
// ============================================================================

/// Build the LEGACY execution trace for subscriber ownership proof.
///
/// The trace is a 3-column matrix where each row represents the Poseidon state.
/// Row 0 is the initial state, rows 1..30 are after each round, row 31 is padding.
///
/// ⛔ This trace is recoverable from a published proof by interpolation; see the
/// module doc. It is the POSITIVE CONTROL for the masked shape, not a shipping
/// path.
pub fn build_trace(subscriber_secret: BaseElement) -> Vec<Vec<BaseElement>> {
    let mut trace = vec![vec![BaseElement::ZERO; TRACE_LENGTH]; TRACE_WIDTH];
    write_hash_cycle(&mut trace, subscriber_secret);
    trace
}

/// Rows 0..31 of columns 0..2: the initial state, 30 full-S-box rounds, and
/// the padding copy of row 30. Shared by both shapes so they cannot drift.
fn write_hash_cycle(trace: &mut [Vec<BaseElement>], subscriber_secret: BaseElement) {
    let mut state = [subscriber_secret, BaseElement::ZERO, BaseElement::ZERO];
    trace[0][0] = state[0];
    trace[1][0] = state[1];
    trace[2][0] = state[2];

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mds = &poseidon::constants::MDS_MATRIX_T3;

    for round in 0..NUM_ROUNDS {
        state[0] = state[0] + rc[round * 3];
        state[1] = state[1] + rc[round * 3 + 1];
        state[2] = state[2] + rc[round * 3 + 2];

        for s in &mut state {
            let x = *s;
            let x2 = x * x;
            let x4 = x2 * x2;
            *s = x4 * x2 * x; // x^7 = x^4 * x^2 * x
        }

        let mut result = [BaseElement::ZERO; 3];
        for i in 0..3 {
            for j in 0..3 {
                result[i] = result[i] + mds[i][j] * state[j];
            }
        }
        state = result;

        let row = round + 1;
        trace[0][row] = state[0];
        trace[1][row] = state[1];
        trace[2][row] = state[2];
    }

    // Pad row 31 with copy of row 30 (identity transition)
    trace[0][31] = state[0];
    trace[1][31] = state[1];
    trace[2][31] = state[2];
}

/// Compute the expected commitment for a given secret.
/// Uses the same full-round Poseidon as the trace builder.
pub fn compute_commitment(subscriber_secret: BaseElement) -> BaseElement {
    // Must match build_trace exactly
    let trace = build_trace(subscriber_secret);
    trace[0][NUM_ROUNDS]
}

// ============================================================================
// [ZK-MASK-C0 2026-09-11] THE MASKED SHAPE — the one that ships
// ============================================================================

/// Columns the masked AIR constrains: three Poseidon state columns and the
/// lift column. The randomizer is committed but never read.
pub const MASKED_CONSTRAINED_TRACE_WIDTH: usize = 4;

/// [ZK-LIFT-C0] The column that carries the blinding region into the quotient
/// claims the row mask cannot reach. Twin of `air::spend::ZK_LIFT_COL`; the
/// argument lives there. Gate: `hold31(x) * nba(x)`, one-hot at row 31 where
/// `nba` is 0, so it vanishes on the whole trace domain and all 512 entries of
/// the column are free. Degree 7 with two period-512 factors, so the segment
/// count and the FRI rate are those of every other masked circuit.
pub const ZK_LIFT_COL: usize = MASKED_CONSTRAINED_TRACE_WIDTH - 1;

/// [ZK-RANDOMIZER-C0] Uniform on ALL rows, read by no constraint.
pub const RANDOMIZER_COL: usize = MASKED_CONSTRAINED_TRACE_WIDTH;

/// Committed width of the masked trace.
pub const MASKED_TRACE_WIDTH: usize = MASKED_CONSTRAINED_TRACE_WIDTH + 1;

/// 32 -> 512. The witness is one hash cycle; everything after row 31 is mask.
pub const MASKED_TRACE_LENGTH: usize = 512;
pub const HASH_CYCLE_LEN: usize = 32;

/// First trace row free on every constrained column: the hash cycle ends at
/// row 31 (row 31 is the padding copy of row 30, inside the witness).
pub const FIRST_FREE_ROW: usize = HASH_CYCLE_LEN; // 32

/// Blinding positions per constrained column: `512 - 32 = 480 > R = 90`.
pub const MASK_ROWS: usize = MASKED_TRACE_LENGTH - FIRST_FREE_ROW; // 480

/// Rows of the lift column outside the row mask, all free (the gate vanishes
/// on the whole trace domain).
pub const LIFT_EXTRA_ROWS: usize = FIRST_FREE_ROW; // 32

/// Mask elements `build_masked_trace` requires, in this order:
///
/// ```text
///   [ 0 .. MASK_ROWS * MASKED_CONSTRAINED_TRACE_WIDTH )   the row mask, row-major
///   [ that .. that + MASKED_TRACE_LENGTH )                the randomizer column
///   [ that .. that + LIFT_EXTRA_ROWS )                    the lift column, rows 0..32
/// ```
///
/// 480 * 4 + 512 + 32 = 2464.
pub const MASK_LEN: usize =
    MASK_ROWS * MASKED_CONSTRAINED_TRACE_WIDTH + MASKED_TRACE_LENGTH + LIFT_EXTRA_ROWS;

/// Transition constraints of the masked shape: three Poseidon rows and the
/// lift. ORDER IS FROZEN -- the RLC uses `alpha^i` over this order.
pub const SUBSCRIBER_OWNERSHIP_NUM_CONSTRAINTS: usize = 4;

/// Periodic columns of the masked shape:
/// `[rc0, rc1, rc2, round_flag, not_boundary_active, hold31]`.
///
/// `rc*` and `round_flag` are tiled 32-periodic over the whole trace (stride-16
/// sparse once interpolated, 32 Horner steps on chain); `not_boundary_active`
/// is 1 on rows 0..30 and 0 from the last witness row on; `hold31` is the
/// one-hot at row 31 that gates the lift. ORDER IS FROZEN. Append only.
pub const SUBSCRIBER_OWNERSHIP_NUM_PERIODIC: usize = 6;

/// Build the 6 periodic columns of the masked shape at `trace_length` rows.
pub fn build_subscriber_ownership_periodic_columns(trace_length: usize) -> Vec<Vec<BaseElement>> {
    let tl = trace_length;
    assert!(tl >= FIRST_FREE_ROW && tl % HASH_CYCLE_LEN == 0);
    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    let mut rc0 = vec![BaseElement::ZERO; tl];
    let mut rc1 = vec![BaseElement::ZERO; tl];
    let mut rc2 = vec![BaseElement::ZERO; tl];
    let mut round_flag = vec![BaseElement::ZERO; tl];
    for row in 0..tl {
        let pos = row % HASH_CYCLE_LEN;
        if pos < NUM_ROUNDS {
            rc0[row] = rc[pos * 3];
            rc1[row] = rc[pos * 3 + 1];
            rc2[row] = rc[pos * 3 + 2];
            round_flag[row] = BaseElement::ONE;
        }
    }

    // THE BOUND IS `FIRST_FREE_ROW - 1`: the transition at row 31 reads row 32,
    // the first masked row, and must be free. Rows 0..30 are gated on; row 30
    // -> 31 is the identity (flag = 0) that makes row 31 the copy of row 30.
    let mut not_boundary_active = vec![BaseElement::ZERO; tl];
    for row in 0..(FIRST_FREE_ROW - 1) {
        not_boundary_active[row] = BaseElement::ONE;
    }

    let mut hold31 = vec![BaseElement::ZERO; tl];
    hold31[HASH_CYCLE_LEN - 1] = BaseElement::ONE;

    vec![rc0, rc1, rc2, round_flag, not_boundary_active, hold31]
}

/// Standalone evaluator of the masked shape's 4 constraints.
///
/// `current` / `next` must be length 5, `periodic` length 6, `result` length 4.
pub fn evaluate_subscriber_ownership_transition<E: FieldElement>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), MASKED_TRACE_WIDTH);
    debug_assert_eq!(next.len(), MASKED_TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), SUBSCRIBER_OWNERSHIP_NUM_PERIODIC);
    debug_assert_eq!(result.len(), SUBSCRIBER_OWNERSHIP_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let flag = periodic[3];
    let nba = periodic[4];
    let hold31 = periodic[5];

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

    // Gated by `not_boundary_active`. 🚨 An UNGATED form (the legacy AIR's) is
    // exactly what re-imposes `next = current` across rows 32..511 and pins
    // each column to the witness again. ⚠️ Exactly TWO periodic factors.
    result[0] = nba * (next[0] - current[0] - flag * (ro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - flag * (ro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - flag * (ro2 - current[2]));

    // [3] ZK degree lift. Zero on the trace domain (hold31 is one-hot at row 31,
    // where nba = 0). 🚨 THE BASE IS RAW `current[0]`, never `s0`.
    let lift = current[0] * current[0] * current[0];
    result[3] = hold31 * nba * current[ZK_LIFT_COL] * lift * lift;
}

/// The masked AIR, for the Winterfell round-trip tests. The compact pipeline
/// uses the standalone builder and evaluator above.
pub struct SubscriberOwnershipMaskedAir {
    context: AirContext<BaseElement>,
    commitment: BaseElement,
}

impl Air for SubscriberOwnershipMaskedAir {
    type BaseField = BaseElement;
    type PublicInputs = SubscriberOwnershipPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        let n = MASKED_TRACE_LENGTH;
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![n, n]),
            TransitionConstraintDegree::with_cycles(7, vec![n, n]),
            TransitionConstraintDegree::with_cycles(7, vec![n, n]),
            TransitionConstraintDegree::with_cycles(7, vec![n, n]),
        ];
        let context = AirContext::new(trace_info, degrees, 3, options);
        Self { context, commitment: pub_inputs.commitment }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_subscriber_ownership_periodic_columns(MASKED_TRACE_LENGTH)
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_subscriber_ownership_transition(frame.current(), frame.next(), periodic_values, result);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        vec![
            Assertion::single(1, 0, BaseElement::ZERO),
            Assertion::single(2, 0, BaseElement::ZERO),
            Assertion::single(0, NUM_ROUNDS, self.commitment),
        ]
    }
}

/// Build the MASKED trace: the legacy hash cycle in rows 0..31 of columns
/// 0..2, then the blinding region, the randomizer column and the lift column.
///
/// Returns `(trace, commitment)`. `mask` must hold exactly `MASK_LEN` fresh
/// uniform elements; the shipping path draws them from the OS CSPRNG and
/// refuses to build a proof without one.
pub fn build_masked_trace(
    subscriber_secret: BaseElement,
    mask: &BlindingMask,
) -> (Vec<Vec<BaseElement>>, BaseElement) {
    // [A8] The provenance lives in the type; the body below is unchanged.
    let mask: &[BaseElement] = mask.as_slice();
    assert_eq!(
        mask.len(),
        MASK_LEN,
        "C0 needs {MASK_LEN} blinding elements ({MASK_ROWS} rows x {MASKED_CONSTRAINED_TRACE_WIDTH} constrained columns, then {MASKED_TRACE_LENGTH} for the randomizer column, then {LIFT_EXTRA_ROWS} for the lift column's rows 0..{FIRST_FREE_ROW}), got {}",
        mask.len(),
    );
    let mut trace = vec![vec![BaseElement::ZERO; MASKED_TRACE_LENGTH]; MASKED_TRACE_WIDTH];
    write_hash_cycle(&mut trace, subscriber_secret);
    let commitment = trace[0][NUM_ROUNDS];

    // -- THE BLINDING REGION --
    for row in FIRST_FREE_ROW..MASKED_TRACE_LENGTH {
        let base = (row - FIRST_FREE_ROW) * MASKED_CONSTRAINED_TRACE_WIDTH;
        for col in 0..MASKED_CONSTRAINED_TRACE_WIDTH {
            trace[col][row] = mask[base + col];
        }
    }
    // [ZK-RANDOMIZER] Every row.
    let randomizer_base = MASK_ROWS * MASKED_CONSTRAINED_TRACE_WIDTH;
    for row in 0..MASKED_TRACE_LENGTH {
        trace[RANDOMIZER_COL][row] = mask[randomizer_base + row];
    }
    // [ZK-LIFT] Rows 0..32 of the lift column.
    let lift_base = randomizer_base + MASKED_TRACE_LENGTH;
    for row in 0..FIRST_FREE_ROW {
        trace[ZK_LIFT_COL][row] = mask[lift_base + row];
    }

    (trace, commitment)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
fn deterministic_test_mask_raw() -> Vec<BaseElement> {
    let mut z: u64 = 0xC0_5EED_0002;
    (0..MASK_LEN)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            BaseElement::new(z % 0xFFFF_FFFF_0000_0001)
        })
        .collect()
}

/// [A8] The same bytes, carried by the type the trace builders now demand.
#[cfg(test)]
fn deterministic_test_mask() -> crate::BlindingMask {
    crate::BlindingMask::from_raw_for_tests(deterministic_test_mask_raw())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trace_output_matches_commitment() {
        let secret = BaseElement::new(12345);
        let expected = compute_commitment(secret);
        let trace = build_trace(secret);
        assert_eq!(trace[0][NUM_ROUNDS], expected);
    }

    #[test]
    fn test_trace_initial_state() {
        let secret = BaseElement::new(42);
        let trace = build_trace(secret);
        assert_eq!(trace[0][0], secret);
        assert_eq!(trace[1][0], BaseElement::ZERO);
        assert_eq!(trace[2][0], BaseElement::ZERO);
    }

    #[test]
    fn test_trace_length_is_power_of_two() {
        let trace = build_trace(BaseElement::new(1));
        assert_eq!(trace[0].len(), 32);
        assert!(trace[0].len().is_power_of_two());
    }

    #[test]
    fn test_padding_row_is_copy() {
        let trace = build_trace(BaseElement::new(99));
        assert_eq!(trace[0][31], trace[0][30]);
        assert_eq!(trace[1][31], trace[1][30]);
        assert_eq!(trace[2][31], trace[2][30]);
    }

    /// The masked trace carries the legacy hash cycle verbatim and the same
    /// commitment, so the public input the on-chain consumers hash is unchanged.
    #[test]
    fn masked_trace_shares_the_witness_rows_and_the_commitment() {
        let secret = BaseElement::new(0x1234_5678);
        let legacy = build_trace(secret);
        let mask = deterministic_test_mask();
        let (masked, commitment) = build_masked_trace(secret, &mask);
        assert_eq!(commitment, compute_commitment(secret));
        assert_eq!(masked.len(), MASKED_TRACE_WIDTH);
        assert_eq!(masked[0].len(), MASKED_TRACE_LENGTH);
        for col in 0..3 {
            for row in 0..32 {
                assert_eq!(masked[col][row], legacy[col][row], "col {col} row {row}");
            }
        }
        // And the mask lands where the layout says.
        assert_eq!(masked[0][FIRST_FREE_ROW], mask.as_slice()[0]);
        assert_eq!(masked[ZK_LIFT_COL][FIRST_FREE_ROW], mask.as_slice()[ZK_LIFT_COL]);
        let rb = MASK_ROWS * MASKED_CONSTRAINED_TRACE_WIDTH;
        assert_eq!(masked[RANDOMIZER_COL][0], mask.as_slice()[rb]);
        assert_eq!(masked[ZK_LIFT_COL][0], mask.as_slice()[rb + MASKED_TRACE_LENGTH]);
        // No masked cell repeats the last witness row (the legacy leak shape).
        let repeats = (FIRST_FREE_ROW..MASKED_TRACE_LENGTH).filter(|&r| masked[0][r] == masked[0][31]).count();
        assert_eq!(repeats, 0);
    }

    /// Every constraint of the masked AIR vanishes on the honest trace, mask
    /// included; a corrupted witness cell is caught; a corrupted mask cell is not.
    #[test]
    fn masked_constraints_vanish_and_a_mutation_is_caught() {
        let secret = BaseElement::new(777);
        let (trace, _) = build_masked_trace(secret, &deterministic_test_mask());
        let periodic = build_subscriber_ownership_periodic_columns(MASKED_TRACE_LENGTH);
        let sweep = |trace: &Vec<Vec<BaseElement>>| -> Vec<(usize, usize)> {
            let mut bad = Vec::new();
            let mut cur = vec![BaseElement::ZERO; MASKED_TRACE_WIDTH];
            let mut nxt = vec![BaseElement::ZERO; MASKED_TRACE_WIDTH];
            let mut p = vec![BaseElement::ZERO; SUBSCRIBER_OWNERSHIP_NUM_PERIODIC];
            let mut r = vec![BaseElement::ZERO; SUBSCRIBER_OWNERSHIP_NUM_CONSTRAINTS];
            for row in 0..(MASKED_TRACE_LENGTH - 1) {
                for c in 0..MASKED_TRACE_WIDTH {
                    cur[c] = trace[c][row];
                    nxt[c] = trace[c][row + 1];
                }
                for k in 0..SUBSCRIBER_OWNERSHIP_NUM_PERIODIC {
                    p[k] = periodic[k][row];
                }
                evaluate_subscriber_ownership_transition(&cur, &nxt, &p, &mut r);
                for (i, v) in r.iter().enumerate() {
                    if *v != BaseElement::ZERO {
                        bad.push((row, i));
                    }
                }
            }
            bad
        };
        assert!(sweep(&trace).is_empty(), "violations: {:?}", sweep(&trace));
        let mut mutated = trace.clone();
        mutated[0][15] = mutated[0][15] + BaseElement::ONE;
        assert!(!sweep(&mutated).is_empty(), "a corrupted round row went unnoticed");
        let mut masked = trace.clone();
        masked[0][100] = masked[0][100] + BaseElement::ONE;
        masked[ZK_LIFT_COL][5] = masked[ZK_LIFT_COL][5] + BaseElement::new(9);
        masked[RANDOMIZER_COL][3] = masked[RANDOMIZER_COL][3] + BaseElement::new(9);
        assert!(sweep(&masked).is_empty(), "a constraint reaches into the blinding region");
    }

    #[test]
    fn masked_winterfell_proof_round_trips() {
        use crate::prover::{prove_generic, verify_generic};
        let secret = BaseElement::new(4242);
        let (trace, commitment) = build_masked_trace(secret, &deterministic_test_mask());
        let pub_inputs = SubscriberOwnershipPublicInputs { commitment };
        let (proof, _) = prove_generic::<SubscriberOwnershipMaskedAir>(trace, pub_inputs.clone())
            .expect("masked C0 proof generation failed");
        verify_generic::<SubscriberOwnershipMaskedAir>(proof, pub_inputs)
            .expect("masked C0 proof verification failed");
    }
}
