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

const TRACE_WIDTH: usize = 3;
const TRACE_LENGTH: usize = 128;
const HASH_CYCLE_LEN: usize = 32;
const NUM_ROUNDS: usize = 30;
const NUM_HASH_CYCLES: usize = 3;

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
        let active_rows = NUM_HASH_CYCLES * HASH_CYCLE_LEN; // 96

        let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

        // Round constants + round flag (period = TRACE_LENGTH)
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

        // chain_flag: 1 only at row 63 (boundary of cycle 1, for chaining epoch_hash)
        let mut chain_flag = vec![BaseElement::ZERO; TRACE_LENGTH];
        chain_flag[63] = BaseElement::ONE;

        // is_boundary: 1 at last row of each hash cycle (row 31, 63) — allows free transitions
        let mut is_boundary = vec![BaseElement::ZERO; TRACE_LENGTH];
        for cycle in 0..NUM_HASH_CYCLES {
            is_boundary[cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1] = BaseElement::ONE;
        }

        vec![rc0, rc1, rc2, round_flag, chain_flag, is_boundary]
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
        let chain_flag = periodic_values[4];
        let is_boundary = periodic_values[5];

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

        // ── Chain: epoch_hash → cycle 2 right input ──
        // At row 63 (end of cycle 1): next[1] at row 64 should = current[0] at row 63 (epoch_hash)
        result[3] = chain_flag * (next[1] - current[0]);
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
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement) {
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

    // Padding rows 96-127: copy last state
    let last = [trace[0][95], trace[1][95], trace[2][95]];
    for row in 96..TRACE_LENGTH {
        trace[0][row] = last[0];
        trace[1][row] = last[1];
        trace[2][row] = last[2];
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
        let (trace, null, commit) = build_pool_commitment_trace(np, secret, epoch, mint);

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

        let (trace, nullifier, _) = build_pool_commitment_trace(np, secret, epoch, mint);

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

        let (trace, nullifier, commitment) = build_pool_commitment_trace(np, secret, epoch, mint);

        let pub_inputs = DenominatedPoolPublicInputs { nullifier, commitment };

        let (proof, _) = prove_generic::<DenominatedPoolAir>(trace, pub_inputs.clone())
            .expect("Pool commitment proof generation failed");

        verify_generic::<DenominatedPoolAir>(proof, pub_inputs)
            .expect("Pool commitment proof verification failed");
    }

    #[test]
    fn test_wrong_nullifier_fails_prove() {
        use crate::prover::prove_generic;

        let np = BaseElement::new(111);
        let secret = BaseElement::new(222);
        let epoch = BaseElement::new(333);
        let mint = BaseElement::new(444);

        let (trace, _, commitment) = build_pool_commitment_trace(np, secret, epoch, mint);

        let wrong_pub_inputs = DenominatedPoolPublicInputs {
            nullifier: BaseElement::new(999),
            commitment,
        };

        // Winterfell panics on assertion mismatch instead of returning Err
        let result = std::panic::catch_unwind(|| {
            prove_generic::<DenominatedPoolAir>(trace, wrong_pub_inputs)
        });
        assert!(result.is_err(), "Proof with wrong nullifier should fail");
    }
}
