//! Confidential Balance STARK AIR
//!
//! Proves a valid balance update without revealing amounts.
//! Handles 4 operations: DEPOSIT, WITHDRAW, SEND (private), RECEIVE (private).
//!
//! Computation (7 chained Poseidon_t3 hashes):
//!   Cycle 0: owner        = Poseidon(spending_key, 0)
//!   Cycle 1: owner_mint   = Poseidon(owner, token_mint)       — chained from cycle 0
//!   Cycle 2: amount_hash  = Poseidon(amount, amount_salt)     — independent
//!   Cycle 3: old_bal_salt = Poseidon(old_balance, old_salt)   — independent
//!   Cycle 4: old_commit   = Poseidon(old_bal_salt, owner_mint)— chained from cycles 1 & 3
//!   Cycle 5: new_bal_salt = Poseidon(new_balance, new_salt)   — independent
//!   Cycle 6: new_commit   = Poseidon(new_bal_salt, owner_mint)— chained from cycles 1 & 5
//!
//! Trace layout (committed width = 6, length = 512):
//!   cols 0-2: Poseidon state (t=3)
//!   col 3:    carry (holds owner_mint from cycle 1, reused in cycles 4 & 6)
//!   col 4:    ZK lift column (constrained by [10] alone, see `ZK_LIFT_COL`)
//!   col 5:    randomizer column (uniform on every row, enters no constraint)
//!   rows   0..223  the seven hash cycles, the witness
//!   rows 224..511  THE BLINDING REGION on cols 0..4, fresh CSPRNG per proof
//!
//! Conservation law enforced on-chain (not in AIR):
//!   old_balance + (1-is_debit)*amount + public_credit
//!     = new_balance + is_debit*amount + public_debit
//!
//! Public inputs: old_commitment, new_commitment, amount_hash, token_mint
//! Private inputs: spending_key, old_balance, old_salt, new_balance, new_salt,
//!                 amount, amount_salt
//!
//! # [ZK-MASK-C4 2026-09-11] Why this circuit grew from 256 to 512 rows
//!
//! `docs/AUDIT-2026-09-03.md` measured the leak on THIS circuit: the carry
//! column is a two-segment step whose second segment is `owner_mint`, the
//! proof publishes that column's OOD evaluation, and `owner_mint` comes out
//! with one field inversion. Until this date the eighth cycle was a dummy
//! `Poseidon(0, 0)` that filled the trace to a power of two and hid nothing.
//!
//! The remedy is the one C1 and C2 took, applied without variation: a ROW MASK
//! on the constrained columns from `FIRST_FREE_ROW` on (288 rows against the
//! `R = 4 * 22 + 2 = 90` openings a 22-query wire publishes), a RANDOMIZER
//! column (512 coefficients against the ~268 functionals the FRI/DEEP channel
//! publishes at 22 queries, MEASURED in `stark/tests/full_wire_ledger.rs`; 256
//! would be SHORT), and a LIFT column so the blinding reaches every quotient
//! block. The dummy cycle is gone: rows 224..511 are the mask.
//!
//! C4 moves to 22 queries with this change (was 27), the count C3, C5, C6 and
//! C7 already ship at, and to C7's terminal shape (`fri_final_poly_size` 32,
//! degree bound 2) so that a wire field a re-count cannot forge separates it
//! from C2, which shares its width and length. Soundness is floor-bound by the 64-bit field on every
//! circuit (`programs/p01_stark_verifier/tests/b2_bits_measured.rs`), so the
//! query term is not what binds; and 22 keeps C4's parser tuple distinct from
//! C2's, which shares its width and length.
//!
//! The witness rows do not move: every boundary assertion row is unchanged.

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;
use crate::BlindingMask;

// ============================================================================
// Constants
// ============================================================================

/// Columns the AIR constrains: three Poseidon state columns, the carry column,
/// and the lift column. The randomizer is committed but never read.
pub const CONSTRAINED_TRACE_WIDTH: usize = 5;

/// [ZK-LIFT-C4 2026-09-11] The column that carries the blinding region into
/// the quotient claims the row mask cannot reach. Twin of
/// `air::balance_proof::ZK_LIFT_COL`; the argument lives there and in
/// `air::spend::ZK_LIFT_COL`. Gate: `chain_01(x) * nba(x)`, one-hot at row 31
/// where `nba` is 0, so it vanishes on the whole trace domain and all 512
/// entries of the column are free. Degree 7 with two period-512 factors, the
/// shape the Poseidon rounds already carry, so the segment count and the FRI
/// rate do not move. `state0^6` is dense in `x`, which is what creates rank.
pub const ZK_LIFT_COL: usize = CONSTRAINED_TRACE_WIDTH - 1;

/// [ZK-RANDOMIZER-C4 2026-09-11] Uniform on ALL rows, read by no constraint.
pub const RANDOMIZER_COL: usize = CONSTRAINED_TRACE_WIDTH;

pub const TRACE_WIDTH: usize = CONSTRAINED_TRACE_WIDTH + 1;

/// 256 -> 512 on 2026-09-11. ⛔ HARD WIRE BREAK in both directions:
/// `num_fri_layers` 7 -> 8, `trace_width` 4 -> 6, `num_queries` 27 -> 22.
pub const TRACE_LENGTH: usize = 512;
pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;

/// The seven real hash cycles. The eighth, a `Poseidon(0, 0)` filler, is gone.
pub const NUM_HASH_CYCLES: usize = 7;

/// First trace row free on every constrained column.
pub const FIRST_FREE_ROW: usize = NUM_HASH_CYCLES * HASH_CYCLE_LEN; // 224

/// Blinding positions per constrained column: `512 - 224 = 288 > R = 90`.
pub const MASK_ROWS: usize = TRACE_LENGTH - FIRST_FREE_ROW; // 288

/// Rows of the lift column outside the row mask, all free (the gate vanishes
/// on the whole trace domain).
pub const LIFT_EXTRA_ROWS: usize = FIRST_FREE_ROW; // 224

/// Mask elements `build_confidential_balance_trace` requires, in this order:
///
/// ```text
///   [ 0 .. MASK_ROWS * CONSTRAINED_TRACE_WIDTH )   the row mask, row-major
///   [ that .. that + TRACE_LENGTH )                the randomizer column
///   [ that .. that + LIFT_EXTRA_ROWS )             the lift column, rows 0..224
/// ```
///
/// 288 * 5 + 512 + 224 = 2176.
pub const MASK_LEN: usize = MASK_ROWS * CONSTRAINED_TRACE_WIDTH + TRACE_LENGTH + LIFT_EXTRA_ROWS;

/// Number of transition constraints in C4. 10 -> 11 on 2026-09-11: [10] is the
/// ZK degree lift. ORDER IS FROZEN. Append only.
pub const CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS: usize = 11;

/// Number of periodic columns in C4. 11 -> 13 on 2026-09-11: `active` (11)
/// and `not_boundary_active` (12) appended. ORDER IS FROZEN. Append only.
pub const CONFIDENTIAL_BALANCE_NUM_PERIODIC: usize = 13;

// ============================================================================
// Public inputs
// ============================================================================

#[derive(Clone, Debug)]
pub struct ConfidentialBalancePublicInputs {
    pub old_commitment: BaseElement,
    pub new_commitment: BaseElement,
    pub amount_hash: BaseElement,
    pub token_mint: BaseElement,
}

impl ToElements<BaseElement> for ConfidentialBalancePublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.old_commitment,
            self.new_commitment,
            self.amount_hash,
            self.token_mint,
        ]
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct ConfidentialBalanceAir {
    context: AirContext<BaseElement>,
    old_commitment: BaseElement,
    new_commitment: BaseElement,
    amount_hash: BaseElement,
    token_mint: BaseElement,
}

impl Air for ConfidentialBalanceAir {
    type BaseField = BaseElement;
    type PublicInputs = ConfidentialBalancePublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        // [0-2]  Poseidon rounds: degree 7, gated by not_boundary_active and round_flag
        // [3-6]  one-hot chain / capture edges: degree 1
        // [7]    carry continuity: degree 1, gated by active and (1 - carry_capture)
        // [8-9]  one-hot carry -> right input edges: degree 1
        // [10]   ZK degree lift: degree 7, two period-512 gates
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
        ];

        let num_assertions = 12;
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            old_commitment: pub_inputs.old_commitment,
            new_commitment: pub_inputs.new_commitment,
            amount_hash: pub_inputs.amount_hash,
            token_mint: pub_inputs.token_mint,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_confidential_balance_periodic_columns()
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_confidential_balance_transition(
            frame.current(), frame.next(), periodic_values, result,
        );
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        vec![
            // Cycle 0: Poseidon(spending_key, 0)
            Assertion::single(1, 0, BaseElement::ZERO),
            Assertion::single(2, 0, BaseElement::ZERO),
            // Cycle 1: right input = token_mint
            Assertion::single(1, 32, self.token_mint),
            Assertion::single(2, 32, BaseElement::ZERO),
            // Capacities at cycle starts
            Assertion::single(2, 64, BaseElement::ZERO),
            Assertion::single(2, 96, BaseElement::ZERO),
            Assertion::single(2, 128, BaseElement::ZERO),
            Assertion::single(2, 160, BaseElement::ZERO),
            Assertion::single(2, 192, BaseElement::ZERO),
            // Output assertions
            Assertion::single(0, 2 * HASH_CYCLE_LEN + NUM_ROUNDS, self.amount_hash),
            Assertion::single(0, 4 * HASH_CYCLE_LEN + NUM_ROUNDS, self.old_commitment),
            Assertion::single(0, 6 * HASH_CYCLE_LEN + NUM_ROUNDS, self.new_commitment),
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
// Standalone periodic-column builder and transition evaluator, shared by the
// Winterfell AIR, the compact prover (`compute_quotient_lde_circuit_4`), the
// DEEP-ALI end-to-end test and the on-chain verifier's twin.
// ============================================================================

/// Build the 13 periodic columns for confidential_balance, every one at the
/// full `TRACE_LENGTH`.
///
/// Layout: `[rc0, rc1, rc2, round_flag, is_boundary, chain_01, chain_34,
/// chain_56, carry_capture, chain_carry_4, chain_carry_6, active,
/// not_boundary_active]`.
///
/// [ZK-MASK-C4 2026-09-11] `rc0..rc2` and `round_flag` are tiled 32-periodic
/// over the WHOLE trace: harmless across the mask (every reader is gated by
/// `not_boundary_active`), and stride-16 sparse once interpolated, so the
/// verifier pays 32 Horner steps per table instead of 512.
pub fn build_confidential_balance_periodic_columns() -> Vec<Vec<BaseElement>> {
    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    let mut rc0 = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut rc1 = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut rc2 = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut round_flag = vec![BaseElement::ZERO; TRACE_LENGTH];
    for row in 0..TRACE_LENGTH {
        let pos = row % HASH_CYCLE_LEN;
        if pos < NUM_ROUNDS {
            rc0[row] = rc[pos * 3];
            rc1[row] = rc[pos * 3 + 1];
            rc2[row] = rc[pos * 3 + 2];
            round_flag[row] = BaseElement::ONE;
        }
    }

    // is_boundary: 1 at the last row of each of the seven WITNESS cycles
    // (rows 31, 63, ..., 223). Read by no constraint since 2026-09-11.
    let mut is_boundary = vec![BaseElement::ZERO; TRACE_LENGTH];
    for cycle in 0..NUM_HASH_CYCLES {
        let row = cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1;
        if row < TRACE_LENGTH - 1 {
            is_boundary[row] = BaseElement::ONE;
        }
    }

    let make_flag = |row: usize| -> Vec<BaseElement> {
        let mut f = vec![BaseElement::ZERO; TRACE_LENGTH];
        f[row] = BaseElement::ONE;
        f
    };

    // chain_0_1: row 31 — cycle 0 output (owner) → cycle 1 left input.
    let chain_01 = make_flag(31);
    // chain_3_4: row 127 — cycle 3 output (old_bal_salt) → cycle 4 left.
    let chain_34 = make_flag(127);
    // chain_5_6: row 191 — cycle 5 output (new_bal_salt) → cycle 6 left.
    let chain_56 = make_flag(191);
    // carry_capture: row 63 — captures cycle 1 output (owner_mint) into col 3.
    let carry_capture = make_flag(63);
    // chain_carry_4: row 127 — carry (owner_mint) → cycle 4 right input.
    let chain_carry_4 = make_flag(127);
    // chain_carry_6: row 191 — carry (owner_mint) → cycle 6 right input.
    let chain_carry_6 = make_flag(191);

    // -- APPENDED 2026-09-11: the two gates that make the blinding region free --
    //
    // THE BOUND IS `FIRST_FREE_ROW - 1`. These are TRANSITION constraints: the
    // one at row 223 reads row 224, the first masked row; a gate left on there
    // would demand `mask[224][3] == owner_mint` and republish the secret inside
    // the blinding region.
    let mut active = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut not_boundary_active = vec![BaseElement::ZERO; TRACE_LENGTH];
    for row in 0..(FIRST_FREE_ROW - 1) {
        active[row] = BaseElement::ONE;
        if row % HASH_CYCLE_LEN != HASH_CYCLE_LEN - 1 {
            not_boundary_active[row] = BaseElement::ONE;
        }
    }

    vec![
        rc0, rc1, rc2, round_flag, is_boundary,          // 0-4
        chain_01, chain_34, chain_56,                     // 5-7
        carry_capture, chain_carry_4, chain_carry_6,      // 8-10
        active, not_boundary_active,                      // 11-12  APPENDED 2026-09-11
    ]
}

/// Evaluate the 11 transition constraints at a single row.
///
/// `current` / `next` must be length 6, `periodic` length 13, `result` length 11.
pub fn evaluate_confidential_balance_transition<E: FieldElement<BaseField = BaseElement>>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), TRACE_WIDTH);
    debug_assert_eq!(next.len(), TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), CONFIDENTIAL_BALANCE_NUM_PERIODIC);
    debug_assert_eq!(result.len(), CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_flag = periodic[3];
    // `nba` replaced its only use in the Poseidon gate; kept bound for layout.
    let _is_boundary = periodic[4];
    let chain_01 = periodic[5];
    let chain_34 = periodic[6];
    let chain_56 = periodic[7];
    let carry_capture = periodic[8];
    let chain_carry_4 = periodic[9];
    let chain_carry_6 = periodic[10];
    let active = periodic[11];
    let nba = periodic[12];

    // ── Poseidon round (t=3, MDS [3,1,1]) ──
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

    // Gated by `not_boundary_active`. 🚨 `E::ONE - is_boundary` MUST NOT COME
    // BACK HERE: it agrees with `nba` on the seven hash cycles and differs only
    // across rows 224..511, where it would re-impose `next = current` on the
    // blinding region. ⚠️ Exactly TWO periodic factors per line.
    result[0] = nba * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - round_flag * (ro2 - current[2]));

    // ── Chaining constraints ──
    result[3] = chain_01 * (next[0] - current[0]);       // cycle 0→1: owner
    result[4] = chain_34 * (next[0] - current[0]);       // cycle 3→4: old_bal_salt
    result[5] = chain_56 * (next[0] - current[0]);       // cycle 5→6: new_bal_salt
    result[6] = carry_capture * (next[3] - current[0]);  // capture owner_mint
    // carry continuity, INSIDE the witness region only. Without `active` this
    // line runs across rows 224..511 and pins every masked carry cell to
    // `owner_mint`.
    result[7] = active * (E::ONE - carry_capture) * (next[3] - current[3]);
    result[8] = chain_carry_4 * (next[1] - current[3]);  // carry→cycle 4 right
    result[9] = chain_carry_6 * (next[1] - current[3]);  // carry→cycle 6 right

    // ── [10] ZK degree lift, col `ZK_LIFT_COL`. Zero on the trace domain
    //    (chain_01 is one-hot at row 31, where nba = 0). 🚨 THE BASE IS RAW
    //    `current[0]`, never `s0`.
    let lift = current[0] * current[0] * current[0];
    result[10] = chain_01 * nba * current[ZK_LIFT_COL] * lift * lift;
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build trace for confidential balance proof.
///
/// Returns (trace, old_commitment, new_commitment, amount_hash).
///
/// `mask` is the blinding region: exactly `MASK_LEN` fresh uniform field
/// elements. The shipping path draws them from the OS CSPRNG and refuses to
/// build without one.
#[allow(clippy::too_many_arguments)]
pub fn build_confidential_balance_trace(
    spending_key: BaseElement,
    old_balance: BaseElement,
    old_salt: BaseElement,
    new_balance: BaseElement,
    new_salt: BaseElement,
    amount: BaseElement,
    amount_salt: BaseElement,
    token_mint: BaseElement,
    mask: &BlindingMask,
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement, BaseElement) {
    // [A8] The provenance lives in the type; the body below is unchanged.
    let mask: &[BaseElement] = mask.as_slice();
    assert_eq!(
        mask.len(),
        MASK_LEN,
        "C4 needs {MASK_LEN} blinding elements ({MASK_ROWS} rows x {CONSTRAINED_TRACE_WIDTH} constrained columns, then {TRACE_LENGTH} for the randomizer column, then {LIFT_EXTRA_ROWS} for the lift column's rows 0..{FIRST_FREE_ROW}), got {}",
        mask.len(),
    );
    let mut trace = vec![vec![BaseElement::ZERO; TRACE_LENGTH]; TRACE_WIDTH];

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mds = &poseidon::constants::MDS_MATRIX_T3;

    let run_hash = |trace: &mut Vec<Vec<BaseElement>>,
                    cycle: usize,
                    in0: BaseElement,
                    in1: BaseElement|
     -> BaseElement {
        let start = cycle * HASH_CYCLE_LEN;
        let mut state = [in0, in1, BaseElement::ZERO];

        trace[0][start] = state[0];
        trace[1][start] = state[1];
        trace[2][start] = state[2];

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
            trace[0][row] = state[0];
            trace[1][row] = state[1];
            trace[2][row] = state[2];
        }

        // Pad remaining row in cycle (identity)
        let pad = start + NUM_ROUNDS + 1;
        trace[0][pad] = state[0];
        trace[1][pad] = state[1];
        trace[2][pad] = state[2];

        state[0]
    };

    // Cycle 0: owner = Poseidon(spending_key, 0)
    let owner = run_hash(&mut trace, 0, spending_key, BaseElement::ZERO);
    // Cycle 1: owner_mint = Poseidon(owner, token_mint)
    let owner_mint = run_hash(&mut trace, 1, owner, token_mint);
    // Cycle 2: amount_hash = Poseidon(amount, amount_salt)
    let amount_hash = run_hash(&mut trace, 2, amount, amount_salt);
    // Cycle 3: old_bal_salt = Poseidon(old_balance, old_salt)
    let old_bal_salt = run_hash(&mut trace, 3, old_balance, old_salt);
    // Cycle 4: old_commitment = Poseidon(old_bal_salt, owner_mint)
    let old_commitment = run_hash(&mut trace, 4, old_bal_salt, owner_mint);
    // Cycle 5: new_bal_salt = Poseidon(new_balance, new_salt)
    let new_bal_salt = run_hash(&mut trace, 5, new_balance, new_salt);
    // Cycle 6: new_commitment = Poseidon(new_bal_salt, owner_mint)
    let new_commitment = run_hash(&mut trace, 6, new_bal_salt, owner_mint);

    // [ZK-MASK-C4] The dummy `Poseidon(0, 0)` of cycle 7 is GONE. Rows 224..
    // are the blinding region.

    // Carry column (col 3) over the WITNESS rows: 0 before capture, owner_mint after.
    for row in 0..FIRST_FREE_ROW {
        trace[3][row] = if row <= 63 { BaseElement::ZERO } else { owner_mint };
    }

    // -- THE BLINDING REGION, 2026-09-11 --
    for row in FIRST_FREE_ROW..TRACE_LENGTH {
        let base = (row - FIRST_FREE_ROW) * CONSTRAINED_TRACE_WIDTH;
        for col in 0..CONSTRAINED_TRACE_WIDTH {
            trace[col][row] = mask[base + col];
        }
    }

    // [ZK-RANDOMIZER] Every row.
    let randomizer_base = MASK_ROWS * CONSTRAINED_TRACE_WIDTH;
    for row in 0..TRACE_LENGTH {
        trace[RANDOMIZER_COL][row] = mask[randomizer_base + row];
    }

    // [ZK-LIFT] The lift column's rows inside the witness region.
    let lift_base = randomizer_base + TRACE_LENGTH;
    for row in 0..FIRST_FREE_ROW {
        trace[ZK_LIFT_COL][row] = mask[lift_base + row];
    }

    (trace, old_commitment, new_commitment, amount_hash)
}

/// Compute commitments without building trace.
#[allow(clippy::too_many_arguments)]
pub fn compute_confidential_balance(
    spending_key: BaseElement,
    old_balance: BaseElement,
    old_salt: BaseElement,
    new_balance: BaseElement,
    new_salt: BaseElement,
    amount: BaseElement,
    amount_salt: BaseElement,
    token_mint: BaseElement,
) -> (BaseElement, BaseElement, BaseElement) {
    let owner = poseidon::hash2(spending_key, BaseElement::ZERO);
    let owner_mint = poseidon::hash2(owner, token_mint);
    let amount_hash = poseidon::hash2(amount, amount_salt);
    let old_bal_salt = poseidon::hash2(old_balance, old_salt);
    let old_commitment = poseidon::hash2(old_bal_salt, owner_mint);
    let new_bal_salt = poseidon::hash2(new_balance, new_salt);
    let new_commitment = poseidon::hash2(new_bal_salt, owner_mint);
    (old_commitment, new_commitment, amount_hash)
}

/// Verify the conservation law (called off-chain or on-chain, not in AIR).
pub fn verify_conservation(
    old_balance: u64,
    new_balance: u64,
    amount: u64,
    is_debit: bool,
    public_credit: u64,
    public_debit: u64,
) -> bool {
    let private_credit = if is_debit { 0u64 } else { amount };
    let private_debit = if is_debit { amount } else { 0u64 };
    old_balance
        .wrapping_add(private_credit)
        .wrapping_add(public_credit)
        == new_balance
            .wrapping_add(private_debit)
            .wrapping_add(public_debit)
}

// ============================================================================
// Tests
// ============================================================================

/// A deterministic mask for the tests in this file. Adequate for trace SHAPE,
/// inadequate for any secrecy claim.
#[cfg(test)]
fn deterministic_test_mask_raw() -> Vec<BaseElement> {
    let mut z: u64 = 0xC4_5EED_0002;
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

    fn test_inputs() -> (BaseElement, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement) {
        (
            BaseElement::new(42),   // spending_key
            BaseElement::new(500),  // old_balance
            BaseElement::new(111),  // old_salt
            BaseElement::new(600),  // new_balance
            BaseElement::new(222),  // new_salt
            BaseElement::new(0),    // amount
            BaseElement::new(0),    // amount_salt
            BaseElement::new(999),  // token_mint
        )
    }

    fn build(
        sk: BaseElement, ob: BaseElement, os: BaseElement, nb: BaseElement, ns: BaseElement,
        a: BaseElement, as_: BaseElement, m: BaseElement,
    ) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement, BaseElement) {
        build_confidential_balance_trace(sk, ob, os, nb, ns, a, as_, m, &deterministic_test_mask())
    }

    #[test]
    fn test_compute_deterministic() {
        let (sk, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (oc1, nc1, ah1) = compute_confidential_balance(sk, ob, os, nb, ns, a, as_, m);
        let (oc2, nc2, ah2) = compute_confidential_balance(sk, ob, os, nb, ns, a, as_, m);
        assert_eq!(oc1, oc2);
        assert_eq!(nc1, nc2);
        assert_eq!(ah1, ah2);
    }

    #[test]
    fn test_trace_matches_compute() {
        let (sk, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (expected_oc, expected_nc, expected_ah) =
            compute_confidential_balance(sk, ob, os, nb, ns, a, as_, m);
        let (trace, oc, nc, ah) = build(sk, ob, os, nb, ns, a, as_, m);

        assert_eq!(oc, expected_oc);
        assert_eq!(nc, expected_nc);
        assert_eq!(ah, expected_ah);
        assert_eq!(trace[0][2 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_ah);
        assert_eq!(trace[0][4 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_oc);
        assert_eq!(trace[0][6 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_nc);
        assert_eq!(trace.len(), TRACE_WIDTH);
        assert_eq!(trace[0].len(), TRACE_LENGTH);
    }

    #[test]
    fn test_carry_column() {
        let (sk, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (trace, _, _, _) = build(sk, ob, os, nb, ns, a, as_, m);
        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, m);

        assert_eq!(trace[3][0], BaseElement::ZERO);
        assert_eq!(trace[3][63], BaseElement::ZERO);
        assert_eq!(trace[3][64], owner_mint);
        assert_eq!(trace[3][223], owner_mint);
        // The blinding region does NOT repeat it.
        let repeats = (FIRST_FREE_ROW..TRACE_LENGTH).filter(|&r| trace[3][r] == owner_mint).count();
        assert_eq!(repeats, 0, "{repeats} masked carry cells still carry owner_mint");
    }

    #[test]
    fn test_chaining() {
        let (sk, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (trace, _, _, _) = build(sk, ob, os, nb, ns, a, as_, m);
        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, m);

        assert_eq!(trace[0][NUM_ROUNDS], owner);
        assert_eq!(trace[0][32], owner);
        assert_eq!(trace[1][32], m);
        assert_eq!(trace[1][128], owner_mint);
        assert_eq!(trace[1][192], owner_mint);
    }

    /// Every constraint vanishes on every row of the honest trace, mask
    /// included; a corrupted witness cell is caught; a corrupted mask cell is not.
    #[test]
    fn every_constraint_vanishes_on_the_honest_trace_and_a_mutation_is_caught() {
        let (sk, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (trace, _, _, _) = build(sk, ob, os, nb, ns, a, as_, m);
        let periodic = build_confidential_balance_periodic_columns();
        assert_eq!(periodic.len(), CONFIDENTIAL_BALANCE_NUM_PERIODIC);

        let sweep = |trace: &Vec<Vec<BaseElement>>| -> Vec<(usize, usize)> {
            let mut bad = Vec::new();
            let mut current = vec![BaseElement::ZERO; TRACE_WIDTH];
            let mut next = vec![BaseElement::ZERO; TRACE_WIDTH];
            let mut p = vec![BaseElement::ZERO; CONFIDENTIAL_BALANCE_NUM_PERIODIC];
            let mut result = vec![BaseElement::ZERO; CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS];
            for row in 0..(TRACE_LENGTH - 1) {
                for c in 0..TRACE_WIDTH {
                    current[c] = trace[c][row];
                    next[c] = trace[c][row + 1];
                }
                for k in 0..CONFIDENTIAL_BALANCE_NUM_PERIODIC {
                    p[k] = periodic[k][row];
                }
                evaluate_confidential_balance_transition(&current, &next, &p, &mut result);
                for (i, r) in result.iter().enumerate() {
                    if *r != BaseElement::ZERO {
                        bad.push((row, i));
                    }
                }
            }
            bad
        };

        let bad = sweep(&trace);
        assert!(bad.is_empty(), "constraints violated at (row, constraint): {bad:?}");

        let mut mutated = trace.clone();
        mutated[3][150] = mutated[3][150] + BaseElement::ONE;
        assert!(!sweep(&mutated).is_empty(), "the sweep accepted a corrupted carry cell");

        let mut masked = trace.clone();
        masked[3][300] = masked[3][300] + BaseElement::ONE;
        masked[1][500] = masked[1][500] + BaseElement::new(7);
        masked[ZK_LIFT_COL][10] = masked[ZK_LIFT_COL][10] + BaseElement::new(9);
        assert!(sweep(&masked).is_empty(), "a constraint reaches into the blinding region or the lift column");
    }

    #[test]
    fn test_conservation_deposit() {
        assert!(verify_conservation(500, 600, 0, false, 100, 0));
    }

    #[test]
    fn test_conservation_withdraw() {
        assert!(verify_conservation(600, 550, 0, true, 0, 50));
    }

    #[test]
    fn test_conservation_send() {
        assert!(verify_conservation(600, 570, 30, true, 0, 0));
    }

    #[test]
    fn test_conservation_receive() {
        assert!(verify_conservation(200, 230, 30, false, 0, 0));
    }

    #[test]
    fn test_conservation_invalid() {
        assert!(!verify_conservation(500, 700, 0, false, 100, 0));
    }

    #[test]
    fn test_winterfell_proof_deposit() {
        use crate::prover::{prove_generic, verify_generic};

        let sk = BaseElement::new(42);
        let ob = BaseElement::new(500);
        let os = BaseElement::new(111);
        let nb = BaseElement::new(600);
        let ns = BaseElement::new(222);
        let m = BaseElement::new(999);

        let (trace, oc, nc, ah) = build(sk, ob, os, nb, ns, BaseElement::ZERO, BaseElement::ZERO, m);

        let pub_inputs = ConfidentialBalancePublicInputs {
            old_commitment: oc, new_commitment: nc, amount_hash: ah, token_mint: m,
        };

        let (proof, _) = prove_generic::<ConfidentialBalanceAir>(trace, pub_inputs.clone())
            .expect("Proof generation failed");
        verify_generic::<ConfidentialBalanceAir>(proof, pub_inputs)
            .expect("Proof verification failed");
    }

    #[test]
    fn test_winterfell_proof_send() {
        use crate::prover::{prove_generic, verify_generic};

        let sk = BaseElement::new(42);
        let (trace, oc, nc, ah) = build(
            sk, BaseElement::new(600), BaseElement::new(333),
            BaseElement::new(570), BaseElement::new(444),
            BaseElement::new(30), BaseElement::new(555), BaseElement::new(999));

        let pub_inputs = ConfidentialBalancePublicInputs {
            old_commitment: oc, new_commitment: nc, amount_hash: ah,
            token_mint: BaseElement::new(999),
        };

        let (proof, _) = prove_generic::<ConfidentialBalanceAir>(trace, pub_inputs.clone())
            .expect("Proof generation failed");
        verify_generic::<ConfidentialBalanceAir>(proof, pub_inputs)
            .expect("Proof verification failed");
    }

    #[test]
    fn test_different_keys_different_commitments() {
        let (_, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (oc1, nc1, _) = compute_confidential_balance(
            BaseElement::new(42), ob, os, nb, ns, a, as_, m);
        let (oc2, nc2, _) = compute_confidential_balance(
            BaseElement::new(43), ob, os, nb, ns, a, as_, m);
        assert_ne!(oc1, oc2);
        assert_ne!(nc1, nc2);
    }

    #[test]
    fn test_commitment_compatible_with_balance_proof() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let bp_commitment = crate::air::balance_proof::compute_balance_commitment(sk, bal, salt, mint);
        let (cb_old, _, _) = compute_confidential_balance(
            sk, bal, salt, BaseElement::new(0), BaseElement::new(0),
            BaseElement::new(0), BaseElement::new(0), mint);

        assert_eq!(bp_commitment, cb_old,
            "Commitment scheme must match balance_proof for interoperability");
    }
}
