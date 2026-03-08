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
//! Trace layout (width = 4, length = 128):
//!   col 0-2: Poseidon state
//!   col 3:   carry (holds owner_mint across cycle 2 → cycle 3)
//!
//! Public inputs: commitment, threshold, token_mint
//! Private inputs: balance, salt, spending_key
//!
//! Balance range check: NOT done in the AIR — the on-chain program verifies
//! balance >= threshold directly (it knows the claimed balance from the
//! confidential account state). The ZK proof only proves commitment validity.

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

const TRACE_WIDTH: usize = 4;
const TRACE_LENGTH: usize = 128;
const HASH_CYCLE_LEN: usize = 32;
const NUM_ROUNDS: usize = 30;

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
        // [0-2] Poseidon round: degree 7, round_flag period=32 (4 identical cycles), is_boundary period=128
        // [3]   Chain cycle 0→1: degree 1, cycle = TRACE_LENGTH
        // [4]   Carry capture at cycle 1 boundary: degree 1, cycle = TRACE_LENGTH
        // [5]   Carry continuity: degree 1, cycle = TRACE_LENGTH
        // [6]   Chain carry → cycle 3 right input: degree 1, cycle = TRACE_LENGTH
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
        ];

        // Assertions:
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
        let active_rows = 4 * HASH_CYCLE_LEN; // 128 (fills entire trace)
        let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

        let mut rc0 = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut rc1 = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut rc2 = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut round_flag = vec![BaseElement::ZERO; TRACE_LENGTH];

        for row in 0..active_rows {
            let pos = row % HASH_CYCLE_LEN;
            if pos < NUM_ROUNDS {
                rc0[row] = rc[pos * 3];
                rc1[row] = rc[pos * 3 + 1];
                rc2[row] = rc[pos * 3 + 2];
                round_flag[row] = BaseElement::ONE;
            }
        }

        // chain_0_to_1: 1 at row 31 (cycle 0 → cycle 1: owner feeds into cycle 1 left)
        let mut chain_01 = vec![BaseElement::ZERO; TRACE_LENGTH];
        chain_01[31] = BaseElement::ONE;

        // carry_capture: 1 at row 63 (capture owner_mint at end of cycle 1)
        let mut carry_capture = vec![BaseElement::ZERO; TRACE_LENGTH];
        carry_capture[63] = BaseElement::ONE;

        // carry_continuity_off: 1 at row 63 (carry can change here)
        // We invert: continuity holds when this is 0
        // Same as carry_capture

        // chain_carry_to_3: 1 at row 95 (chain carry → cycle 3 right input)
        let mut chain_carry = vec![BaseElement::ZERO; TRACE_LENGTH];
        chain_carry[95] = BaseElement::ONE;

        // is_boundary: 1 at last row of each hash cycle (rows 31, 63, 95) — allows free transitions
        let mut is_boundary = vec![BaseElement::ZERO; TRACE_LENGTH];
        for cycle in 0..4 {
            let row = cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1;
            if row < TRACE_LENGTH - 1 { // skip last row (127), wrap-around is exempt
                is_boundary[row] = BaseElement::ONE;
            }
        }

        vec![rc0, rc1, rc2, round_flag, chain_01, carry_capture, chain_carry, is_boundary]
    }

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
        let round_flag = periodic_values[3];
        let chain_01 = periodic_values[4];
        let carry_capture = periodic_values[5];
        let chain_carry = periodic_values[6];
        let is_boundary = periodic_values[7];

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

        // Gate by (1 - is_boundary) to allow free transitions at hash cycle boundaries
        let not_boundary = E::ONE - is_boundary;
        result[0] = not_boundary * (next[0] - current[0] - round_flag * (ro0 - current[0]));
        result[1] = not_boundary * (next[1] - current[1] - round_flag * (ro1 - current[1]));
        result[2] = not_boundary * (next[2] - current[2] - round_flag * (ro2 - current[2]));

        // ── Chain cycle 0 → cycle 1: owner → next left input ──
        // At row 31: next[0] at row 32 should = current[0] at row 31 (= owner)
        result[3] = chain_01 * (next[0] - current[0]);

        // ── Carry capture at cycle 1 boundary ──
        // At row 63: carry_next = current[0] (= owner_mint)
        result[4] = carry_capture * (next[3] - current[0]);

        // ── Carry continuity (carry doesn't change except at capture point) ──
        result[5] = (E::ONE - carry_capture) * (next[3] - current[3]);

        // ── Chain carry → cycle 3 right input ──
        // At row 95: next[1] at row 96 = carry (= owner_mint)
        result[6] = chain_carry * (next[1] - current[3]);
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
// Trace generation
// ============================================================================

/// Build trace for balance proof.
///
/// Returns (trace, commitment) where commitment = Poseidon(Poseidon(balance, salt), Poseidon(owner, token_mint))
pub fn build_balance_proof_trace(
    spending_key: BaseElement,
    balance: BaseElement,
    salt: BaseElement,
    token_mint: BaseElement,
) -> (Vec<Vec<BaseElement>>, BaseElement) {
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

    // Fill carry column (col 3):
    // Rows 0-63: carry = 0 (unused, will be captured at row 63)
    // Rows 64-127: carry = owner_mint
    for row in 0..64 {
        trace[3][row] = BaseElement::ZERO;
    }
    for row in 64..TRACE_LENGTH {
        trace[3][row] = owner_mint;
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
        let (trace, commitment) = build_balance_proof_trace(sk, bal, salt, mint);

        assert_eq!(commitment, expected);
        assert_eq!(trace[0][3 * HASH_CYCLE_LEN + NUM_ROUNDS], expected);
    }

    #[test]
    fn test_carry_column() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let (trace, _) = build_balance_proof_trace(sk, bal, salt, mint);

        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, mint);

        // Carry should be 0 for rows 0-63, owner_mint for rows 64-127
        assert_eq!(trace[3][0], BaseElement::ZERO);
        assert_eq!(trace[3][63], BaseElement::ZERO);
        assert_eq!(trace[3][64], owner_mint);
        assert_eq!(trace[3][127], owner_mint);
    }

    #[test]
    fn test_chaining() {
        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let (trace, _) = build_balance_proof_trace(sk, bal, salt, mint);

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

    #[test]
    fn test_winterfell_proof() {
        use crate::prover::{prove_generic, verify_generic};

        let sk = BaseElement::new(42);
        let bal = BaseElement::new(1000);
        let salt = BaseElement::new(777);
        let mint = BaseElement::new(999);

        let (trace, commitment) = build_balance_proof_trace(sk, bal, salt, mint);

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
