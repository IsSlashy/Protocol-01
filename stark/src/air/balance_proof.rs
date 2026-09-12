//! Balance Proof STARK AIR
//!
//! Proves "I have at least `threshold` tokens" without revealing actual balance.
//!
//! Computation (4 chained Poseidon_t3 hashes):
//!   owner      = Poseidon(spending_key, 0)         → cycle 0
//!   owner_mint = Poseidon(owner, token_mint)        → cycle 1 (chained from cycle 0)
//!   bal_salt   = Poseidon(balance, salt)            → cycle 2 (independent)
//!   commitment = Poseidon(bal_salt, owner_mint)     → cycle 3 (chained from cycles 1 & 2)
//!
//! Trace layout (committed width = 6, length = 512):
//!   col 0-2: Poseidon state
//!   col 3:   carry (holds owner_mint across cycle 2 → cycle 3)
//!   col 4:   ZK lift column (constrained by [7] alone, see `ZK_LIFT_COL`)
//!   col 5:   randomizer column (uniform on every row, enters no constraint)
//!   rows   0..127  the four hash cycles, the witness
//!   rows 128..511  THE BLINDING REGION on cols 0..4, fresh CSPRNG per proof
//!
//! Public inputs: commitment, token_mint
//! Private inputs: balance, salt, spending_key
//!
//! Balance range check: NOT done in the AIR — the on-chain program verifies
//! balance >= threshold directly (it knows the claimed balance from the
//! confidential account state). The proof only proves commitment validity.
//!
//! # [ZK-MASK-C2 2026-09-11] Why this circuit grew from 128 to 512 rows
//!
//! Until this date C2 had NO blinding region: its 128 rows were four hash
//! cycles and nothing else, every committed value was a deterministic function
//! of the witness, and `docs/AUDIT-2026-09-03.md` records the consequence on
//! the sibling circuit C4 -- the carry column is a two-segment step whose
//! second segment is `owner_mint`, the proof publishes that column's OOD
//! evaluation, and `owner_mint` comes out with one field inversion. C2 has the
//! identical carry column (rows 0..63 zero, rows 64..127 `owner_mint`).
//!
//! The remedy is the one C1 took (`air/denominated_pool.rs`), applied without
//! variation, because a variation is one more thing that can silently be wrong:
//!
//!   * a ROW MASK on the constrained columns from `FIRST_FREE_ROW` on. It needs
//!     `R = 4 * 27 + 2 = 110` free rows against the wire (four trace rows per
//!     query plus the two OOD frames), so 128 rows cannot host it and 256 would
//!     give 128 against 110 -- the margin C7 rejected. 512 gives 384.
//!   * a RANDOMIZER column, uniform on every row, read by no constraint, to
//!     cover the DEEP composition and the FRI layers (channel B of
//!     `stark/tests/full_wire_ledger.rs`). MEASURED 2026-09-11 on the wire
//!     ledger: a 27-query proof publishes 328 functionals on that channel, so
//!     the column needs more than 328 coefficients and 256 rows would be SHORT
//!     -- the state C1 was in at n = 256. 512 is the smallest power of two
//!     that covers it.
//!   * a LIFT column, so the blinding reaches every quotient block (the row
//!     mask only reaches the low ones, see `ZK_LIFT_COL`).
//!
//! The witness rows do not move: every boundary assertion row is unchanged,
//! so `get_boundary_assertions(2, ..)` in the verifier and
//! `boundary_assertions_for_circuit(2, ..)` in `compact.rs` are untouched.

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

/// Columns the AIR constrains: three Poseidon state columns, the carry column,
/// and the lift column. The randomizer is committed but never read.
pub const CONSTRAINED_TRACE_WIDTH: usize = 5;

/// [ZK-LIFT-C2 2026-09-11] The column that carries the blinding region into
/// the quotient claims the row mask cannot reach. Twin of
/// `air::denominated_pool::ZK_LIFT_COL` and `air::spend::ZK_LIFT_COL`.
///
/// The verifier checks ONE equation on the eight claims `Q_0(z)..Q_7(z)`, so a
/// simulator samples seven uniform and solves the eighth. The honest prover
/// cannot -- the coefficient split is unique -- so the forced seven have to look
/// uniform on their own, and a constraint linear in a column contributes only
/// a low-degree piece to `Q = C / Z_T`. The lift constraint fixes that:
///
/// ```text
///     chain_01(x) * nba(x) * v(x) * state0(x)^6
/// ```
///
///   * ZERO ON THE TRACE DOMAIN, because the gate is: `chain_01` is one-hot at
///     row 31, a cycle-boundary row where `nba` is 0, so the product vanishes
///     on every row and pins nothing. All 512 entries of the column are free.
///   * base degree 7 with TWO period-512 gates -- the shape the Poseidon rounds
///     already carry -- so `deg(C)` does not rise, `quotient_segments` stays 8,
///     `deg(D) = n - 2` stays and the FRI rate does not move.
///   * degree ONE in `v`, so every `Q_j(z)`, every committed quotient value and
///     every FRI layer value becomes affine in this column's blinding entries.
///     Affine with a non-zero slope in a uniform variable is EXACTLY uniform.
///
/// ⛔ THE LIFT FACTOR MUST BE DENSE IN `x`. `(x^n - c)^6` was drafted first on
/// C7 and measures rank 1 OF 7: a polynomial in `x^n` cannot smear across
/// segment boundaries. `state0^6` is dense, and density is what creates rank.
///
/// ⛔ IT IS NOT THE RANDOMIZER. That column is uniform on ALL rows precisely
/// because it is unconstrained everywhere, which is what covers the FRI
/// channel. Giving it this constraint would force it to zero on the
/// constrained rows and put that channel SHORT. Two columns, two jobs.
pub const ZK_LIFT_COL: usize = CONSTRAINED_TRACE_WIDTH - 1;

/// [ZK-RANDOMIZER-C2 2026-09-11] One extra committed column, uniform on ALL
/// rows, entering NO constraint. It puts randomness into the DEEP composition,
/// which the row mask never reaches.
pub const RANDOMIZER_COL: usize = CONSTRAINED_TRACE_WIDTH;

pub const TRACE_WIDTH: usize = CONSTRAINED_TRACE_WIDTH + 1;

/// 128 -> 512 on 2026-09-11. See the module doc for the two counts that force
/// it: 110 openings per column against the row mask, 328 published functionals
/// against the randomizer column.
///
/// ⛔ HARD WIRE BREAK in both directions with the pre-mask C2: `num_fri_layers`
/// goes 6 -> 8 and the parser checks it, `trace_width` goes 4 -> 6 and
/// `from_bytes` sizes every query block from it.
pub const TRACE_LENGTH: usize = 512;
pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;
pub const NUM_HASH_CYCLES: usize = 4;

/// First trace row free on every constrained column. The witness occupies
/// exactly four hash cycles and not one row more.
pub const FIRST_FREE_ROW: usize = NUM_HASH_CYCLES * HASH_CYCLE_LEN; // 128

/// Blinding positions per constrained column.
///
/// ```text
///   MASK_ROWS = 512 - 128 = 384
///   R         = 4 * 27 + 2 = 110      (C2 ships 27 queries)
///   384 > 110, margin 274.
/// ```
pub const MASK_ROWS: usize = TRACE_LENGTH - FIRST_FREE_ROW; // 384

/// Rows of the lift column outside the row mask, `0..FIRST_FREE_ROW`. All of
/// them are free because the gate of constraint [7] vanishes on the whole trace
/// domain. See `ZK_LIFT_COL`.
pub const LIFT_EXTRA_ROWS: usize = FIRST_FREE_ROW; // 128

/// Mask elements `build_balance_proof_trace` requires, in this order:
///
/// ```text
///   [ 0 .. MASK_ROWS * CONSTRAINED_TRACE_WIDTH )   the row mask, row-major
///   [ that .. that + TRACE_LENGTH )                the randomizer column
///   [ that .. that + LIFT_EXTRA_ROWS )             the lift column, rows 0..128
/// ```
///
/// 384 * 5 + 512 + 128 = 2560.
pub const MASK_LEN: usize = MASK_ROWS * CONSTRAINED_TRACE_WIDTH + TRACE_LENGTH + LIFT_EXTRA_ROWS;

/// Number of transition constraints in `evaluate_balance_proof_transition`.
///
/// 7 -> 8 on 2026-09-11: [7] is the ZK degree lift. ORDER IS FROZEN -- the RLC
/// uses `alpha^i` over this order. Append only.
pub const BALANCE_PROOF_NUM_CONSTRAINTS: usize = 8;

/// Number of periodic columns in `build_balance_proof_periodic_columns`.
///
/// Layout: `[rc0, rc1, rc2, round_flag, chain_01, carry_capture, chain_carry,
/// is_boundary, active, not_boundary_active]`.
///
/// 8 -> 10 on 2026-09-11. ORDER IS FROZEN -- the coefficient emitter indexes
/// positionally. Append only, never insert.
///
/// ⚠️ TWO NEW COLUMNS, not one as on C1. C1's only non-Poseidon constraint is a
/// one-hot chain, already zero across the mask, so the pre-multiplied
/// `not_boundary_active` alone sufficed. C2 has a carry-continuity constraint
/// ([5]) that fires on EVERY row, so it needs `active` on its own to switch off
/// across the blinding region; without that gate every masked cell of col 3
/// would be forced equal to the last witness value and the column would
/// collapse to one unknown again.
pub const BALANCE_PROOF_NUM_PERIODIC: usize = 10;

// ============================================================================
// Public inputs
// ============================================================================

#[derive(Clone, Debug)]
pub struct BalanceProofPublicInputs {
    pub commitment: BaseElement,
    pub token_mint: BaseElement,
}

impl ToElements<BaseElement> for BalanceProofPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![self.commitment, self.token_mint]
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct BalanceProofAir {
    context: AirContext<BaseElement>,
    commitment: BaseElement,
    token_mint: BaseElement,
}

impl Air for BalanceProofAir {
    type BaseField = BaseElement;
    type PublicInputs = BalanceProofPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        // Constraints:
        // [0-2] Poseidon round: degree 7, gated by not_boundary_active and round_flag
        // [3]   Chain cycle 0→1: degree 1, one-hot chain_01
        // [4]   Carry capture at cycle 1 boundary: degree 1, one-hot carry_capture
        // [5]   Carry continuity: degree 1, gated by active and (1 - carry_capture)
        // [6]   Chain carry → cycle 3 right input: degree 1, one-hot chain_carry
        // [7]   ZK degree lift, col `ZK_LIFT_COL`: degree 7, two period-512 gates
        //
        // Every periodic column is materialised at the full trace length, so
        // every cycle declared here is TRACE_LENGTH.
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
        ];

        // Assertions (unchanged by the mask; every row is inside the witness):
        // 1. col[1] at row 0  = 0  (spending_key hash: second input = 0)
        // 2. col[2] at row 0  = 0  (capacity)
        // 3. col[1] at row 32 = token_mint  (cycle 1 right input)
        // 4. col[2] at row 32 = 0  (capacity)
        // 5. col[2] at row 64 = 0  (capacity)
        // 6. col[2] at row 96 = 0  (capacity)
        // 7. col[0] at row 126 = commitment  (final output)
        let num_assertions = 7;
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            commitment: pub_inputs.commitment,
            token_mint: pub_inputs.token_mint,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_balance_proof_periodic_columns(TRACE_LENGTH)
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_balance_proof_transition(frame.current(), frame.next(), periodic_values, result);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        vec![
            // Cycle 0: Poseidon(spending_key, 0, 0) — second input and capacity are 0
            Assertion::single(1, 0, BaseElement::ZERO),
            Assertion::single(2, 0, BaseElement::ZERO),
            // Cycle 1: right input = token_mint
            Assertion::single(1, 32, self.token_mint),
            // Capacities at cycle starts
            Assertion::single(2, 32, BaseElement::ZERO),
            Assertion::single(2, 64, BaseElement::ZERO),
            Assertion::single(2, 96, BaseElement::ZERO),
            // Final commitment output
            Assertion::single(0, 3 * HASH_CYCLE_LEN + NUM_ROUNDS, self.commitment),
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
// Standalone periodic column builder and transition evaluator.
// ============================================================================

/// Build the 10 periodic columns used by circuit 2 (balance_proof), every one
/// materialised at `trace_length` rows.
///
/// Exposed so the prover can interpolate / inverse-NTT them for LDE and OOD
/// DEEP-ALI evaluations outside the AIR. Mirrors `BalanceProofAir::
/// get_periodic_column_values` byte-for-byte.
///
/// Layout: `[rc0, rc1, rc2, round_flag, chain_01, carry_capture, chain_carry,
/// is_boundary, active, not_boundary_active]`.
///
/// [ZK-MASK-C2 2026-09-11] `rc0..rc2` and `round_flag` are tiled 32-periodic
/// over the WHOLE trace, not truncated at the walk. Their values across the
/// blinding rows are harmless -- every constraint that reads them is gated by
/// `not_boundary_active`, which is zero there -- and a 32-periodic column
/// interpolated over 512 rows is stride-16 sparse, so the on-chain verifier
/// evaluates it with 32 Horner steps instead of 512. Truncating at row 128
/// would make the same four tables dense and cost a MEASURED ~100k CU each
/// (the C6 depth-15 lesson, `air/spend.rs` module doc).
pub fn build_balance_proof_periodic_columns(trace_length: usize) -> Vec<Vec<BaseElement>> {
    let tl = trace_length;
    assert!(
        tl >= FIRST_FREE_ROW && tl % HASH_CYCLE_LEN == 0,
        "C2 periodic columns need a trace of at least {FIRST_FREE_ROW} rows in whole hash cycles; got {tl}",
    );

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    let mut rc0 = vec![BaseElement::ZERO; tl];
    let mut rc1 = vec![BaseElement::ZERO; tl];
    let mut rc2 = vec![BaseElement::ZERO; tl];
    let mut round_flag = vec![BaseElement::ZERO; tl];

    // 32-periodic over the whole trace (see the doc above).
    for row in 0..tl {
        let pos = row % HASH_CYCLE_LEN;
        if pos < NUM_ROUNDS {
            rc0[row] = rc[pos * 3];
            rc1[row] = rc[pos * 3 + 1];
            rc2[row] = rc[pos * 3 + 2];
            round_flag[row] = BaseElement::ONE;
        }
    }

    // chain_01: 1 at row 31 — cycle 0 output feeds cycle 1 left input.
    let mut chain_01 = vec![BaseElement::ZERO; tl];
    chain_01[HASH_CYCLE_LEN - 1] = BaseElement::ONE;

    // carry_capture: 1 at row 63 — captures owner_mint into col[3].
    let mut carry_capture = vec![BaseElement::ZERO; tl];
    carry_capture[2 * HASH_CYCLE_LEN - 1] = BaseElement::ONE;

    // chain_carry: 1 at row 95 — carry (owner_mint) feeds cycle 3 right input.
    let mut chain_carry = vec![BaseElement::ZERO; tl];
    chain_carry[3 * HASH_CYCLE_LEN - 1] = BaseElement::ONE;

    // is_boundary: 1 at the last row of each of the four WITNESS hash cycles.
    // Read by no constraint since 2026-09-11 (`not_boundary_active` replaced
    // its only use); kept at its frozen index so the layout does not move.
    let mut is_boundary = vec![BaseElement::ZERO; tl];
    for cycle in 0..NUM_HASH_CYCLES {
        let row = cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1;
        if row < tl - 1 {
            is_boundary[row] = BaseElement::ONE;
        }
    }

    // -- APPENDED 2026-09-11: the two gates that make the blinding region free --
    //
    // THE BOUND IS `FIRST_FREE_ROW - 1`, NOT `FIRST_FREE_ROW`. These are
    // TRANSITION constraints: the one at row i reads row i+1. Row 127 is the
    // last witness row, so a gate left on there would relate real state to the
    // first masked row -- for [5] it would demand `mask[128][3] == owner_mint`,
    // unsatisfiable with fresh randomness, and if it were satisfiable it would
    // republish `owner_mint` inside the blinding region.
    //
    // `not_boundary_active` is `active` pre-multiplied with `not_boundary`, as a
    // SEPARATE column rather than a product in the constraint body: the degree-7
    // Poseidon constraints may carry exactly TWO periodic factors and they
    // already spend both. A third takes ce_blowup_factor from 8 to 16.
    let mut active = vec![BaseElement::ZERO; tl];
    let mut not_boundary_active = vec![BaseElement::ZERO; tl];
    for row in 0..(FIRST_FREE_ROW - 1) {
        active[row] = BaseElement::ONE;
        if row % HASH_CYCLE_LEN != HASH_CYCLE_LEN - 1 {
            not_boundary_active[row] = BaseElement::ONE;
        }
    }

    vec![
        rc0,                 // 0
        rc1,                 // 1
        rc2,                 // 2
        round_flag,          // 3
        chain_01,            // 4
        carry_capture,       // 5
        chain_carry,         // 6
        is_boundary,         // 7  (unused by the body since 2026-09-11)
        active,              // 8  APPENDED 2026-09-11
        not_boundary_active, // 9  APPENDED 2026-09-11
    ]
}

/// Standalone evaluator for circuit 2 transition constraints.
///
/// Mirrors `BalanceProofAir::evaluate_transition` so the prover can evaluate
/// the same 8 constraints at LDE and OOD points without instantiating the AIR.
/// `current` / `next` must be length 6, `periodic` length 10, `result` length 8.
///
/// Periodic layout: `[rc0, rc1, rc2, round_flag, chain_01, carry_capture,
/// chain_carry, is_boundary, active, not_boundary_active]`.
pub fn evaluate_balance_proof_transition<E: FieldElement>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), TRACE_WIDTH);
    debug_assert_eq!(next.len(), TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), BALANCE_PROOF_NUM_PERIODIC);
    debug_assert_eq!(result.len(), BALANCE_PROOF_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_flag = periodic[3];
    let chain_01 = periodic[4];
    let carry_capture = periodic[5];
    let chain_carry = periodic[6];
    // Still bound so the layout comment above matches the code; `nba` replaced
    // its only use in the Poseidon gate.
    let _is_boundary = periodic[7];
    let active = periodic[8];
    let nba = periodic[9];

    // ── Poseidon round (cols 0-2) ──
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

    // Gated by `not_boundary_active`, which is `not_boundary` AND `active`.
    //
    // 🚨 `E::ONE - is_boundary` MUST NOT COME BACK HERE. It and `nba` agree on
    // every row of the four hash cycles and differ only across rows 128..511,
    // so the substitution rejects NO honest proof, passes every existing test,
    // and silently re-imposes `next[i] - current[i] = 0` on the 384 blinding
    // rows -- the degenerate form that pins each column to a single unknown.
    //
    // ⚠️ COUNT THE PERIODIC FACTORS BEFORE EDITING. Each of these three lines
    // carries exactly TWO, `nba` and `round_flag`, over a degree-7 body. A
    // third takes ce_blowup_factor from 8 to 16.
    result[0] = nba * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - round_flag * (ro2 - current[2]));

    // ── Chain row 31: next[0]@32 = current[0]@31 (= owner) ──
    result[3] = chain_01 * (next[0] - current[0]);

    // ── Carry capture row 63: next[3]@64 = current[0]@63 (= owner_mint) ──
    result[4] = carry_capture * (next[3] - current[0]);

    // ── Carry continuity: col[3] constant except at the capture row, and
    //    ONLY inside the witness region. Without `active` this line would run
    //    across rows 128..511 and pin every masked carry cell to `owner_mint`.
    result[5] = active * (E::ONE - carry_capture) * (next[3] - current[3]);

    // ── Chain carry row 95: next[1]@96 = current[3]@95 (= owner_mint) ──
    result[6] = chain_carry * (next[1] - current[3]);

    // ── [7] ZK degree lift, col `ZK_LIFT_COL`. See the constant's doc. ──
    //
    // Zero on the trace domain because the gate is: `chain_01` is one-hot at
    // row 31 and `nba` is zero there. Its whole job is to be degree 1 in `v`
    // and degree 7 overall, so the lift reaches every quotient block.
    //
    // 🚨 THE BASE IS RAW `current[0]`, never `s0`: `s0` is the round input
    // `current[0] + rc0`, and the verifier twin evaluates `ood_current[0]`.
    let lift = current[0] * current[0] * current[0];
    result[7] = chain_01 * nba * current[ZK_LIFT_COL] * lift * lift;
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build trace for balance proof.
///
/// Returns (trace, commitment) where commitment = Poseidon(Poseidon(balance, salt), Poseidon(owner, token_mint)).
///
/// `mask` is the blinding region: exactly `MASK_LEN` fresh uniform field
/// elements, laid out as the constant documents. The shipping path draws them
/// from the OS CSPRNG (`crate::draw_blinding_mask`) and refuses to build a
/// proof without one.
pub fn build_balance_proof_trace(
    spending_key: BaseElement,
    balance: BaseElement,
    salt: BaseElement,
    token_mint: BaseElement,
    mask: &[BaseElement],
) -> (Vec<Vec<BaseElement>>, BaseElement) {
    assert_eq!(
        mask.len(),
        MASK_LEN,
        "C2 needs {MASK_LEN} blinding elements ({MASK_ROWS} rows x {CONSTRAINED_TRACE_WIDTH} constrained columns, then {TRACE_LENGTH} for the randomizer column, then {LIFT_EXTRA_ROWS} for the lift column's rows 0..{FIRST_FREE_ROW}), got {}",
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

    // Cycle 2: bal_salt = Poseidon(balance, salt)
    let bal_salt = run_hash(&mut trace, 2, balance, salt);

    // Cycle 3: commitment = Poseidon(bal_salt, owner_mint)
    let commitment = run_hash(&mut trace, 3, bal_salt, owner_mint);

    // Fill carry column (col 3) over the WITNESS rows only:
    // Rows 0-63: carry = 0 (unused, captured at row 63)
    // Rows 64-127: carry = owner_mint
    for row in 0..(2 * HASH_CYCLE_LEN) {
        trace[3][row] = BaseElement::ZERO;
    }
    for row in (2 * HASH_CYCLE_LEN)..FIRST_FREE_ROW {
        trace[3][row] = owner_mint;
    }

    // -- THE BLINDING REGION, 2026-09-11 --
    //
    // Rows 128..511 of every constrained column are fresh uniform values, one
    // unknown per cell. Before this date the trace ENDED at row 127 and the
    // carry column was a two-segment step: 2 unknowns against 110 published
    // openings, solved by one field inversion. Now it is 2 + 384 unknowns.
    for row in FIRST_FREE_ROW..TRACE_LENGTH {
        let base = (row - FIRST_FREE_ROW) * CONSTRAINED_TRACE_WIDTH;
        for col in 0..CONSTRAINED_TRACE_WIDTH {
            trace[col][row] = mask[base + col];
        }
    }

    // [ZK-RANDOMIZER] Every row, not only the free ones — what it masks is `D`,
    // built from the whole LDE of every column.
    let randomizer_base = MASK_ROWS * CONSTRAINED_TRACE_WIDTH;
    for row in 0..TRACE_LENGTH {
        trace[RANDOMIZER_COL][row] = mask[randomizer_base + row];
    }

    // [ZK-LIFT] The lift column's remaining rows. Its gate vanishes on the
    // whole trace domain, so every row is free; rows `FIRST_FREE_ROW..` were
    // filled by the row mask above.
    let lift_base = randomizer_base + TRACE_LENGTH;
    for row in 0..FIRST_FREE_ROW {
        trace[ZK_LIFT_COL][row] = mask[lift_base + row];
    }

    (trace, commitment)
}

/// Compute commitment without building trace.
pub fn compute_balance_commitment(
    spending_key: BaseElement,
    balance: BaseElement,
    salt: BaseElement,
    token_mint: BaseElement,
) -> BaseElement {
    let owner = poseidon::hash2(spending_key, BaseElement::ZERO);
    let owner_mint = poseidon::hash2(owner, token_mint);
    let bal_salt = poseidon::hash2(balance, salt);
    poseidon::hash2(bal_salt, owner_mint)
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
fn deterministic_test_mask() -> Vec<BaseElement> {
    let mut z: u64 = 0xC2_5EED_0002;
    (0..MASK_LEN)
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

    #[test]
    fn test_compute_commitment_deterministic() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let c1 = compute_balance_commitment(sk, bal, salt, mint);
        let c2 = compute_balance_commitment(sk, bal, salt, mint);
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_trace_matches_compute() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let expected = compute_balance_commitment(sk, bal, salt, mint);
        let (trace, commitment) = build_balance_proof_trace(sk, bal, salt, mint, &deterministic_test_mask());

        assert_eq!(commitment, expected);
        assert_eq!(trace[0][3 * HASH_CYCLE_LEN + NUM_ROUNDS], expected);
        assert_eq!(trace.len(), TRACE_WIDTH);
        assert_eq!(trace[0].len(), TRACE_LENGTH);
    }

    #[test]
    fn test_carry_column() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let (trace, _) = build_balance_proof_trace(sk, bal, salt, mint, &deterministic_test_mask());

        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, mint);

        // Carry should be 0 for rows 0-63, owner_mint for rows 64-127
        assert_eq!(trace[3][0], BaseElement::ZERO);
        assert_eq!(trace[3][63], BaseElement::ZERO);
        assert_eq!(trace[3][64], owner_mint);
        assert_eq!(trace[3][127], owner_mint);
    }

    /// The pre-mask C2 published `owner_mint` on every row past 63, so the
    /// carry column was two unknowns. The blinding region must NOT repeat it.
    #[test]
    fn the_blinding_region_does_not_repeat_the_carry() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);
        let mask = deterministic_test_mask();
        let (trace, _) = build_balance_proof_trace(sk, bal, salt, mint, &mask);

        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, mint);

        let repeats = (FIRST_FREE_ROW..TRACE_LENGTH)
            .filter(|&r| trace[3][r] == owner_mint)
            .count();
        assert_eq!(repeats, 0, "{repeats} masked carry cells still carry owner_mint");

        // And the mask lands where the layout says it does.
        assert_eq!(trace[0][FIRST_FREE_ROW], mask[0]);
        assert_eq!(trace[ZK_LIFT_COL][FIRST_FREE_ROW], mask[ZK_LIFT_COL]);
        let randomizer_base = MASK_ROWS * CONSTRAINED_TRACE_WIDTH;
        assert_eq!(trace[RANDOMIZER_COL][0], mask[randomizer_base]);
        assert_eq!(trace[RANDOMIZER_COL][TRACE_LENGTH - 1], mask[randomizer_base + TRACE_LENGTH - 1]);
        assert_eq!(trace[ZK_LIFT_COL][0], mask[randomizer_base + TRACE_LENGTH]);
        assert_eq!(trace[ZK_LIFT_COL][FIRST_FREE_ROW - 1], mask[randomizer_base + TRACE_LENGTH + FIRST_FREE_ROW - 1]);
    }

    #[test]
    fn test_chaining() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let (trace, _) = build_balance_proof_trace(sk, bal, salt, mint, &deterministic_test_mask());

        let owner = poseidon::hash2(sk, BaseElement::ZERO);

        // Cycle 0 output = owner
        assert_eq!(trace[0][NUM_ROUNDS], owner);

        // Cycle 1 start: col[0] = owner (chained), col[1] = token_mint
        assert_eq!(trace[0][32], owner);
        assert_eq!(trace[1][32], mint);

        // Cycle 3 start: col[1] = owner_mint (from carry)
        let owner_mint = poseidon::hash2(owner, mint);
        assert_eq!(trace[1][96], owner_mint);
    }

    /// Every transition constraint vanishes on every row of the honest trace,
    /// INCLUDING the blinding region -- that is the whole point of the gates.
    /// Evaluated with the AIR's own exported evaluator on the AIR's own
    /// periodic columns, and made non-vacuous by a mutation.
    #[test]
    fn every_constraint_vanishes_on_the_honest_trace_and_a_mutation_is_caught() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);
        let (trace, _) = build_balance_proof_trace(sk, bal, salt, mint, &deterministic_test_mask());
        let periodic = build_balance_proof_periodic_columns(TRACE_LENGTH);
        assert_eq!(periodic.len(), BALANCE_PROOF_NUM_PERIODIC);

        let sweep = |trace: &Vec<Vec<BaseElement>>| -> Vec<(usize, usize)> {
            let mut bad = Vec::new();
            let mut current = vec![BaseElement::ZERO; TRACE_WIDTH];
            let mut next = vec![BaseElement::ZERO; TRACE_WIDTH];
            let mut p = vec![BaseElement::ZERO; BALANCE_PROOF_NUM_PERIODIC];
            let mut result = vec![BaseElement::ZERO; BALANCE_PROOF_NUM_CONSTRAINTS];
            // Row n-1 is the wrap row: exempt, as in every circuit here.
            for row in 0..(TRACE_LENGTH - 1) {
                for c in 0..TRACE_WIDTH {
                    current[c] = trace[c][row];
                    next[c] = trace[c][row + 1];
                }
                for k in 0..BALANCE_PROOF_NUM_PERIODIC {
                    p[k] = periodic[k][row];
                }
                evaluate_balance_proof_transition(&current, &next, &p, &mut result);
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

        // Anti-vacuity: corrupt one witness cell and the sweep must notice.
        let mut mutated = trace.clone();
        mutated[3][100] = mutated[3][100] + BaseElement::ONE;
        assert!(!sweep(&mutated).is_empty(), "the sweep accepted a corrupted carry cell");

        // And a corrupted MASK cell must NOT be noticed: the region is free.
        let mut masked = trace.clone();
        masked[3][300] = masked[3][300] + BaseElement::ONE;
        masked[0][400] = masked[0][400] + BaseElement::new(7);
        masked[ZK_LIFT_COL][10] = masked[ZK_LIFT_COL][10] + BaseElement::new(9);
        assert!(sweep(&masked).is_empty(), "a constraint reaches into the blinding region or the lift column");
    }

    #[test]
    fn test_winterfell_proof() {
        use crate::prover::{prove_generic, verify_generic};

        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let (trace, commitment) = build_balance_proof_trace(sk, bal, salt, mint, &deterministic_test_mask());

        let pub_inputs = BalanceProofPublicInputs {
            commitment,
            token_mint: mint,
        };

        let (proof, _) = prove_generic::<BalanceProofAir>(trace, pub_inputs.clone())
            .expect("Balance proof generation failed");

        verify_generic::<BalanceProofAir>(proof, pub_inputs)
            .expect("Balance proof verification failed");
    }
}
