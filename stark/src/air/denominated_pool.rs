//! Denominated Pool Commitment STARK AIR
//!
//! Proves correct derivation of nullifier and commitment from private inputs:
//!   nullifier  = Poseidon(nullifier_preimage, secret)
//!   epoch_hash = Poseidon(deposit_epoch, token_mint)
//!   commitment = Poseidon(nullifier, epoch_hash)
//!
//! This is the "note ownership" proof for the denominated pool.
//! Combined with a MerklePathAir proof (leaf = commitment, root = merkle_root),
//! it proves a valid unshield/withdraw.
//!
//! Trace layout (width = 3, length = 128):
//!   Cycle 0 (rows  0-31):  Poseidon(nullifier_preimage, secret)    → nullifier
//!   Cycle 1 (rows 32-63):  Poseidon(deposit_epoch, token_mint)     → epoch_hash
//!   Cycle 2 (rows 64-95):  Poseidon(nullifier, epoch_hash)         → commitment
//!   Rows 96-127:           Padding (identity)
//!
//! Public inputs: nullifier, commitment
//! Private inputs: nullifier_preimage, secret, deposit_epoch, token_mint
//!
//! Chaining:
//!   - Cycle 2 input col[0] = nullifier (public, boundary asserted)
//!   - Cycle 2 input col[1] = epoch_hash (chained via transition constraint at row 63)

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

/// Columns the AIR constrains.
pub const CONSTRAINED_TRACE_WIDTH: usize = 4;

/// [ZK-RANDOMIZER 2026-08-30] One extra committed column, uniform on ALL rows,
/// entering NO constraint. It exists to put randomness into the DEEP
/// composition, which the row mask never reached — see
/// `stark/tests/full_wire_ledger.rs` for the ledger it closes.
///
/// ⚠️ C1 IS THE ONE CIRCUIT WHERE THE COLUMN ALONE WAS NOT ENOUGH. At n = 256 it
/// contributes 256 random coefficients against 301 published functionals: it did
/// not even cover itself. That is why `TRACE_LENGTH` doubles in the same change.
/// [ZK-LIFT 2026-08-30] The column that carries the blinding region into the
/// quotient claims the row mask cannot reach. C7 twin: `air::spend::ZK_LIFT_COL`.
///
/// The verifier checks ONE equation on the eight claims `Q_0(z)..Q_7(z)`, so a
/// simulator samples seven uniform and solves the eighth. The honest prover
/// cannot -- the coefficient split is unique -- so the only question is whether
/// the forced seven already look uniform. Measured on C7, they did not: the
/// columns that reach `Q` affinely reach only blocks 0..2, because a constraint
/// linear in a column contributes a low-degree piece to `Q = C / Z_T`.
///
/// The lift constraint fixes the degree budget and touches nothing else:
///
/// ```text
///     nba(x) * nba(x) * v(x) * state0(x)^6
/// ```
///
/// ⚠️ TWICE `nba`, AND THE REPETITION IS DELIBERATE. C1 is the one circuit with
/// no `active` column -- it has seven periodic columns and the file explains why
/// an eighth was not added -- so the second period-512 gate has to come from
/// somewhere. `nba` takes values in {0, 1} on the trace domain, so `nba^2 = nba`
/// there and the zero set is identical; off the domain it is a genuine degree
/// `2(n-1)` factor, which is the whole point.
///
///   * ZERO ON THE TRACE DOMAIN, because the trace builder writes this column
///     only inside the blinding region and `nba` is off there. It constrains
///     nothing and carries no witness, and adding a constraint can only
///     restrict a prover, never free one.
///   * base degree 7 with TWO period-512 gates -- the shape C1`s Poseidon
///     rounds already carry -- so `deg(C)` does not rise, `quotient_segments`
///     stays 8, `deg(D) = n - 2` stays and the FRI rate does not move.
///   * degree ONE in `v`, so every `Q_j(z)`, every committed quotient value and
///     every FRI layer value becomes affine in this column`s blinding entries.
///     Affine with a non-zero slope in a uniform variable is EXACTLY uniform.
///
/// ⛔ THE LIFT FACTOR MUST BE DENSE IN `x`. `(x^n - c)^6` was drafted first and
/// measures rank 1 OF 7: a polynomial in `x^n` cannot smear across segment
/// boundaries, so all seven claims come out as one scalar times a binomial
/// coefficient. `state0^6` is dense, and density is what creates rank.
///
/// ⛔ IT IS NOT THE RANDOMIZER. That column is uniform on ALL rows precisely
/// because it is unconstrained everywhere, which is what covers the FRI
/// channel. Giving it this constraint would force it to zero on the
/// constrained rows and put that channel SHORT. Two columns, two jobs.
pub const ZK_LIFT_COL: usize = CONSTRAINED_TRACE_WIDTH - 1;

pub const RANDOMIZER_COL: usize = CONSTRAINED_TRACE_WIDTH;

pub const TRACE_WIDTH: usize = CONSTRAINED_TRACE_WIDTH + 1;

/// CHANGED 128 -> 256 on 2026-08-29, and C1 is the one circuit where the DEPTH
/// TRICK DOES NOT WORK.
///
/// C3, C6 and C7 all freed their blinding region by cutting a Merkle depth,
/// which cost nothing because `next_pow2` absorbed it. C1 has no depth to cut:
/// its three hash cycles occupy rows 0..95 of a 128-row trace, leaving 32 free
/// rows against `R = 4 * 27 + 2 = 110` published openings per column. There is
/// no arrangement of 128 rows that yields 110 free ones while a 96-row witness
/// is present.
///
/// So the geometry moves instead: n 128 -> 256, LDE 2048 -> 4096.
///
/// ⚠️ THIS ONE IS NOT FREE, unlike the depth cuts. Measured consequences:
///   - the wire grows 68,881 -> 80,577 bytes (+11,696), so chunk uploads go
///     69 -> 81 transactions;
///   - `num_fri_layers` goes 6 -> 7, which the parser checks, so old and new
///     C1 proofs are mutually unparseable -- a hard wire break in both
///     directions;
///   - conjectured soundness drops 50 -> 48 bits, because the field floor is
///     `64 - log2(8n + w+k+1 + folds*lde)` and the LDE grew. The unconditional
///     column stays at 46.
///
/// ✅ What does NOT move, verified rather than assumed: `quotient_segments`
/// stays 8 (`ceil((8n-7)/n) = 8` for any n, and the double-sided assert in
/// `segment_quotient_poly` measures it), rho stays 1/16, and
/// `fri_final_poly_degree_bound` stays 1. No new domain-generator constants are
/// needed either: 256 and 4096 are already listed in the verifier's tables,
/// because C4 uses 4096 already.
/// [ZK-RANDOMIZER 2026-08-30] 256 -> 512, and this one is NOT free.
///
/// C1 has no Merkle depth to cut — it is a hash chain, not a path — so the only
/// way to grow its row mask is to grow the trace. MEASURED at the previous
/// doubling (128 -> 256): +101,482 CU on phase 1, +97,088 on phase 2, +11,696
/// wire bytes, and the conjectured forgery bound fell 50 -> 48 bits because the
/// LDE grew. Expect the same shape again; ⛔ re-measure, do not extrapolate.
pub const TRACE_LENGTH: usize = 512;

pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;
pub const NUM_HASH_CYCLES: usize = 3;

/// First trace row free on every one of the three columns.
///
/// The witness occupies exactly three hash cycles and not one row more, so this
/// is `NUM_HASH_CYCLES * HASH_CYCLE_LEN` and moves with them.
pub const FIRST_FREE_ROW: usize = NUM_HASH_CYCLES * HASH_CYCLE_LEN; // 96

/// Blinding positions per column.
///
/// ```text
///   MASK_ROWS = 256 - 96 = 160
///   R         = 4 * 27 + 2 = 110      (C1 ships 27 queries, not 22)
///   160 > 110, margin 50.
///
///   n = 128 -> 32  free  < 110   <- before this change: NOT zero-knowledge
///   n = 256 -> 160 free  > 110   margin 50   <- chosen
/// ```
///
/// 🚨 THE OLD TAIL WAS NOT FREE, IT WAS FORCED. `build_pool_commitment_trace`
/// used to fill rows 96..127 by copying row 95, and with the periodic flags at
/// zero the Poseidon constraints degenerate to `next[i] - current[i] = 0`,
/// which pins each column constant across the whole tail. That is ONE unknown
/// per column, not 32, and `stark/tests/air_aware_recovery_c1.rs` turned it into
/// 35 linear equalities and solved for all four private inputs. It no longer
/// does on the masked AIR; the file keeps that pre-mask model as its control.
pub const MASK_ROWS: usize = TRACE_LENGTH - FIRST_FREE_ROW; // 160

/// Mask elements `build_pool_commitment_trace` requires.
/// Row mask over the CONSTRAINED columns, then the randomizer column over every
/// row: 416*3 + 512 = 1760.
pub const MASK_LEN: usize = MASK_ROWS * CONSTRAINED_TRACE_WIDTH + TRACE_LENGTH;

/// Number of transition constraints in the pool-commitment AIR.
///
/// Layout: 3 Poseidon-round constraints (cols 0-2, gated by not_boundary *
/// round_flag) + 1 chain constraint (next[1] at row 64 = current[0] at row 63,
/// i.e. epoch_hash routed into cycle 2's right input).
pub const POOL_COMMITMENT_NUM_CONSTRAINTS: usize = 5;

/// Number of periodic columns.
///
/// Layout: `[rc0, rc1, rc2, round_flag, chain_flag, is_boundary,
/// not_boundary_active]`.
///
/// 6 -> 7 on 2026-08-29. ORDER IS FROZEN - the RLC uses `alpha^i` and the
/// coefficient emitter indexes positionally. Append only, never insert.
///
/// ⚠️ ONE NEW COLUMN, NOT TWO. C3, C6 and C7 each gained `active` AND
/// `not_boundary_active`, because they have gates that need `active` on its own
/// (`hash_start`, `is_boundary`, `is_interior`). C1 has only four constraints:
/// three Poseidon rows already gated by `not_boundary`, and one chain
/// constraint whose `chain_flag` is a ONE-HOT at row 63, deep inside the
/// witness region and therefore already zero everywhere the mask lives. So the
/// pre-multiplied column alone suffices, and adding a second would be dead
/// rodata.
pub const POOL_COMMITMENT_NUM_PERIODIC: usize = 7;

// ============================================================================
// Public inputs
// ============================================================================

#[derive(Clone, Debug)]
pub struct DenominatedPoolPublicInputs {
    pub nullifier: BaseElement,
    pub commitment: BaseElement,
}

impl ToElements<BaseElement> for DenominatedPoolPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![self.nullifier, self.commitment]
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct DenominatedPoolAir {
    context: AirContext<BaseElement>,
    nullifier: BaseElement,
    commitment: BaseElement,
}

impl Air for DenominatedPoolAir {
    type BaseField = BaseElement;
    type PublicInputs = DenominatedPoolPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        // Constraints:
        // [0-2] Poseidon round: degree 7, periodic cycles = TRACE_LENGTH × 2 (round_flag + is_boundary)
        // [3]   Chain epoch_hash: degree 1, periodic cycle = TRACE_LENGTH
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [4] ZK degree lift, col `ZK_LIFT_COL`. Base 7 with two
            // period-512 gates -- the same shape as the Poseidon rounds above --
            // so the composition degree, the segment count and the FRI rate are
            // all unchanged.
            TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, TRACE_LENGTH]),
        ];

        // Assertions:
        // 1. col[0] at row 30 = nullifier
        // 2. col[0] at row 94 = commitment
        // 3. col[2] at row 0  = 0 (capacity for cycle 0)
        // 4. col[2] at row 32 = 0 (capacity for cycle 1)
        // 5. col[2] at row 64 = 0 (capacity for cycle 2)
        // 6. col[0] at row 64 = nullifier (chaining: cycle 2 left input = cycle 0 output)
        let num_assertions = 6;
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            nullifier: pub_inputs.nullifier,
            commitment: pub_inputs.commitment,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_pool_commitment_periodic_columns(TRACE_LENGTH)
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_pool_commitment_transition(frame.current(), frame.next(), periodic_values, result);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        vec![
            // Nullifier output (cycle 0)
            Assertion::single(0, NUM_ROUNDS, self.nullifier),
            // Commitment output (cycle 2)
            Assertion::single(0, 2 * HASH_CYCLE_LEN + NUM_ROUNDS, self.commitment),
            // Capacity = 0 at start of each hash cycle
            Assertion::single(2, 0, BaseElement::ZERO),
            Assertion::single(2, HASH_CYCLE_LEN, BaseElement::ZERO),
            Assertion::single(2, 2 * HASH_CYCLE_LEN, BaseElement::ZERO),
            // Chaining: cycle 2 left input = nullifier (output of cycle 0)
            Assertion::single(0, 2 * HASH_CYCLE_LEN, self.nullifier),
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

/// Build the 6 periodic column value vectors for circuit 1 (pool_commitment).
///
/// Exposed so the prover can interpolate / inverse-NTT them for LDE and OOD
/// evaluations outside the AIR. Mirrors the `MerkleUpdateAir::get_periodic_column_values`
/// pattern so the DEEP-ALI quotient path can reuse it.
///
/// Layout: `[rc0, rc1, rc2, round_flag, chain_flag, is_boundary]`.
pub fn build_pool_commitment_periodic_columns(trace_length: usize) -> Vec<Vec<BaseElement>> {
    let tl = trace_length;
    let active_rows = NUM_HASH_CYCLES * HASH_CYCLE_LEN; // 96

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    let mut rc0 = vec![BaseElement::ZERO; tl];
    let mut rc1 = vec![BaseElement::ZERO; tl];
    let mut rc2 = vec![BaseElement::ZERO; tl];
    let mut round_flag = vec![BaseElement::ZERO; tl];

    for row in 0..active_rows {
        let pos = row % HASH_CYCLE_LEN;
        if pos < NUM_ROUNDS {
            rc0[row] = rc[pos * 3];
            rc1[row] = rc[pos * 3 + 1];
            rc2[row] = rc[pos * 3 + 2];
            round_flag[row] = BaseElement::ONE;
        }
    }

    // chain_flag: 1 only at row 63 — end of cycle 1 — to enforce next[1]@row64 = current[0]@row63.
    let mut chain_flag = vec![BaseElement::ZERO; tl];
    chain_flag[HASH_CYCLE_LEN * 2 - 1] = BaseElement::ONE;

    // is_boundary: 1 at last row of each hash cycle (rows 31, 63, 95) — allows free transitions.
    let mut is_boundary = vec![BaseElement::ZERO; tl];
    for cycle in 0..NUM_HASH_CYCLES {
        is_boundary[cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1] = BaseElement::ONE;
    }

    // -- APPENDED 2026-08-29: the gate that makes C1 zero-knowledge --
    //
    // `not_boundary_active` is `active` pre-multiplied with `not_boundary`. It
    // is a SEPARATE COLUMN rather than a product formed in the constraint body
    // ON PURPOSE: the degree-7 Poseidon constraints may carry exactly TWO
    // periodic factors, and they already spend both on `not_boundary` and
    // `round_flag`. A third makes degree_bound = 7 + 3 - 1 = 9, whose
    // next_power_of_two is 16, so ce_blowup_factor goes 8 -> 16 and the whole
    // proof structure changes with it. Substituting keeps the count at two.
    //
    // THE BOUND IS `FIRST_FREE_ROW - 1`, NOT `FIRST_FREE_ROW`.
    //
    // These are TRANSITION constraints: the one at row i reads row i+1. Row 95
    // is the last witness row, so a gate left on there would constrain the
    // 95 -> 96 transition, i.e. demand a relationship between real state and
    // the first masked row.
    //
    // ⚠️ FOR C1 SPECIFICALLY THAT BOUND IS BELT AND BRACES, and it is worth
    // saying why rather than copying it blindly: `is_boundary[95] = 1` already
    // zeroes `not_boundary` at row 95, so the Poseidon constraints are off
    // there whichever bound is used. The `-1` is kept for consistency with C3,
    // C6 and C7, and because it stays correct if `is_boundary` ever stops
    // covering that row. C3/C6/C7 genuinely need it -- their carry constraints
    // fire AT the boundary.
    let mut not_boundary_active = vec![BaseElement::ZERO; tl];
    for row in 0..(FIRST_FREE_ROW - 1) {
        if row % HASH_CYCLE_LEN != HASH_CYCLE_LEN - 1 {
            not_boundary_active[row] = BaseElement::ONE;
        }
    }

    vec![
        rc0,                 // 0
        rc1,                 // 1
        rc2,                 // 2
        round_flag,          // 3
        chain_flag,          // 4
        is_boundary,         // 5
        not_boundary_active, // 6  APPENDED
    ]
}

/// Standalone evaluator for circuit 1 transition constraints.
///
/// Mirrors `DenominatedPoolAir::evaluate_transition` so the prover can evaluate
/// the same constraints at LDE and OOD points without instantiating the AIR.
/// `current` / `next` must be length 3, `periodic` length 6, `result` length 4.
///
/// Periodic layout: `[rc0, rc1, rc2, round_flag, chain_flag, is_boundary]`.
pub fn evaluate_pool_commitment_transition<E: FieldElement>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), TRACE_WIDTH);
    debug_assert_eq!(next.len(), TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), POOL_COMMITMENT_NUM_PERIODIC);
    debug_assert_eq!(result.len(), POOL_COMMITMENT_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_flag = periodic[3];
    let chain_flag = periodic[4];
    // `is_boundary` is still read: `nba` replaced its only USE in the Poseidon
    // gate, but the binding stays so the layout comment above matches the code
    // and so a future constraint can reach for the ungated form deliberately
    // rather than by reconstructing it.
    let _is_boundary = periodic[5];
    let nba = periodic[6];

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
    // every row of the three hash cycles and differ only across rows 96..255 --
    // so the substitution rejects NO honest proof, passes every existing test,
    // and silently re-imposes `next[i] - current[i] = 0` on the 160 blinding
    // rows. That degenerate form is exactly what pins each column to a single
    // unknown, and it is what `stark/tests/air_aware_recovery_c1.rs` solved
    // before the mask — and still solves, on the pre-mask model it keeps.
    //
    // ⚠️ COUNT THE PERIODIC FACTORS BEFORE EDITING. Each of these three lines
    // carries exactly TWO, `nba` and `round_flag`, over a degree-7 body. A
    // third takes ce_blowup_factor from 8 to 16.
    result[0] = nba * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - round_flag * (ro2 - current[2]));

    // ── Chain: epoch_hash → cycle 2 right input ──
    // At row 63 (end of cycle 1): next[1] at row 64 should = current[0] at row 63 (epoch_hash).
    result[3] = chain_flag * (next[1] - current[0]);

    // [4] ZK degree lift, col `ZK_LIFT_COL`. See the constant`s doc, including
    // why `nba` appears twice.
    //
    // Zero on the trace domain because `v` is zero wherever `nba` is not. Its
    // whole job is to be degree 1 in `v` and degree 7 overall, so the blinding
    // region reaches quotient blocks 0..7 instead of 0..2.
    let lift = current[0] * current[0] * current[0];
    result[4] = nba * nba * current[ZK_LIFT_COL] * lift * lift;
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build trace for denominated pool commitment proof.
///
/// Inputs:
///   - nullifier_preimage, secret: note identity
///   - deposit_epoch, token_mint: note metadata
///
/// Outputs (computed internally, returned for convenience):
///   - nullifier = Poseidon(nullifier_preimage, secret)
///   - commitment = Poseidon(nullifier, Poseidon(deposit_epoch, token_mint))
pub fn build_pool_commitment_trace(
    nullifier_preimage: BaseElement,
    secret: BaseElement,
    deposit_epoch: BaseElement,
    token_mint: BaseElement,
    mask: &[BaseElement],
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement) {
    assert_eq!(
        mask.len(),
        MASK_LEN,
        "C1 needs {MASK_LEN} blinding elements ({MASK_ROWS} rows x          {CONSTRAINED_TRACE_WIDTH} constrained columns, then {TRACE_LENGTH} for the          randomizer column), got {}",
        mask.len(),
    );
    let mut trace = vec![vec![BaseElement::ZERO; TRACE_LENGTH]; TRACE_WIDTH];

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mds = &poseidon::constants::MDS_MATRIX_T3;

    // Helper: run one Poseidon hash cycle and write to trace
    let run_hash_cycle = |trace: &mut Vec<Vec<BaseElement>>,
                          cycle: usize,
                          input0: BaseElement,
                          input1: BaseElement|
     -> BaseElement {
        let start = cycle * HASH_CYCLE_LEN;
        let mut state = [input0, input1, BaseElement::ZERO];

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

            let mut result = [BaseElement::ZERO; 3];
            for i in 0..3 {
                for j in 0..3 {
                    result[i] = result[i] + mds[i][j] * state[j];
                }
            }
            state = result;

            let row = start + round + 1;
            trace[0][row] = state[0];
            trace[1][row] = state[1];
            trace[2][row] = state[2];
        }

        // Padding row
        let pad = start + NUM_ROUNDS + 1;
        trace[0][pad] = state[0];
        trace[1][pad] = state[1];
        trace[2][pad] = state[2];

        state[0]
    };

    // Cycle 0: nullifier = Poseidon(nullifier_preimage, secret)
    let nullifier = run_hash_cycle(&mut trace, 0, nullifier_preimage, secret);

    // Cycle 1: epoch_hash = Poseidon(deposit_epoch, token_mint)
    let epoch_hash = run_hash_cycle(&mut trace, 1, deposit_epoch, token_mint);

    // Cycle 2: commitment = Poseidon(nullifier, epoch_hash)
    let commitment = run_hash_cycle(&mut trace, 2, nullifier, epoch_hash);

    // -- THE BLINDING REGION, 2026-08-29 --
    //
    // 🚨 WHAT THIS REPLACES IS THE ENTIRE DEFECT, and the old comment said it
    // out loud: "Padding rows 96-127: copy last state". Those rows looked free
    // and were not -- they were a FUNCTION of the witness, and each column
    // contributed ONE unknown across the whole tail instead of one per row.
    //
    // `air_aware_recovery_c1.rs` turned exactly that into 35 linear equalities,
    // collapsed 128 unknowns per column to 93 effective ones against 110
    // published openings, and recovered all four private inputs in closed form.
    // On the masked AIR it reads under-determined; the closed form lives on in
    // the pre-mask counterfactual the same file runs beside it.
    //
    // Fresh uniform values make each of the 160 rows its own unknown, so the
    // count runs the other way: 160 * 3 unknowns against 110 openings.
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

    (trace, nullifier, commitment)
}

/// Compute nullifier and commitment without building the full trace.
pub fn compute_pool_values(
    nullifier_preimage: BaseElement,
    secret: BaseElement,
    deposit_epoch: BaseElement,
    token_mint: BaseElement,
) -> (BaseElement, BaseElement) {
    let nullifier = poseidon::hash2(nullifier_preimage, secret);
    let epoch_hash = poseidon::hash2(deposit_epoch, token_mint);
    let commitment = poseidon::hash2(nullifier, epoch_hash);
    (nullifier, commitment)
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
    let mut z: u64 = 0xC1_5EED_0002;
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
    fn test_compute_pool_values_deterministic() {
        let np = BaseElement::new(111);
        let secret = BaseElement::new(222);
        let epoch = BaseElement::new(333);
        let mint = BaseElement::new(444);

        let (n1, c1) = compute_pool_values(np, secret, epoch, mint);
        let (n2, c2) = compute_pool_values(np, secret, epoch, mint);
        assert_eq!(n1, n2);
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_trace_output_matches_compute() {
        let np = BaseElement::new(111);
        let secret = BaseElement::new(222);
        let epoch = BaseElement::new(333);
        let mint = BaseElement::new(444);

        let (expected_null, expected_commit) = compute_pool_values(np, secret, epoch, mint);
        let (trace, null, commit) = build_pool_commitment_trace(np, secret, epoch, mint, &deterministic_test_mask());

        assert_eq!(null, expected_null);
        assert_eq!(commit, expected_commit);

        // Check trace positions
        assert_eq!(trace[0][NUM_ROUNDS], expected_null);
        assert_eq!(trace[0][2 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_commit);
    }

    #[test]
    fn test_trace_chaining() {
        let np = BaseElement::new(111);
        let secret = BaseElement::new(222);
        let epoch = BaseElement::new(333);
        let mint = BaseElement::new(444);

        let (trace, nullifier, _) = build_pool_commitment_trace(np, secret, epoch, mint, &deterministic_test_mask());

        // Cycle 2 start: col[0] = nullifier
        assert_eq!(trace[0][64], nullifier);

        // Cycle 2 start: col[1] = epoch_hash (output of cycle 1)
        let epoch_hash = trace[0][32 + NUM_ROUNDS]; // row 62
        assert_eq!(trace[1][64], epoch_hash);

        // Capacity = 0 at all cycle starts
        assert_eq!(trace[2][0], BaseElement::ZERO);
        assert_eq!(trace[2][32], BaseElement::ZERO);
        assert_eq!(trace[2][64], BaseElement::ZERO);
    }

    #[test]
    fn test_different_inputs_different_outputs() {
        let (n1, c1) = compute_pool_values(
            BaseElement::new(1), BaseElement::new(2),
            BaseElement::new(3), BaseElement::new(4),
        );
        let (n2, c2) = compute_pool_values(
            BaseElement::new(1), BaseElement::new(3),
            BaseElement::new(3), BaseElement::new(4),
        );
        assert_ne!(n1, n2);
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_winterfell_proof() {
        use crate::prover::{prove_generic, verify_generic};

        let np = BaseElement::new(111);
        let secret = BaseElement::new(222);
        let epoch = BaseElement::new(333);
        let mint = BaseElement::new(444);

        let (trace, nullifier, commitment) = build_pool_commitment_trace(np, secret, epoch, mint, &deterministic_test_mask());

        let pub_inputs = DenominatedPoolPublicInputs { nullifier, commitment };

        let (proof, _) = prove_generic::<DenominatedPoolAir>(trace, pub_inputs.clone())
            .expect("Pool commitment proof generation failed");

        verify_generic::<DenominatedPoolAir>(proof, pub_inputs)
            .expect("Pool commitment proof verification failed");
    }

    #[test]
    fn test_wrong_nullifier_fails_prove() {
        use crate::prover::{prove_generic, verify_generic};

        let np = BaseElement::new(111);
        let secret = BaseElement::new(222);
        let epoch = BaseElement::new(333);
        let mint = BaseElement::new(444);

        let (trace, _, commitment) = build_pool_commitment_trace(np, secret, epoch, mint, &deterministic_test_mask());

        let wrong_pub_inputs = DenominatedPoolPublicInputs {
            nullifier: BaseElement::new(999),
            commitment,
        };

        // Soundness: either the prover rejects (panic or Err), or — if it does
        // produce a proof — the verifier MUST reject it.
        let result = std::panic::catch_unwind(|| {
            prove_generic::<DenominatedPoolAir>(trace, wrong_pub_inputs.clone())
        });

        match result {
            Err(_) => { /* prover panicked — acceptable */ }
            Ok(Err(_)) => { /* prover returned error — acceptable */ }
            Ok(Ok((proof, _))) => {
                let verify = verify_generic::<DenominatedPoolAir>(proof, wrong_pub_inputs);
                assert!(
                    verify.is_err(),
                    "Proof with wrong nullifier must fail either prove or verify"
                );
            }
        }
    }
}
