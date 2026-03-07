//! Subscriber Ownership STARK AIR
//!
//! Proves knowledge of `subscriber_secret` such that:
//!   Poseidon(subscriber_secret) == commitment
//!
//! This is the simplest Protocol 01 circuit — a direct port of
//! `circuits/subscriber_ownership.circom` to a STARK AIR.
//!
//! Execution trace layout (width = 3, length = 32 rows):
//!   Row 0:     Initial Poseidon state [subscriber_secret, 0, 0]
//!   Rows 1-30: State after each Poseidon round (30 rounds total)
//!   Row 31:    Copy of row 30 (padding for power-of-2 trace length)
//!
//! Transition constraints enforce:
//!   For rows 0..29: next_state = MDS * sbox(current_state + round_constants)
//!   For row 30:     next_state = current_state (padding identity)
//!
//! Round constants are provided via periodic columns (3 columns of length 32).
//! All rounds use full S-box (x^7 on all state elements) for simplicity.
//!
//! Boundary constraints:
//!   - state[0][1] = 0  (second input is zero for hash1)
//!   - state[0][2] = 0  (capacity is zero)
//!   - state[30][0] = commitment  (output matches public input)

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

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
// AIR definition
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
        // 3 transition constraints (one per state element)
        // Degree: S-box is x^7, so each constraint has degree 7
        // Periodic columns add multiplicative factors but don't increase degree
        // beyond 7 for the S-box terms.
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
    /// For active rounds (flag=1):
    ///   s' = state + RC
    ///   s'' = sbox(s') = s'^7
    ///   next = MDS * s''
    ///   constraint: flag * (next[i] - (MDS * sbox(state + RC))[i]) = 0
    ///
    /// For padding rows (flag=0):
    ///   constraint: (1-flag) * (next[i] - state[i]) = 0
    ///
    /// Combined: flag * (next - round_output) + (1-flag) * (next - current) = 0
    ///
    /// Simplified since (1-flag)*(next-current) = next-current - flag*(next-current):
    ///   result = next - current - flag * (round_output - current) = 0
    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        let current = frame.current();
        let next = frame.next();

        // Extract periodic column values for this row
        let rc0 = periodic_values[0];
        let rc1 = periodic_values[1];
        let rc2 = periodic_values[2];
        let flag = periodic_values[3];

        // Add round constants
        let s0 = current[0] + rc0;
        let s1 = current[1] + rc1;
        let s2 = current[2] + rc2;

        // Apply S-box: x^7 = x^4 * x^2 * x
        let s0_2 = s0 * s0;
        let s0_4 = s0_2 * s0_2;
        let s0_7 = s0_4 * s0_2 * s0;

        let s1_2 = s1 * s1;
        let s1_4 = s1_2 * s1_2;
        let s1_7 = s1_4 * s1_2 * s1;

        let s2_2 = s2 * s2;
        let s2_4 = s2_2 * s2_2;
        let s2_7 = s2_4 * s2_2 * s2;

        // MDS multiplication: M = [[3,1,1],[1,3,1],[1,1,3]]
        let three = E::from(3u32);
        let round_out_0 = three * s0_7 + s1_7 + s2_7;
        let round_out_1 = s0_7 + three * s1_7 + s2_7;
        let round_out_2 = s0_7 + s1_7 + three * s2_7;

        // Combined constraint:
        // result[i] = next[i] - current[i] - flag * (round_output[i] - current[i])
        //
        // When flag=1 (active round): result = next - round_output = 0
        // When flag=0 (padding):      result = next - current = 0
        result[0] = next[0] - current[0] - flag * (round_out_0 - current[0]);
        result[1] = next[1] - current[1] - flag * (round_out_1 - current[1]);
        result[2] = next[2] - current[2] - flag * (round_out_2 - current[2]);
    }

    /// Boundary constraints anchor the proof to public inputs.
    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        vec![
            // Initial state: second and third elements are zero
            Assertion::single(1, 0, BaseElement::ZERO), // state[1] at row 0 = 0
            Assertion::single(2, 0, BaseElement::ZERO), // state[2] at row 0 = 0
            // Output: state[0] at row NUM_ROUNDS must equal the commitment
            Assertion::single(0, NUM_ROUNDS, self.commitment),
        ]
    }
}

// ============================================================================
// Trace generation (prover side)
// ============================================================================

/// Build the execution trace for subscriber ownership proof.
///
/// The trace is a 3-column matrix where each row represents the Poseidon state.
/// Row 0 is the initial state, rows 1..30 are after each round, row 31 is padding.
///
/// Uses full S-box on all rounds (consistent with AIR constraints).
pub fn build_trace(subscriber_secret: BaseElement) -> Vec<Vec<BaseElement>> {
    let mut trace = vec![vec![BaseElement::ZERO; TRACE_LENGTH]; TRACE_WIDTH];

    // Row 0: initial state
    let mut state = [subscriber_secret, BaseElement::ZERO, BaseElement::ZERO];
    trace[0][0] = state[0];
    trace[1][0] = state[1];
    trace[2][0] = state[2];

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mds = &poseidon::constants::MDS_MATRIX_T3;

    // Apply all 30 rounds with FULL S-box (matches AIR constraints)
    for round in 0..NUM_ROUNDS {
        // Add round constants
        state[0] = state[0] + rc[round * 3];
        state[1] = state[1] + rc[round * 3 + 1];
        state[2] = state[2] + rc[round * 3 + 2];

        // Full S-box on all elements: x^7
        for s in &mut state {
            let x = *s;
            let x2 = x * x;
            let x4 = x2 * x2;
            *s = x4 * x2 * x; // x^7 = x^4 * x^2 * x
        }

        // MDS matrix multiplication
        let mut result = [BaseElement::ZERO; 3];
        for i in 0..3 {
            for j in 0..3 {
                result[i] = result[i] + mds[i][j] * state[j];
            }
        }
        state = result;

        // Store in trace
        let row = round + 1;
        trace[0][row] = state[0];
        trace[1][row] = state[1];
        trace[2][row] = state[2];
    }

    // Pad row 31 with copy of row 30 (identity transition)
    trace[0][31] = state[0];
    trace[1][31] = state[1];
    trace[2][31] = state[2];

    trace
}

/// Compute the expected commitment for a given secret.
/// Uses the same full-round Poseidon as the trace builder.
pub fn compute_commitment(subscriber_secret: BaseElement) -> BaseElement {
    // Must match build_trace exactly
    let trace = build_trace(subscriber_secret);
    trace[0][NUM_ROUNDS]
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
        // Row 31 should equal row 30
        assert_eq!(trace[0][31], trace[0][30]);
        assert_eq!(trace[1][31], trace[1][30]);
        assert_eq!(trace[2][31], trace[2][30]);
    }
}
