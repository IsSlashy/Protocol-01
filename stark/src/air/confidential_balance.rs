//! Confidential Balance STARK AIR
//!
//! Proves a valid balance update without revealing amounts.
//! Handles 4 operations: DEPOSIT, WITHDRAW, SEND (private), RECEIVE (private).
//!
//! Computation (7 chained Poseidon_t3 hashes + 1 padding hash):
//!   Cycle 0: owner        = Poseidon(spending_key, 0)
//!   Cycle 1: owner_mint   = Poseidon(owner, token_mint)       — chained from cycle 0
//!   Cycle 2: amount_hash  = Poseidon(amount, amount_salt)     — independent
//!   Cycle 3: old_bal_salt = Poseidon(old_balance, old_salt)   — independent
//!   Cycle 4: old_commit   = Poseidon(old_bal_salt, owner_mint)— chained from cycles 1 & 3
//!   Cycle 5: new_bal_salt = Poseidon(new_balance, new_salt)   — independent
//!   Cycle 6: new_commit   = Poseidon(new_bal_salt, owner_mint)— chained from cycles 1 & 5
//!   Cycle 7: padding      = Poseidon(0, 0)                   — dummy (fills power-of-2)
//!
//! Trace layout (width = 4, length = 256):
//!   cols 0-2: Poseidon state (t=3)
//!   col 3:    carry (holds owner_mint from cycle 1, reused in cycles 4 & 6)
//!
//! Conservation law enforced on-chain (not in AIR):
//!   old_balance + (1-is_debit)*amount + public_credit
//!     = new_balance + is_debit*amount + public_debit
//!
//! Public inputs: old_commitment, new_commitment, amount_hash, token_mint
//! Private inputs: spending_key, old_balance, old_salt, new_balance, new_salt,
//!                 amount, amount_salt

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

pub const TRACE_WIDTH: usize = 4;
pub const TRACE_LENGTH: usize = 256;
pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;
/// Number of transition constraints in C4 (confidential_balance).
pub const CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS: usize = 10;
/// Number of periodic columns in C4 (confidential_balance).
pub const CONFIDENTIAL_BALANCE_NUM_PERIODIC: usize = 11;

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
        // Poseidon constraints [0-2]: multiply by round_flag (period 32) and is_boundary (period 256)
        // Chaining constraints [3-9]: only use period-256 flags
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(7, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),
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
// [P2.2d-C4] Standalone periodic-column builder and transition evaluator
//
// Both are shared by:
//   * the Winterfell AIR (delegated to from get_periodic_column_values /
//     evaluate_transition),
//   * the compact-proof prover (compute_quotient_lde_circuit_4 in
//     stark/src/compact.rs),
//   * the DEEP-ALI end-to-end test (merkle_update_e2e equivalent for C4),
//   * the on-chain verifier tests (compact/tests exercising the same
//     constraint form the verifier evaluates via periodic polynomials).
// ============================================================================

/// [P2.2d-C4] Build the 11 periodic columns for confidential_balance.
///
/// Layout matches the C4 constraint evaluator:
/// `[rc0, rc1, rc2, round_flag, is_boundary, chain_01, chain_34, chain_56,
///   carry_capture, chain_carry_4, chain_carry_6]`.
///
/// Columns 0-3 have true period 32 (every cycle is a valid Poseidon hash).
/// Columns 4-10 have period 256 since they differ per cycle (chain edges
/// and cycle boundaries fire at specific rows only).
pub fn build_confidential_balance_periodic_columns() -> Vec<Vec<BaseElement>> {
    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    let mut rc0 = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut rc1 = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut rc2 = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut round_flag = vec![BaseElement::ZERO; TRACE_LENGTH];

    // Period-32 round constants + round_flag, repeated every cycle across
    // the full 256-row trace. Even though they share the value of cycle 0,
    // we materialise the length-256 form so the prover/verifier can use a
    // single polynomial per column without needing two different periods.
    for cycle in 0..(TRACE_LENGTH / HASH_CYCLE_LEN) {
        for pos in 0..NUM_ROUNDS {
            let row = cycle * HASH_CYCLE_LEN + pos;
            rc0[row] = rc[pos * 3];
            rc1[row] = rc[pos * 3 + 1];
            rc2[row] = rc[pos * 3 + 2];
            round_flag[row] = BaseElement::ONE;
        }
    }

    // is_boundary: 1 at last row of each hash cycle (rows 31, 63, ..., 223)
    // NOT at row 255 (last row exempt from wrap-around by construction).
    let mut is_boundary = vec![BaseElement::ZERO; TRACE_LENGTH];
    for cycle in 0..(TRACE_LENGTH / HASH_CYCLE_LEN) {
        let row = cycle * HASH_CYCLE_LEN + HASH_CYCLE_LEN - 1;
        if row < TRACE_LENGTH - 1 {
            is_boundary[row] = BaseElement::ONE;
        }
    }

    // chain_0_1: 1 at row 31 — cycle 0 output (owner) is forced onto cycle 1 left input.
    let mut chain_01 = vec![BaseElement::ZERO; TRACE_LENGTH];
    chain_01[31] = BaseElement::ONE;

    // chain_3_4: 1 at row 127 — cycle 3 output (old_bal_salt) → cycle 4 left.
    let mut chain_34 = vec![BaseElement::ZERO; TRACE_LENGTH];
    chain_34[127] = BaseElement::ONE;

    // chain_5_6: 1 at row 191 — cycle 5 output (new_bal_salt) → cycle 6 left.
    let mut chain_56 = vec![BaseElement::ZERO; TRACE_LENGTH];
    chain_56[191] = BaseElement::ONE;

    // carry_capture: 1 at row 63 — captures cycle 1 output (owner_mint) into
    // carry col (col 3).
    let mut carry_capture = vec![BaseElement::ZERO; TRACE_LENGTH];
    carry_capture[63] = BaseElement::ONE;

    // chain_carry_4: 1 at row 127 — carry (owner_mint) → cycle 4 right input.
    let mut chain_carry_4 = vec![BaseElement::ZERO; TRACE_LENGTH];
    chain_carry_4[127] = BaseElement::ONE;

    // chain_carry_6: 1 at row 191 — carry (owner_mint) → cycle 6 right input.
    let mut chain_carry_6 = vec![BaseElement::ZERO; TRACE_LENGTH];
    chain_carry_6[191] = BaseElement::ONE;

    vec![
        rc0, rc1, rc2, round_flag, is_boundary,
        chain_01, chain_34, chain_56,
        carry_capture, chain_carry_4, chain_carry_6,
    ]
}

/// [P2.2d-C4] Evaluate the 10 transition constraints at a single row.
///
/// Shape matches `evaluate_balance_proof_transition` but with width=4 + 8 cycles
/// (256 rows) and chain edges at rows 31 / 63 / 127 / 191. Same Poseidon
/// constraint form `not_boundary · (next[i] − current[i] − round_flag ·
/// (ro_i − current[i]))` — when round_flag=1 → next=ro (active round);
/// when round_flag=0 → next=current (padding); when is_boundary=1 → free.
pub fn evaluate_confidential_balance_transition<E: FieldElement<BaseField = BaseElement>>(
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
    let chain_01 = periodic[5];
    let chain_34 = periodic[6];
    let chain_56 = periodic[7];
    let carry_capture = periodic[8];
    let chain_carry_4 = periodic[9];
    let chain_carry_6 = periodic[10];

    let not_boundary = E::ONE - is_boundary;

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

    result[0] = not_boundary * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = not_boundary * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = not_boundary * (next[2] - current[2] - round_flag * (ro2 - current[2]));

    // ── Chaining constraints ──
    result[3] = chain_01 * (next[0] - current[0]);       // cycle 0→1: owner
    result[4] = chain_34 * (next[0] - current[0]);       // cycle 3→4: old_bal_salt
    result[5] = chain_56 * (next[0] - current[0]);       // cycle 5→6: new_bal_salt
    result[6] = carry_capture * (next[3] - current[0]);  // capture owner_mint
    result[7] = (E::ONE - carry_capture) * (next[3] - current[3]); // carry continuity
    result[8] = chain_carry_4 * (next[1] - current[3]);  // carry→cycle 4 right
    result[9] = chain_carry_6 * (next[1] - current[3]);  // carry→cycle 6 right
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build trace for confidential balance proof.
///
/// Returns (trace, old_commitment, new_commitment, amount_hash).
pub fn build_confidential_balance_trace(
    spending_key: BaseElement,
    old_balance: BaseElement,
    old_salt: BaseElement,
    new_balance: BaseElement,
    new_salt: BaseElement,
    amount: BaseElement,
    amount_salt: BaseElement,
    token_mint: BaseElement,
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement, BaseElement) {
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
        if pad < TRACE_LENGTH {
            trace[0][pad] = state[0];
            trace[1][pad] = state[1];
            trace[2][pad] = state[2];
        }

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

    // Cycle 7: padding = Poseidon(0, 0) — dummy hash to fill power-of-2
    let _ = run_hash(&mut trace, 7, BaseElement::ZERO, BaseElement::ZERO);

    // Fill carry column (col 3): 0 before capture, owner_mint after
    for row in 0..TRACE_LENGTH {
        if row <= 63 {
            trace[3][row] = BaseElement::ZERO;
        } else {
            trace[3][row] = owner_mint;
        }
    }

    (trace, old_commitment, new_commitment, amount_hash)
}

/// Compute commitments without building trace.
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
        let (trace, oc, nc, ah) =
            build_confidential_balance_trace(sk, ob, os, nb, ns, a, as_, m);

        assert_eq!(oc, expected_oc);
        assert_eq!(nc, expected_nc);
        assert_eq!(ah, expected_ah);
        assert_eq!(trace[0][2 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_ah);
        assert_eq!(trace[0][4 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_oc);
        assert_eq!(trace[0][6 * HASH_CYCLE_LEN + NUM_ROUNDS], expected_nc);
    }

    #[test]
    fn test_carry_column() {
        let (sk, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (trace, _, _, _) = build_confidential_balance_trace(sk, ob, os, nb, ns, a, as_, m);
        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, m);

        assert_eq!(trace[3][0], BaseElement::ZERO);
        assert_eq!(trace[3][63], BaseElement::ZERO);
        assert_eq!(trace[3][64], owner_mint);
        assert_eq!(trace[3][255], owner_mint);
    }

    #[test]
    fn test_chaining() {
        let (sk, ob, os, nb, ns, a, as_, m) = test_inputs();
        let (trace, _, _, _) = build_confidential_balance_trace(sk, ob, os, nb, ns, a, as_, m);
        let owner = poseidon::hash2(sk, BaseElement::ZERO);
        let owner_mint = poseidon::hash2(owner, m);

        // Cycle 0 output = owner, feeds cycle 1
        assert_eq!(trace[0][NUM_ROUNDS], owner);
        assert_eq!(trace[0][32], owner);
        assert_eq!(trace[1][32], m);

        // Cycle 4 and 6 right inputs = owner_mint
        assert_eq!(trace[1][128], owner_mint);
        assert_eq!(trace[1][192], owner_mint);
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

        let (trace, oc, nc, ah) = build_confidential_balance_trace(
            sk, ob, os, nb, ns, BaseElement::ZERO, BaseElement::ZERO, m);

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
        let (trace, oc, nc, ah) = build_confidential_balance_trace(
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
    fn test_winterfell_proof_receive() {
        use crate::prover::{prove_generic, verify_generic};

        let (trace, oc, nc, ah) = build_confidential_balance_trace(
            BaseElement::new(42),
            BaseElement::new(200), BaseElement::new(100),
            BaseElement::new(230), BaseElement::new(200),
            BaseElement::new(30), BaseElement::new(300), BaseElement::new(999));

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
