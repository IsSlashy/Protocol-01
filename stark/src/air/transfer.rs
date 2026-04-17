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
//! Trace layout (width = 6, length = 512):
//!   cols 0-2: Poseidon state (t=3)
//!   col 3:    carry_owner (holds owner from cycle 0)
//!   col 4:    carry_owner_mint (holds owner_mint from cycle 1)
//!   col 5:    carry_out_rm (holds output recipient×mint hashes)
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

pub const TRACE_WIDTH: usize = 6;
pub const TRACE_LENGTH: usize = 512;
pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;

/// Number of transition constraints in the transfer AIR (circuit 5).
pub const TRANSFER_NUM_CONSTRAINTS: usize = 23;

/// Number of periodic columns: rc0, rc1, rc2, round_flag, is_boundary,
/// 7 direct chain flags, 4 carry-capture flags, 6 carry→right-input flags,
/// 1 carry-capture-any flag.
pub const TRANSFER_NUM_PERIODIC: usize = 23;

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
        ];

        // Assertions:
        // Capacity at each cycle start (14 active + 2 padding = 16)
        // + nullifier outputs + output commitment outputs + token_mint inputs
        let num_assertions = 24;
        let context = AirContext::new(trace_info, degrees, num_assertions, options);

        Self {
            context,
            nullifier_1: pub_inputs.nullifier_1,
            nullifier_2: pub_inputs.nullifier_2,
            output_commitment_1: pub_inputs.output_commitment_1,
            output_commitment_2: pub_inputs.output_commitment_2,
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

        // Capacity (col 2) = 0 at start of each of 16 cycles
        for cycle in 0..16 {
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

        assertions
    }
}

#[inline(always)]
fn pow7<E: FieldElement>(x: E) -> E {
    let x2 = x * x;
    let x4 = x2 * x2;
    x4 * x2 * x
}

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

    // Boundary flag: period 512
    let mut is_boundary = vec![BaseElement::ZERO; TRACE_LENGTH];
    for cycle in 0..16 {
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

    vec![
        rc0, rc1, rc2, round_flag,       // 0-3: period 32
        is_boundary,                      // 4: period 512
        chain_0_1, chain_2_3, chain_3_4,  // 5-7
        chain_5_6, chain_6_7,             // 8-9
        chain_9_10, chain_12_13,          // 10-11
        capture_owner, capture_om,        // 12-13
        capture_out1_rm, capture_out2_rm, // 14-15
        om_to_3, om_to_6,                // 16-17
        owner_to_4, owner_to_7,          // 18-19
        out1_rm_to_10, out2_rm_to_13,    // 20-21
        out_rm_capture_any,              // 22
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

    let not_boundary = E::ONE - is_boundary;

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

    result[0] = not_boundary * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = not_boundary * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = not_boundary * (next[2] - current[2] - round_flag * (ro2 - current[2]));

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
    result[11] = (E::ONE - capture_owner) * (next[3] - current[3]);

    // ── carry_owner_mint (col 4) ──
    result[12] = capture_om * (next[4] - current[0]);
    result[13] = (E::ONE - capture_om) * (next[4] - current[4]);

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
    result[22] = (E::ONE - out_rm_capture_any) * (next[5] - current[5]);
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
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement, BaseElement) {
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
    // Cycles 14-15: padding
    let _ = run_hash(&mut trace, 14, BaseElement::ZERO, BaseElement::ZERO);
    let _ = run_hash(&mut trace, 15, BaseElement::ZERO, BaseElement::ZERO);

    // Fill carry columns
    // col 3: carry_owner
    for row in 0..TRACE_LENGTH {
        trace[3][row] = if row <= NUM_ROUNDS { BaseElement::ZERO } else { owner };
    }
    // col 4: carry_owner_mint
    for row in 0..TRACE_LENGTH {
        trace[4][row] = if row <= HASH_CYCLE_LEN + NUM_ROUNDS { BaseElement::ZERO } else { owner_mint };
    }
    // col 5: carry_out_rm
    let capture1_row = 8 * HASH_CYCLE_LEN + NUM_ROUNDS;
    let capture2_row = 11 * HASH_CYCLE_LEN + NUM_ROUNDS;
    for row in 0..TRACE_LENGTH {
        trace[5][row] = if row <= capture1_row {
            BaseElement::ZERO
        } else if row <= capture2_row {
            out1_rm
        } else {
            out2_rm
        };
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
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2);

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
        let (trace, _, _, _, _, _, _) = build_transfer_trace(sk, m, &in1, &in2, &out1, &out2);

        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, m);

        // carry_owner
        assert_eq!(trace[3][0], BaseElement::ZERO);
        assert_eq!(trace[3][NUM_ROUNDS + 1], owner);
        assert_eq!(trace[3][511], owner);

        // carry_owner_mint
        assert_eq!(trace[4][HASH_CYCLE_LEN + NUM_ROUNDS], BaseElement::ZERO);
        assert_eq!(trace[4][HASH_CYCLE_LEN + NUM_ROUNDS + 1], owner_mint);
    }

    #[test]
    fn test_chaining() {
        let (sk, m, in1, in2, out1, out2) = test_transfer_data();
        let (trace, _, _, _, _, _, _) = build_transfer_trace(sk, m, &in1, &in2, &out1, &out2);

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
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2);

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
            build_transfer_trace(sk, m, &in1, &in2, &out1, &out2);

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
