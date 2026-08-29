//! Transfer STARK AIR
//!
//! Proves a valid 2-in-2-out shielded transfer.
//! Merkle path verification is handled separately by MerklePathAir.
//!
//! Computation (14 chained Poseidon_t3 hashes + 2 padding):
//!   Cycle  0: owner           = Poseidon(spending_key, 0)
//!   Cycle  1: owner_mint      = Poseidon(owner, token_mint)        — chained from 0
//!   Cycle  2: in1_left        = Poseidon(in_amount_1, in_rand_1)
//!   Cycle  3: in_commitment_1 = Poseidon(in1_left, owner_mint)     — chained from 2, carry
//!   Cycle  4: nullifier_1     = Poseidon(in_commit_1, owner)       — chained from 3, carry
//!   Cycle  5: in2_left        = Poseidon(in_amount_2, in_rand_2)
//!   Cycle  6: in_commitment_2 = Poseidon(in2_left, owner_mint)     — chained from 5, carry
//!   Cycle  7: nullifier_2     = Poseidon(in_commit_2, owner)       — chained from 6, carry
//!   Cycle  8: out1_rm         = Poseidon(out_recipient_1, mint)
//!   Cycle  9: out1_left       = Poseidon(out_amount_1, out_rand_1)
//!   Cycle 10: out_commit_1    = Poseidon(out1_left, out1_rm)       — chained from 9, carry
//!   Cycle 11: out2_rm         = Poseidon(out_recipient_2, mint)
//!   Cycle 12: out2_left       = Poseidon(out_amount_2, out_rand_2)
//!   Cycle 13: out_commit_2    = Poseidon(out2_left, out2_rm)       — chained from 12, carry
//!   Cycles 14-15: padding     = Poseidon(0, 0)
//!
//! Trace layout (width = 7, length = 512):
//!   cols 0-2: Poseidon state (t=3)
//!   col 3:    carry_owner (holds owner from cycle 0)
//!   col 4:    carry_owner_mint (holds owner_mint from cycle 1)
//!   col 5:    carry_out_rm (holds output recipient×mint hashes)
//!   col 6:    acc — value-conservation accumulator (signed running sum of
//!             the four note amounts; see "Value conservation" below)
//!
//! Value conservation (col 6, [#2 voie A]):
//!   The four note amounts live at col 0 of the cycle-start rows:
//!     in_amount_1  @ row 64  (cycle 2 start)
//!     in_amount_2  @ row 160 (cycle 5 start)
//!     out_amount_1 @ row 288 (cycle 9 start)
//!     out_amount_2 @ row 384 (cycle 12 start)
//!   col 6 (`acc`) maintains the signed running sum
//!     acc := acc - in_amount_1 - in_amount_2 + out_amount_1 + out_amount_2
//!   captured at those four rows via one-hot flags, and held constant
//!   everywhere else. A boundary assertion then forces the final accumulator
//!   value to equal `public_amount`, i.e. enforces the conservation relation
//!     out1 + out2 - in1 - in2 == public_amount   (mod p, in the field),
//!   equivalently  in1 + in2 + public_amount == out1 + out2.
//!   Sign convention matches the existing prover/SDK tests: `public_amount > 0`
//!   is a deposit/shield (value enters the shielded set, e.g. in=0/out=200/
//!   public_amount=200), `public_amount == 0` is a pure balanced transfer, and
//!   an unshield is the field-encoded negative (value leaves the shielded set).
//!   Because the relation is
//!   evaluated in the Goldilocks field (no native range check — see the NOTE
//!   in `air/transfer.rs` and the audit doc), the on-chain program MUST still
//!   bound each amount to [0, 2^64) out-of-circuit so field wrap-around cannot
//!   forge conservation. See `ConservationRangeNote` below.
//!
//! Public inputs: nullifier_1, nullifier_2, output_commitment_1, output_commitment_2,
//!                public_amount, token_mint
//! Private inputs: spending_key, in_amounts, in_randomness, out_amounts, out_randomness,
//!                 out_recipients

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

pub const TRACE_WIDTH: usize = 7;

/// CHANGED 512 -> 1024 on 2026-08-29. C5 is the SECOND circuit that could not
/// be fixed by a depth cut, and it could not for a different reason from C1's.
///
/// C1 ran out of rows: its witness filled 96 of 128 and it needed 110 free.
/// C5 has 512 rows and its walk ends at 447, so 64 rows LOOK free. They are
/// not, and the reason is the carry columns:
///
///   col 3  `owner`      on every row past 30    — SECRET
///   col 4  `owner_mint` on every row past 62    — SECRET
///   col 5  `out2_rm`    on every row past 382   — SECRET
///   col 6  `acc4`       on every row past 384   — equals public_amount
///
/// So there is no contiguous region where all seven columns are free, at ANY
/// depth. Dropping the two padding cycles frees rows 448..511 = 64 rows against
/// `R = 4*22 + 2 = 90`, which is 26 short. 14 real hash cycles x 32 = 448 rows
/// is a floor no rearrangement beats: even at HASH_CYCLE_LEN = 31 it would be
/// `512 - 434 = 78 < 90`.
///
/// ⚠️ I FIRST WROTE THAT CYCLES 14 AND 15 WERE REAL HASHES. They are not --
/// `run_hash(&mut trace, 14, ZERO, ZERO)` is padding on a public constant. The
/// conclusion survived the correction and got stronger: the blocker is the
/// carry columns, which no depth cut touches.
///
/// At 1024 the walk still ends at 447 and rows 448..1023 are free: 576 rows,
/// margin 486.
pub const TRACE_LENGTH: usize = 1024;

pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;

/// The first cycle carrying no witness. Cycles 0..13 are the real walk.
pub const FIRST_FREE_CYCLE: usize = 14;

/// First trace row free on every one of the seven columns.
///
/// ⚠️ 448, AND THE LAST WITNESS ROW IS 447. `output_commitment_2` is boundary-
/// asserted at row 446, inside cycle 13 (rows 416..447), so the walk genuinely
/// ends at 447 and nothing below the mask depends on a padding cycle.
pub const FIRST_FREE_ROW: usize = FIRST_FREE_CYCLE * HASH_CYCLE_LEN; // 448

/// Blinding positions per column.
///
/// ```text
///   MASK_ROWS = 1024 - 448 = 576
///   R         = 4 * 22 + 2 = 90
///   576 > 90, margin 486.
///
///   n =  512 -> 64  free  < 90   <- impossible, see TRACE_LENGTH
///   n = 1024 -> 576 free  > 90   margin 486   <- chosen
/// ```
pub const MASK_ROWS: usize = TRACE_LENGTH - FIRST_FREE_ROW; // 576

/// Mask elements `build_transfer_trace` requires.
pub const MASK_LEN: usize = MASK_ROWS * TRACE_WIDTH; // 4032

/// Number of transition constraints in the transfer AIR (circuit 5).
///
/// 23 hashing/routing constraints (Poseidon rounds, chain edges, carries) plus
/// 5 value-conservation constraints (4 signed amount captures into col 6 +
/// 1 accumulator continuity) = 28.
pub const TRANSFER_NUM_CONSTRAINTS: usize = 28;

/// Number of periodic columns: rc0, rc1, rc2, round_flag, is_boundary,
/// 7 direct chain flags, 4 carry-capture flags, 6 carry→right-input flags,
/// 1 carry-capture-any flag, 4 amount-capture flags, 1 acc-continuity flag,
/// plus `active` and `not_boundary_active`.
///
/// 28 -> 30 on 2026-08-29. ORDER IS FROZEN - the RLC uses `alpha^i` and the
/// coefficient emitter indexes positionally. Append only, never insert.
///
/// ⚠️ TWO NEW COLUMNS HERE, NOT ONE. C1 needed only the pre-multiplied
/// `not_boundary_active`, because its only gated constraints were three
/// Poseidon rows already carrying `not_boundary`. C5 has four MORE constraints
/// to switch off across the mask -- the two carry-continuity rows (11, 13), the
/// out_rm continuity (22) and the accumulator continuity (27) -- and none of
/// them is gated by `is_boundary`, so they need `active` on its own.
pub const TRANSFER_NUM_PERIODIC: usize = 30;

/// Trace rows where the four note amounts sit at col 0 (cycle-start rows).
pub const ROW_IN_AMOUNT_1: usize = 2 * HASH_CYCLE_LEN;  // 64
pub const ROW_IN_AMOUNT_2: usize = 5 * HASH_CYCLE_LEN;  // 160
pub const ROW_OUT_AMOUNT_1: usize = 9 * HASH_CYCLE_LEN;  // 288
pub const ROW_OUT_AMOUNT_2: usize = 12 * HASH_CYCLE_LEN; // 384
/// Row at which the conservation accumulator (col 6) holds its final value
/// `in1 + in2 - out1 - out2` and is asserted equal to `public_amount`.
/// Any row strictly after ROW_OUT_AMOUNT_2 works; we use its successor.
pub const ROW_ACC_FINAL: usize = ROW_OUT_AMOUNT_2 + 1; // 385

// ============================================================================
// Public inputs
// ============================================================================

#[derive(Clone, Debug)]
pub struct TransferPublicInputs {
    pub nullifier_1: BaseElement,
    pub nullifier_2: BaseElement,
    pub output_commitment_1: BaseElement,
    pub output_commitment_2: BaseElement,
    pub public_amount: BaseElement,
    pub token_mint: BaseElement,
}

impl ToElements<BaseElement> for TransferPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.nullifier_1,
            self.nullifier_2,
            self.output_commitment_1,
            self.output_commitment_2,
            self.public_amount,
            self.token_mint,
        ]
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct TransferAir {
    context: AirContext<BaseElement>,
    nullifier_1: BaseElement,
    nullifier_2: BaseElement,
    output_commitment_1: BaseElement,
    output_commitment_2: BaseElement,
    public_amount: BaseElement,
    token_mint: BaseElement,
}

impl Air for TransferAir {
    type BaseField = BaseElement;
    type PublicInputs = TransferPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        let degrees = vec![
            // [0-2] Poseidon round (period 32 rc/flag, period 512 boundary)
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            // [3-9] Direct col-0 chaining: 7 constraints (0→1, 2→3, 3→4, 5→6, 6→7, 9→10, 12→13)
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [10] carry_owner capture (cycle 0 end)
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [11] carry_owner continuity
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [12] carry_owner_mint capture (cycle 1 end)
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [13] carry_owner_mint continuity
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [14-15] carry_owner_mint → right input at cycles 3, 6
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [16-17] carry_owner → right input at cycles 4, 7
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [18] carry_out_rm capture at cycle 8 end
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [19] carry_out_rm → right at cycle 10
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [20] carry_out_rm re-capture at cycle 11 end
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [21] carry_out_rm → right at cycle 13
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [22] carry_out_rm continuity (except at capture points)
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [23-26] value-conservation amount captures into acc (col 6):
            //   +in1 @64, +in2 @160, -out1 @288, -out2 @384
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            // [27] acc continuity (every row except the 4 capture rows)
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
        ];

        // Assertions:
        // Capacity at each cycle start (14 active + 2 padding = 16)
        // + nullifier outputs + output commitment outputs + token_mint inputs
        // + acc(0)=0 (conservation accumulator starts empty)
        // + acc(ROW_ACC_FINAL)=public_amount (conservation relation)
        let num_assertions = 24;
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            nullifier_1: pub_inputs.nullifier_1,
            nullifier_2: pub_inputs.nullifier_2,
            output_commitment_1: pub_inputs.output_commitment_1,
            output_commitment_2: pub_inputs.output_commitment_2,
            public_amount: pub_inputs.public_amount,
            token_mint: pub_inputs.token_mint,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_transfer_periodic_columns()
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_transfer_transition(frame.current(), frame.next(), periodic_values, result);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        let mut assertions = Vec::new();

        // Capacity (col 2) = 0 at start of each of the 14 REAL cycles.
        //
        // 🚨 16 -> 14 on 2026-08-29, AND THIS IS A WIRE BREAK IN BOTH
        // DIRECTIONS. Cycles 14 and 15 started at rows 448 and 480, which are
        // now inside the blinding region: asserting col 2 == 0 there would
        // demand a masked cell take a fixed value, which is unsatisfiable with
        // fresh randomness and would publish a known cell if it were satisfied.
        //
        // ⛔ THE ORDER OF THIS LIST IS LOAD-BEARING. `alpha_bnd^j` is indexed by
        // POSITION, so removing two entries renumbers every one after them:
        // what was j=16..25 becomes j=14..23. The prover's
        // `boundary_assertions_for_circuit` and the verifier's
        // `get_boundary_assertions` hold the same list and must be edited in
        // the same commit -- an honest proof built against either old list
        // fails DEEP-ALI against the new one, silently and completely.
        for cycle in 0..FIRST_FREE_CYCLE {
            assertions.push(Assertion::single(2, cycle * HASH_CYCLE_LEN, BaseElement::ZERO));
        }

        // col 1 at row 0 = 0 (spending_key hash 2nd input)
        assertions.push(Assertion::single(1, 0, BaseElement::ZERO));

        // Token mint as right input at cycles 1, 8, 11
        assertions.push(Assertion::single(1, HASH_CYCLE_LEN, self.token_mint));     // cycle 1
        assertions.push(Assertion::single(1, 8 * HASH_CYCLE_LEN, self.token_mint)); // cycle 8
        assertions.push(Assertion::single(1, 11 * HASH_CYCLE_LEN, self.token_mint)); // cycle 11

        // Output assertions (public inputs)
        assertions.push(Assertion::single(0, 4 * HASH_CYCLE_LEN + NUM_ROUNDS, self.nullifier_1));
        assertions.push(Assertion::single(0, 7 * HASH_CYCLE_LEN + NUM_ROUNDS, self.nullifier_2));
        assertions.push(Assertion::single(0, 10 * HASH_CYCLE_LEN + NUM_ROUNDS, self.output_commitment_1));
        assertions.push(Assertion::single(0, 13 * HASH_CYCLE_LEN + NUM_ROUNDS, self.output_commitment_2));

        // Value conservation (col 6):
        //   acc starts at 0, and after summing +in1 +in2 -out1 -out2 it must
        //   equal public_amount. This enforces in1 + in2 == out1 + out2 +
        //   public_amount in the field.
        assertions.push(Assertion::single(6, 0, BaseElement::ZERO));
        assertions.push(Assertion::single(6, ROW_ACC_FINAL, self.public_amount));

        assertions
    }
}

#[inline(always)]
fn pow7<E: FieldElement>(x: E) -> E {
    let x2 = x * x;
    let x4 = x2 * x2;
    x4 * x2 * x
}

/// [#2 voie A] Range-check note for value conservation.
///
/// The conservation constraint (col 6) enforces
///   `in1 + in2 - out1 - out2 == public_amount`  **in the Goldilocks field**
/// (p = 2^64 − 2^32 + 1). Field arithmetic wraps modulo p, so conservation
/// alone does NOT prevent an attacker from picking amounts that satisfy the
/// equation modulo p while violating it over the integers (e.g. an `out`
/// amount near `p` acting as a negative number). A complete fix needs each of
/// `in1, in2, out1, out2` (and, where applicable, `public_amount`) bounded to
/// the 64-bit range `[0, 2^64)` — and, because Goldilocks values can exceed
/// 2^63, ideally to `[0, 2^63)` so the signed sum cannot wrap.
///
/// Why the range check is NOT a STARK constraint here:
///   A standard 64-bit bit-decomposition range check needs ~64 boolean cells
///   per amount (4 amounts → 256 cells) plus the bit-sum constraints. The
///   circuit-5 trace is already width 7 × 512 rows and the on-chain verifier
///   sits at the 1.4M-CU Solana cap (num_queries was cut 27→22 specifically to
///   fit the 23-constraint transition polynomial; this change raises it to 28).
///   Adding a bit-decomposition gadget would blow both the trace width and the
///   per-row constraint-evaluation CU well past budget. Implementing it as a
///   lookup-argument range check is the right long-term direction but requires
///   an auxiliary-column / LogUp machinery the crate does not yet have.
///
/// Mitigation in force: the on-chain Solana program already receives each note
/// amount as a `u64` and the public amount as a `u64`, so they are physically
/// range-bounded to `[0, 2^64)` at deserialization, and the program checks the
/// integer conservation relation on those `u64`s (cf.
/// `confidential_balance::verify_conservation`). The in-circuit constraint
/// added here closes the "mint from nothing" gap by binding the SAME amounts
/// that hash into the note commitments to the conserved sum; the out-of-circuit
/// `u64` bound prevents field wrap-around. A future LogUp range check would let
/// us drop the trust in the on-chain `u64` bound entirely.
pub struct ConservationRangeNote;

// ============================================================================
// Periodic columns (public: shared with compact.rs + on-chain verifier parity)
// ============================================================================

/// Build the 23 periodic columns for circuit 5 (transfer). Period-32 columns
/// (rc0/rc1/rc2/round_flag) are returned at their natural period; period-512
/// columns are the full trace length. Winterfell / the generic compact path
/// materialise these onto the full-trace domain internally, so consumers
/// don't need to expand them here.
pub fn build_transfer_periodic_columns() -> Vec<Vec<BaseElement>> {
    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    // Round constants and round_flag: period 32 (all 16 cycles are valid hashes)
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

    // Boundary flag, over the WALK's cycles only.
    //
    // [C5-N1024] `0..16` was a literal that happened to equal
    // `TRACE_LENGTH / HASH_CYCLE_LEN` at 512. At 1024 it would have covered
    // only the first half of the trace, which is a silent prover/verifier
    // disagreement rather than a compile error.
    //
    // Bounded to the real cycles rather than the whole trace: `is_boundary`'s
    // only use is inside `not_boundary_active`, which is zero across the mask
    // anyway, so firing it there would cost a Horner term and mean nothing.
    let mut is_boundary = vec![BaseElement::ZERO; TRACE_LENGTH];
    for cycle in 0..FIRST_FREE_CYCLE {
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

    let chain_0_1 = make_flag(31);    // owner → cycle 1
    let chain_2_3 = make_flag(95);    // in1_left → cycle 3
    let chain_3_4 = make_flag(127);   // in_commit_1 → cycle 4
    let chain_5_6 = make_flag(191);   // in2_left → cycle 6
    let chain_6_7 = make_flag(223);   // in_commit_2 → cycle 7
    let chain_9_10 = make_flag(319);  // out1_left → cycle 10
    let chain_12_13 = make_flag(415); // out2_left → cycle 13

    let capture_owner = make_flag(NUM_ROUNDS);                               // row 30
    let capture_om = make_flag(HASH_CYCLE_LEN + NUM_ROUNDS);                 // row 62
    let capture_out1_rm = make_flag(8 * HASH_CYCLE_LEN + NUM_ROUNDS);        // row 286
    let capture_out2_rm = make_flag(11 * HASH_CYCLE_LEN + NUM_ROUNDS);       // row 382

    let om_to_3 = make_flag(95);
    let om_to_6 = make_flag(191);
    let owner_to_4 = make_flag(127);
    let owner_to_7 = make_flag(223);
    let out1_rm_to_10 = make_flag(319);
    let out2_rm_to_13 = make_flag(415);

    let mut out_rm_capture_any = vec![BaseElement::ZERO; TRACE_LENGTH];
    out_rm_capture_any[8 * HASH_CYCLE_LEN + NUM_ROUNDS] = BaseElement::ONE;
    out_rm_capture_any[11 * HASH_CYCLE_LEN + NUM_ROUNDS] = BaseElement::ONE;

    // ── Value-conservation amount-capture flags (one-hot at the amount rows) ──
    let add_in1 = make_flag(ROW_IN_AMOUNT_1);   // +in1 @64
    let add_in2 = make_flag(ROW_IN_AMOUNT_2);   // +in2 @160
    let sub_out1 = make_flag(ROW_OUT_AMOUNT_1); // -out1 @288
    let sub_out2 = make_flag(ROW_OUT_AMOUNT_2); // -out2 @384

    // acc continuity fires on every row that is NOT one of the four capture
    // rows. Built as 1 − (sum of the four one-hot flags).
    let mut acc_continuity = vec![BaseElement::ONE; TRACE_LENGTH];
    acc_continuity[ROW_IN_AMOUNT_1] = BaseElement::ZERO;
    acc_continuity[ROW_IN_AMOUNT_2] = BaseElement::ZERO;
    acc_continuity[ROW_OUT_AMOUNT_1] = BaseElement::ZERO;
    acc_continuity[ROW_OUT_AMOUNT_2] = BaseElement::ZERO;

    // -- APPENDED 2026-08-29: the two gates that make C5 zero-knowledge --
    //
    // THE BOUND IS `FIRST_FREE_ROW - 1`, NOT `FIRST_FREE_ROW`.
    //
    // These are TRANSITION constraints: the one at row i reads row i+1. Row 447
    // is the last witness row, and `acc_continuity[447] = 1`, so a gate left on
    // there would demand `mask[448][6] == acc4` -- unsatisfiable with fresh
    // randomness, and if it were satisfiable it would republish `public_amount`
    // inside the blinding region. Stopping one row early makes the 447 -> 448
    // transition entirely free.
    //
    // `not_boundary_active` is `active` pre-multiplied with `not_boundary`,
    // as a SEPARATE column rather than a product in the constraint body: the
    // degree-7 Poseidon constraints may carry exactly TWO periodic factors, and
    // they already spend both on `not_boundary` and `round_flag`. A third takes
    // ce_blowup_factor from 8 to 16.
    let mut active = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut not_boundary_active = vec![BaseElement::ZERO; TRACE_LENGTH];
    for row in 0..(FIRST_FREE_ROW - 1) {
        active[row] = BaseElement::ONE;
        if row % HASH_CYCLE_LEN != HASH_CYCLE_LEN - 1 {
            not_boundary_active[row] = BaseElement::ONE;
        }
    }

    vec![
        rc0, rc1, rc2, round_flag,       // 0-3: period 32
        is_boundary,                      // 4
        chain_0_1, chain_2_3, chain_3_4,  // 5-7
        chain_5_6, chain_6_7,             // 8-9
        chain_9_10, chain_12_13,          // 10-11
        capture_owner, capture_om,        // 12-13
        capture_out1_rm, capture_out2_rm, // 14-15
        om_to_3, om_to_6,                // 16-17
        owner_to_4, owner_to_7,          // 18-19
        out1_rm_to_10, out2_rm_to_13,    // 20-21
        out_rm_capture_any,              // 22
        add_in1, add_in2,                // 23-24
        sub_out1, sub_out2,              // 25-26
        acc_continuity,                  // 27
        active,                          // 28  APPENDED
        not_boundary_active,             // 29  APPENDED
    ]
}

/// Evaluate the 23 transition constraints for circuit 5 (transfer) at a
/// specific (current, next) frame using already-evaluated periodic values.
/// Used both by the Winterfell AIR and by compact.rs for the DEEP-ALI check.
pub fn evaluate_transfer_transition<E: FieldElement<BaseField = BaseElement>>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_flag = periodic[3];
    let is_boundary = periodic[4];
    let chain_0_1 = periodic[5];
    let chain_2_3 = periodic[6];
    let chain_3_4 = periodic[7];
    let chain_5_6 = periodic[8];
    let chain_6_7 = periodic[9];
    let chain_9_10 = periodic[10];
    let chain_12_13 = periodic[11];
    let capture_owner = periodic[12];
    let capture_om = periodic[13];
    let capture_out1_rm = periodic[14];
    let capture_out2_rm = periodic[15];
    let om_to_3 = periodic[16];
    let om_to_6 = periodic[17];
    let owner_to_4 = periodic[18];
    let owner_to_7 = periodic[19];
    let out1_rm_to_10 = periodic[20];
    let out2_rm_to_13 = periodic[21];
    let out_rm_capture_any = periodic[22];
    let add_in1 = periodic[23];
    let add_in2 = periodic[24];
    let sub_out1 = periodic[25];
    let sub_out2 = periodic[26];
    let acc_continuity = periodic[27];
    let active = periodic[28];
    let nba = periodic[29];

    // [C5-N1024] Every continuity constraint is pre-multiplied by `active`, and
    // the Poseidon rows use `nba` instead of `1 - is_boundary`.
    //
    // 🚨 `let not_boundary = E::ONE - is_boundary` USED TO STAND HERE AND MUST
    // NOT COME BACK. It and `nba` agree on every row of the fourteen real
    // cycles and differ only across rows 448..1023, so the substitution rejects
    // NO honest proof and passes every existing test -- while re-imposing the
    // Poseidon rounds on the 576 blinding rows.
    //
    // ⚠️ AND THE FOUR CONTINUITY ROWS MATTER MORE HERE THAN IN ANY OTHER
    // CIRCUIT. `result[11]`, `[13]`, `[22]` and `[27]` say "this carry column
    // does not change". Left ungated they pin cols 3, 4, 5 and 6 CONSTANT
    // across the whole mask -- one unknown per column instead of 576 -- which
    // is exactly the shape `air_aware_recovery_c5.rs` solves for all four note
    // amounts and for `owner`.
    //
    // ⚠️ COUNT THE PERIODIC FACTORS. `result[0..3]` carry `nba` and
    // `round_flag` over a degree-7 body: two, the maximum.

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

    result[0] = nba * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - round_flag * (ro2 - current[2]));

    // ── Direct col-0 chaining ──
    result[3] = chain_0_1 * (next[0] - current[0]);
    result[4] = chain_2_3 * (next[0] - current[0]);
    result[5] = chain_3_4 * (next[0] - current[0]);
    result[6] = chain_5_6 * (next[0] - current[0]);
    result[7] = chain_6_7 * (next[0] - current[0]);
    result[8] = chain_9_10 * (next[0] - current[0]);
    result[9] = chain_12_13 * (next[0] - current[0]);

    // ── carry_owner (col 3) ──
    result[10] = capture_owner * (next[3] - current[0]);
    result[11] = active * (E::ONE - capture_owner) * (next[3] - current[3]);

    // ── carry_owner_mint (col 4) ──
    result[12] = capture_om * (next[4] - current[0]);
    result[13] = active * (E::ONE - capture_om) * (next[4] - current[4]);

    // ── carry_owner_mint → right input ──
    result[14] = om_to_3 * (next[1] - current[4]);
    result[15] = om_to_6 * (next[1] - current[4]);

    // ── carry_owner → right input ──
    result[16] = owner_to_4 * (next[1] - current[3]);
    result[17] = owner_to_7 * (next[1] - current[3]);

    // ── carry_out_rm (col 5) ──
    result[18] = capture_out1_rm * (next[5] - current[0]);
    result[19] = out1_rm_to_10 * (next[1] - current[5]);
    result[20] = capture_out2_rm * (next[5] - current[0]);
    result[21] = out2_rm_to_13 * (next[1] - current[5]);

    // carry_out_rm continuity (except at capture points)
    result[22] = active * (E::ONE - out_rm_capture_any) * (next[5] - current[5]);

    // ── Value conservation (col 6 = acc) ──
    // At each amount row the amount sits at current[0]; fold it (signed) into
    // the accumulator: acc(next) = acc(current) ± current[0]. Everywhere else
    // the accumulator is held constant. The boundary assertion acc@row385 ==
    // public_amount then enforces the conservation relation in the convention
    // out1 + out2 - in1 - in2 == public_amount (positive public_amount = value
    // entering the shielded set / deposit; negative, field-encoded, = unshield).
    // `add_in*` flags fire at the input-amount rows (subtract inputs); the
    // `sub_out*` flags fire at the output-amount rows (add outputs).
    result[23] = add_in1 * (next[6] - current[6] + current[0]);
    result[24] = add_in2 * (next[6] - current[6] + current[0]);
    result[25] = sub_out1 * (next[6] - current[6] - current[0]);
    result[26] = sub_out2 * (next[6] - current[6] - current[0]);
    result[27] = active * acc_continuity * (next[6] - current[6]);
}

// ============================================================================
// Trace generation
// ============================================================================

/// Input note for the transfer.
pub struct TransferInput {
    pub amount: BaseElement,
    pub randomness: BaseElement,
}

/// Output note for the transfer.
pub struct TransferOutput {
    pub amount: BaseElement,
    pub recipient: BaseElement,
    pub randomness: BaseElement,
}

/// Build trace for transfer proof.
///
/// Returns (trace, nullifier_1, nullifier_2, in_commitment_1, in_commitment_2,
///          output_commitment_1, output_commitment_2).
pub fn build_transfer_trace(
    spending_key: BaseElement,
    token_mint: BaseElement,
    input_1: &TransferInput,
    input_2: &TransferInput,
    output_1: &TransferOutput,
    output_2: &TransferOutput,
    // The blinding region: `MASK_LEN` elements laid out ROW-MAJOR as
    // `i * TRACE_WIDTH + col`.
    //
    // ⛔ REQUIRED, NOT AN `Option`. A default would be a zero-filled or
    // witness-derived mask, which is exactly the failure this design exists to
    // prevent, and a caller who has not thought about randomness should not
    // compile. It MUST be fresh CSPRNG output, redrawn for every proof.
    mask: &[BaseElement],
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement) {
    assert_eq!(
        mask.len(),
        MASK_LEN,
        "C5 needs {MASK_LEN} blinding elements ({MASK_ROWS} rows x {TRACE_WIDTH} columns), got {}",
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
        if pad < TRACE_LENGTH {
            trace[0][pad] = state[0];
            trace[1][pad] = state[1];
            trace[2][pad] = state[2];
        }

        state[0]
    };

    // Cycle 0: owner
    let owner = run_hash(&mut trace, 0, spending_key, BaseElement::ZERO);
    // Cycle 1: owner_mint
    let owner_mint = run_hash(&mut trace, 1, owner, token_mint);
    // Cycle 2: in1_left
    let in1_left = run_hash(&mut trace, 2, input_1.amount, input_1.randomness);
    // Cycle 3: in_commitment_1
    let in_commitment_1 = run_hash(&mut trace, 3, in1_left, owner_mint);
    // Cycle 4: nullifier_1
    let nullifier_1 = run_hash(&mut trace, 4, in_commitment_1, owner);
    // Cycle 5: in2_left
    let in2_left = run_hash(&mut trace, 5, input_2.amount, input_2.randomness);
    // Cycle 6: in_commitment_2
    let in_commitment_2 = run_hash(&mut trace, 6, in2_left, owner_mint);
    // Cycle 7: nullifier_2
    let nullifier_2 = run_hash(&mut trace, 7, in_commitment_2, owner);
    // Cycle 8: out1_rm
    let out1_rm = run_hash(&mut trace, 8, output_1.recipient, token_mint);
    // Cycle 9: out1_left
    let out1_left = run_hash(&mut trace, 9, output_1.amount, output_1.randomness);
    // Cycle 10: output_commitment_1
    let output_commitment_1 = run_hash(&mut trace, 10, out1_left, out1_rm);
    // Cycle 11: out2_rm
    let out2_rm = run_hash(&mut trace, 11, output_2.recipient, token_mint);
    // Cycle 12: out2_left
    let out2_left = run_hash(&mut trace, 12, output_2.amount, output_2.randomness);
    // Cycle 13: output_commitment_2
    let output_commitment_2 = run_hash(&mut trace, 13, out2_left, out2_rm);
    // 🚨 CYCLES 14 AND 15 ARE GONE. They used to run `Poseidon(0, 0)` into rows
    // 448..511 — padding on a public constant, which is why they were safe to
    // delete and why they were never the reason C5 lacked a blinding region.
    // Those rows are now the start of the mask.

    // Fill carry columns — ONLY over the witness region.
    //
    // 🚨 `0..TRACE_LENGTH` USED TO STAND IN ALL FOUR OF THESE LOOPS, AND THAT
    // WAS THE LEAK. `owner`, `owner_mint` and `out2_rm` are secrets, and each
    // was written into every remaining row of its column, so the tail was a
    // FUNCTION of the witness rather than free. Combined with the continuity
    // constraints — which say "this column does not change" — each column
    // contributed ONE unknown across the whole tail instead of one per row,
    // and `air_aware_recovery_c5.rs` solves that in closed form for all four
    // note amounts and for `owner`.
    // col 3: carry_owner
    for row in 0..FIRST_FREE_ROW {
        trace[3][row] = if row <= NUM_ROUNDS { BaseElement::ZERO } else { owner };
    }
    // col 4: carry_owner_mint
    for row in 0..FIRST_FREE_ROW {
        trace[4][row] = if row <= HASH_CYCLE_LEN + NUM_ROUNDS { BaseElement::ZERO } else { owner_mint };
    }
    // col 5: carry_out_rm
    let capture1_row = 8 * HASH_CYCLE_LEN + NUM_ROUNDS;
    let capture2_row = 11 * HASH_CYCLE_LEN + NUM_ROUNDS;
    for row in 0..FIRST_FREE_ROW {
        trace[5][row] = if row <= capture1_row {
            BaseElement::ZERO
        } else if row <= capture2_row {
            out1_rm
        } else {
            out2_rm
        };
    }

    // col 6: value-conservation accumulator (convention:
    //   out1 + out2 - in1 - in2 == public_amount).
    // Captures fire at the transition OUT of each amount row, so the captured
    // value first appears at the row after the amount row:
    //   rows 0..=64   : 0
    //   rows 65..=160 : -in1
    //   rows 161..=288: -in1 - in2
    //   rows 289..=384: -in1 - in2 + out1
    //   rows 385..    : -in1 - in2 + out1 + out2  (== public_amount)
    let a_in1 = input_1.amount;
    let a_in2 = input_2.amount;
    let a_out1 = output_1.amount;
    let a_out2 = output_2.amount;
    let acc1 = BaseElement::ZERO - a_in1;
    let acc2 = acc1 - a_in2;
    let acc3 = acc2 + a_out1;
    let acc4 = acc3 + a_out2;
    for row in 0..FIRST_FREE_ROW {
        trace[6][row] = if row <= ROW_IN_AMOUNT_1 {
            BaseElement::ZERO
        } else if row <= ROW_IN_AMOUNT_2 {
            acc1
        } else if row <= ROW_OUT_AMOUNT_1 {
            acc2
        } else if row <= ROW_OUT_AMOUNT_2 {
            acc3
        } else {
            acc4
        };
    }

    // -- THE BLINDING REGION, 2026-08-29 --
    //
    // 576 rows x 7 columns of fresh uniform values. Each cell is its own
    // unknown, so the count runs against the wire instead of with it: 4,032
    // unknowns against `R = 4*22 + 2 = 90` published openings per column.
    for row in FIRST_FREE_ROW..TRACE_LENGTH {
        let base = (row - FIRST_FREE_ROW) * TRACE_WIDTH;
        for col in 0..TRACE_WIDTH {
            trace[col][row] = mask[base + col];
        }
    }

    (trace, nullifier_1, nullifier_2, in_commitment_1, in_commitment_2,
     output_commitment_1, output_commitment_2)
}

/// Compute transfer values without building trace.
pub fn compute_transfer(
    spending_key: BaseElement,
    token_mint: BaseElement,
    in1: &TransferInput,
    in2: &TransferInput,
    out1: &TransferOutput,
    out2: &TransferOutput,
) -> (BaseElement, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement) {
    let owner = poseidon::hash2(spending_key, BaseElement::ZERO);
    let owner_mint = poseidon::hash2(owner, token_mint);

    let in_commit_1 = poseidon::hash2(poseidon::hash2(in1.amount, in1.randomness), owner_mint);
    let in_commit_2 = poseidon::hash2(poseidon::hash2(in2.amount, in2.randomness), owner_mint);

    let null_1 = poseidon::hash2(in_commit_1, owner);
    let null_2 = poseidon::hash2(in_commit_2, owner);

    let out_commit_1 = poseidon::hash2(
        poseidon::hash2(out1.amount, out1.randomness),
        poseidon::hash2(out1.recipient, token_mint),
    );
    let out_commit_2 = poseidon::hash2(
        poseidon::hash2(out2.amount, out2.randomness),
        poseidon::hash2(out2.recipient, token_mint),
    );

    (null_1, null_2, in_commit_1, in_commit_2, out_commit_1, out_commit_2)
}

// ============================================================================
// Tests
// ============================================================================


/// A deterministic mask for the tests in this file. Adequate for TRACE SHAPE,
/// inadequate for any secrecy claim. The shipping path draws from `getrandom`.
#[cfg(test)]
fn deterministic_test_mask() -> Vec<BaseElement> {
    let mut z: u64 = 0xC5_5EED_0002;
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

    fn test_transfer_data() -> (BaseElement, BaseElement, TransferInput, TransferInput, TransferOutput, TransferOutput) {
        let sk = BaseElement::new(42);
        let mint = BaseElement::new(999);
        let in1 = TransferInput { amount: BaseElement::new(100), randomness: BaseElement::new(111) };
        let in2 = TransferInput { amount: BaseElement::new(50), randomness: BaseElement::new(222) };
        let out1 = TransferOutput {
            amount: BaseElement::new(80), recipient: BaseElement::new(555), randomness: BaseElement::new(333),
        };
        let out2 = TransferOutput {
            amount: BaseElement::new(70), recipient: BaseElement::new(666), randomness: BaseElement::new(444),
        };
        (sk, mint, in1, in2, out1, out2)
    }

    #[test]
    fn test_compute_deterministic() {
        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (n1a, n2a, _, _, oc1a, oc2a) = compute_transfer(sk, m, &in1, &in2, &out1, &out2);
        let (n1b, n2b, _, _, oc1b, oc2b) = compute_transfer(sk, m, &in1, &in2, &out1, &out2);
        assert_eq!(n1a, n1b);
        assert_eq!(n2a, n2b);
        assert_eq!(oc1a, oc1b);
        assert_eq!(oc2a, oc2b);
    }

    #[test]
    fn test_trace_matches_compute() {
        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (expected_n1, expected_n2, _, _, expected_oc1, expected_oc2) =
            compute_transfer(sk, m, &in1, &in2, &out1, &out2);
        let (trace, n1, n2, _, _, oc1, oc2) =
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        assert_eq!(n1, expected_n1);
        assert_eq!(n2, expected_n2);
        assert_eq!(oc1, expected_oc1);
        assert_eq!(oc2, expected_oc2);

        // Check trace output rows
        assert_eq!(trace[0][4 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_n1);
        assert_eq!(trace[0][7 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_n2);
        assert_eq!(trace[0][10 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_oc1);
        assert_eq!(trace[0][13 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_oc2);
    }

    #[test]
    fn test_carry_columns() {
        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (trace, _, _, _, _, _, _) = build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, m);

        // carry_owner
        assert_eq!(trace[3][0], BaseElement::ZERO);
        assert_eq!(trace[3][NUM_ROUNDS + 1], owner);
        // [C5-N1024] 447, NOT 511. Row 511 is inside the blinding region now,
        // and `owner` no longer appears there — that IS the change.
        assert_eq!(trace[3][FIRST_FREE_ROW - 1], owner);

        // ⛔ AND THE MASK MUST NOT CARRY IT. This is the assertion the old
        // `trace[3][511] == owner` was hiding: `owner` is the persistent
        // spender identity, and writing it into every remaining row made the
        // tail a function of the witness. If a future edit restores the
        // `0..TRACE_LENGTH` fill, this is what says so.
        let owner_in_mask = (FIRST_FREE_ROW..TRACE_LENGTH)
            .filter(|&r| trace[3][r] == owner)
            .count();
        assert_eq!(
            owner_in_mask, 0,
            "`owner` appears in {owner_in_mask} blinding rows; the carry fill has \
             escaped the witness region again",
        );

        // carry_owner_mint
        assert_eq!(trace[4][HASH_CYCLE_LEN + NUM_ROUNDS], BaseElement::ZERO);
        assert_eq!(trace[4][HASH_CYCLE_LEN + NUM_ROUNDS + 1], owner_mint);
    }

    #[test]
    fn test_chaining() {
        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (trace, _, _, _, _, _, _) = build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, m);

        // cycle 0→1: owner chains
        assert_eq!(trace[0][32], owner);
        // cycle 1 right = token_mint
        assert_eq!(trace[1][32], m);
        // cycle 3 right = owner_mint
        assert_eq!(trace[1][96], owner_mint);
        // cycle 4 right = owner
        assert_eq!(trace[1][128], owner);
    }

    #[test]
    fn test_winterfell_proof() {
        use crate::prover::{prove_generic, verify_generic};

        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (trace, n1, n2, _, _, oc1, oc2) =
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        // public_amount: in1.amount + in2.amount - out1.amount - out2.amount = 100+50-80-70 = 0
        let pub_inputs = TransferPublicInputs {
            nullifier_1: n1,
            nullifier_2: n2,
            output_commitment_1: oc1,
            output_commitment_2: oc2,
            public_amount: BaseElement::ZERO,
            token_mint: m,
        };

        let (proof, _) = prove_generic::<TransferAir>(trace, pub_inputs.clone())
            .expect("Transfer proof generation failed");

        verify_generic::<TransferAir>(proof, pub_inputs)
            .expect("Transfer proof verification failed");
    }

    #[test]
    fn test_winterfell_proof_with_public_amount() {
        use crate::prover::{prove_generic, verify_generic};

        let sk = BaseElement::new(42);
        let m = BaseElement::new(999);
        // Shield: 200 public → 200 private (1 input dummy, 1 output gets all)
        let in1 = TransferInput { amount: BaseElement::ZERO, randomness: BaseElement::new(111) };
        let in2 = TransferInput { amount: BaseElement::ZERO, randomness: BaseElement::new(222) };
        let out1 = TransferOutput {
            amount: BaseElement::new(200), recipient: BaseElement::new(555), randomness: BaseElement::new(333),
        };
        let out2 = TransferOutput {
            amount: BaseElement::ZERO, recipient: BaseElement::new(666), randomness: BaseElement::new(444),
        };

        let (trace, n1, n2, _, _, oc1, oc2) =
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        let pub_inputs = TransferPublicInputs {
            nullifier_1: n1,
            nullifier_2: n2,
            output_commitment_1: oc1,
            output_commitment_2: oc2,
            public_amount: BaseElement::new(200),
            token_mint: m,
        };

        let (proof, _) = prove_generic::<TransferAir>(trace, pub_inputs.clone())
            .expect("Shield proof generation failed");

        verify_generic::<TransferAir>(proof, pub_inputs)
            .expect("Shield proof verification failed");
    }

    /// [#2 voie A] Conservation accumulator (col 6) is filled correctly and
    /// the final value equals out1 + out2 - in1 - in2.
    #[test]
    fn test_conservation_accumulator_column() {
        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (trace, _, _, _, _, _, _) = build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        let z = BaseElement::ZERO;
        let expected_final = out1.amount + out2.amount - in1.amount - in2.amount;
        assert_eq!(trace[6][0], z, "acc starts at 0");
        assert_eq!(trace[6][ROW_IN_AMOUNT_1], z, "acc 0 up to in1 row");
        assert_eq!(trace[6][ROW_IN_AMOUNT_1 + 1], z - in1.amount, "acc = -in1 after capture");
        assert_eq!(trace[6][ROW_IN_AMOUNT_2 + 1], z - in1.amount - in2.amount);
        assert_eq!(trace[6][ROW_OUT_AMOUNT_1 + 1], z - in1.amount - in2.amount + out1.amount);
        assert_eq!(trace[6][ROW_ACC_FINAL], expected_final);

        // [C5-N1024] The accumulator holds its final value to the END OF THE
        // WALK, not to the end of the trace.
        assert_eq!(trace[6][FIRST_FREE_ROW - 1], expected_final);

        // ⛔ And not one row further. `expected_final == public_amount`, which
        // is a PUBLIC input — so leaving it in the mask would not leak a secret,
        // but it would leave 576 rows of column 6 pinned to a known constant,
        // and a pinned row is a row the counting argument cannot use.
        let final_in_mask = (FIRST_FREE_ROW..TRACE_LENGTH)
            .filter(|&r| trace[6][r] == expected_final)
            .count();
        assert_eq!(
            final_in_mask, 0,
            "the accumulator's final value appears in {final_in_mask} blinding rows",
        );
    }

    /// [#2 voie A] (i) A valid conserving witness still proves and verifies.
    /// 100 + 50 == 80 + 70 + 0, public_amount = 0.
    #[test]
    fn test_conservation_valid_witness_proves() {
        use crate::prover::{prove_generic, verify_generic};
        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (trace, n1, n2, _, _, oc1, oc2) =
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        let pub_inputs = TransferPublicInputs {
            nullifier_1: n1,
            nullifier_2: n2,
            output_commitment_1: oc1,
            output_commitment_2: oc2,
            public_amount: BaseElement::ZERO,
            token_mint: m,
        };

        let (proof, _) = prove_generic::<TransferAir>(trace, pub_inputs.clone())
            .expect("valid conserving witness must prove");
        verify_generic::<TransferAir>(proof, pub_inputs)
            .expect("valid conserving witness must verify");
    }

    /// [#2 voie A] (ii) A non-conserving witness (outputs exceed inputs) must
    /// NOT yield an accepted proof. Inputs sum to 150, outputs to 300, with
    /// public_amount claimed 0. The honest accumulator computes
    /// out-in = 300-150 = 150, which contradicts the asserted public_amount=0
    /// (mint-from-nothing of 150), so prove or verify must fail.
    #[test]
    fn test_conservation_non_conserving_witness_fails() {
        use crate::prover::{prove_generic, verify_generic};
        let sk = BaseElement::new(42);
        let m = BaseElement::new(999);
        let in1 = TransferInput { amount: BaseElement::new(100), randomness: BaseElement::new(111) };
        let in2 = TransferInput { amount: BaseElement::new(50), randomness: BaseElement::new(222) };
        // Outputs total 300 > inputs total 150: mint-from-nothing attempt.
        let out1 = TransferOutput { amount: BaseElement::new(150), recipient: BaseElement::new(555), randomness: BaseElement::new(333) };
        let out2 = TransferOutput { amount: BaseElement::new(150), recipient: BaseElement::new(666), randomness: BaseElement::new(444) };

        let (trace, n1, n2, _, _, oc1, oc2) =
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        // Attacker claims a balanced public_amount of 0.
        let pub_inputs = TransferPublicInputs {
            nullifier_1: n1,
            nullifier_2: n2,
            output_commitment_1: oc1,
            output_commitment_2: oc2,
            public_amount: BaseElement::ZERO,
            token_mint: m,
        };

        let result = std::panic::catch_unwind(|| {
            prove_generic::<TransferAir>(trace, pub_inputs.clone())
        });
        match result {
            Err(_) => { /* prover panicked: acceptable rejection */ }
            Ok(Err(_)) => { /* prover errored: acceptable rejection */ }
            Ok(Ok((proof, _))) => {
                let v = verify_generic::<TransferAir>(proof, pub_inputs);
                assert!(v.is_err(), "non-conserving witness must fail prove or verify");
            }
        }
    }

    /// [#2 voie A] (iii) Field wrap-around / overflow attempt. An attacker
    /// supplies an `out` amount near the field modulus so that, modulo p, the
    /// conservation relation holds while over the integers it does not (it
    /// represents a huge/"negative" amount). With the honest accumulator the
    /// asserted public_amount (a small u64) cannot match the wrapped sum, so the
    /// proof must be rejected. This documents why the out-of-circuit u64 range
    /// bound is required (see ConservationRangeNote).
    #[test]
    fn test_conservation_overflow_witness_fails() {
        use crate::prover::{prove_generic, verify_generic};
        let sk = BaseElement::new(42);
        let m = BaseElement::new(999);
        // p = 2^64 - 2^32 + 1. out2 is set to a near-modulus value (> 2^63),
        // i.e. an amount no honest u64 note could carry. The honest accumulator
        // computes out1 + out2 - in1 - in2 = 80 + huge - 150 = huge - 70 (field),
        // which cannot equal the asserted small public_amount, so the proof is
        // rejected. This is exactly the field-wrap class the out-of-circuit u64
        // bound must also guard against (see ConservationRangeNote).
        let huge = BaseElement::new(0xFFFF_FFFF_0000_0000); // near 2^64, > 2^63
        let in1 = TransferInput { amount: BaseElement::new(100), randomness: BaseElement::new(111) };
        let in2 = TransferInput { amount: BaseElement::new(50), randomness: BaseElement::new(222) };
        let out1 = TransferOutput { amount: BaseElement::new(80), recipient: BaseElement::new(555), randomness: BaseElement::new(333) };
        let out2 = TransferOutput { amount: huge, recipient: BaseElement::new(666), randomness: BaseElement::new(444) };

        let (trace, n1, n2, _, _, oc1, oc2) =
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2, &deterministic_test_mask());

        // Attacker claims public_amount = 0 (a balanced transfer).
        let pub_inputs = TransferPublicInputs {
            nullifier_1: n1,
            nullifier_2: n2,
            output_commitment_1: oc1,
            output_commitment_2: oc2,
            public_amount: BaseElement::ZERO,
            token_mint: m,
        };

        let result = std::panic::catch_unwind(|| {
            prove_generic::<TransferAir>(trace, pub_inputs.clone())
        });
        match result {
            Err(_) => {}
            Ok(Err(_)) => {}
            Ok(Ok((proof, _))) => {
                let v = verify_generic::<TransferAir>(proof, pub_inputs);
                assert!(v.is_err(), "overflow witness must fail prove or verify");
            }
        }
    }

    #[test]
    fn test_different_keys_different_nullifiers() {
        let m = BaseElement::new(999);
        let in1 = TransferInput { amount: BaseElement::new(100), randomness: BaseElement::new(111) };
        let in2 = TransferInput { amount: BaseElement::ZERO, randomness: BaseElement::ZERO };
        let out1 = TransferOutput {
            amount: BaseElement::new(100), recipient: BaseElement::new(555), randomness: BaseElement::new(333),
        };
        let out2 = TransferOutput {
            amount: BaseElement::ZERO, recipient: BaseElement::new(666), randomness: BaseElement::new(444),
        };

        let (n1a, _, _, _, _, _) = compute_transfer(BaseElement::new(42), m, &in1, &in2, &out1, &out2);
        let (n1b, _, _, _, _, _) = compute_transfer(BaseElement::new(43), m, &in1, &in2, &out1, &out2);
        assert_ne!(n1a, n1b);
    }
}
