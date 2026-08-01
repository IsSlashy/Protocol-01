//! Are the `honest_liveness` witnesses actually HONEST?
//!
//! # The measurement this protects
//!
//! `honest_liveness.rs` prints `160 of 160 honest proofs verified` per circuit
//! and asserts the rejected count is zero. That sentence is a claim about the
//! VERIFIER only if all 160 inputs were honest. If a generator emits witnesses
//! the AIR itself rejects, the suite measures nothing in either direction:
//!
//!   * a CORRECT rejection reads as a verifier liveness defect — this happened,
//!     for a full day, on C5 (2026-08-01), and the "obvious fix" would have
//!     deleted the phase-1 half of value conservation on the fund-moving
//!     circuit; and
//!   * conversely, a witness family that never exercises a row class can hide a
//!     real defect behind a clean 160/160.
//!
//! # What this test proves
//!
//! For all 160 witnesses of all seven circuits, without proving anything:
//!
//!   1. every public input the generator emits is the value obtained by
//!      re-deriving it from the private witness with the REFERENCE Poseidon
//!      (`p01_stark::poseidon::hash2`) — never the inlined round loop inside the
//!      trace builder, and never the `compute_*` helper the generator itself
//!      calls (which for C3 and C6 is a genuinely separate implementation from
//!      the trace builder, so this is not circular);
//!   2. every public input sits in the exact trace cell the AIR asserts on
//!      (`get_assertions` in each `air/*.rs`) — including C5's
//!      `acc(ROW_ACC_FINAL) == public_amount`, the assertion the broken
//!      generator violated;
//!   3. the AIR's own transition polynomial vanishes at EVERY frame of the trace
//!      the generator commits to, evaluated by the AIR's own exported evaluator;
//!   4. the relations that are not implied by construction hold: C5 value
//!      conservation, C4's on-chain conservation law, C3/C6 real Merkle folds
//!      at the canonical depth 15.
//!
//! This test does NOT prove or verify. It is seconds, not minutes, and it is
//! meant to be read as the precondition of the `honest_liveness` numbers.
//!
//! Run with: `cargo test -p p01_stark_verifier --release --test liveness_generator_semantics -- --nocapture`

mod common;

use common::WITNESSES;

#[test]
fn every_liveness_witness_satisfies_its_own_air() {
    for i in 0..WITNESSES {
        let w = common::w0(i);
        common::check_semantics_0(&w, &common::prove0(&w));
    }
    println!("[GEN] C0: {WITNESSES}/{WITNESSES} witnesses satisfy the AIR");

    for i in 0..WITNESSES {
        let w = common::w1(i);
        common::check_semantics_1(&w, &common::prove1(&w));
    }
    println!("[GEN] C1: {WITNESSES}/{WITNESSES} witnesses satisfy the AIR");

    for i in 0..WITNESSES {
        let w = common::w2(i);
        common::check_semantics_2(&w, &common::prove2(&w));
    }
    println!("[GEN] C2: {WITNESSES}/{WITNESSES} witnesses satisfy the AIR");

    for i in 0..WITNESSES {
        let w = common::w3(i);
        common::check_semantics_3(&w, &common::prove3(&w));
    }
    println!("[GEN] C3: {WITNESSES}/{WITNESSES} witnesses satisfy the AIR");

    for i in 0..WITNESSES {
        let w = common::w4(i);
        common::check_semantics_4(&w, &common::prove4(&w));
    }
    println!("[GEN] C4: {WITNESSES}/{WITNESSES} witnesses satisfy the AIR");

    for i in 0..WITNESSES {
        let w = common::w5(i);
        common::check_semantics_5(&w, &common::prove5(&w));
    }
    println!("[GEN] C5: {WITNESSES}/{WITNESSES} witnesses satisfy the AIR");

    for i in 0..WITNESSES {
        let w = common::w6(i);
        common::check_semantics_6(&w, &common::prove6(&w));
    }
    println!("[GEN] C6: {WITNESSES}/{WITNESSES} witnesses satisfy the AIR");
}

/// The guard has to be able to SEE a broken generator, or it is decoration.
///
/// This reproduces the exact shape of the 2026-08-01 C5 defect — inputs moving
/// with the witness index while the outputs and `public_amount` stay fixed — and
/// requires `check_semantics_5` to reject it. Without this, a future edit that
/// weakened the conservation check to a tautology would leave every test green.
#[test]
fn the_guard_rejects_the_c5_defect_it_was_written_for() {
    // `s = 3`: the ORIGINAL generator, before the fix. in1 = 80, in2 = 91,
    // out1 = 150, out2 = 65, public_amount = 50 → acc = 215 - 171 = 44 != 50.
    // A mint-from-nothing of 6 units.
    let broken = common::W5 {
        spending_key: 16,
        token_mint: 551,
        in_amount_1: 80,
        in_rand_1: 451,
        in_amount_2: 91,
        in_rand_2: 100,
        out_amount_1: 150,
        out_recipient_1: 1237,
        out_rand_1: 558,
        out_amount_2: 65,
        out_recipient_2: 2225,
        out_rand_2: 336,
        public_amount: 50,
    };
    let data = common::prove5(&broken);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        common::check_semantics_5(&broken, &data);
    }));
    assert!(
        outcome.is_err(),
        "\n\n  >>> THE GENERATOR GUARD IS BLIND <<<\n  \
         check_semantics_5 accepted a witness where out1 + out2 - in1 - in2 == 44 while \
         public_amount == 50. That is the literal 2026-08-01 defect, and the guard that \
         exists to catch it did not. Do not trust any honest_liveness number until this \
         passes.\n",
    );
}

/// C4 has no `active_rows` bound in `verify_constraints_confidential_balance`,
/// unlike C3 and C6. That is correct ONLY because C4's cycle 7 is a real
/// `Poseidon(0, 0)` rather than a frozen copy: `round_flag` is 1 across all
/// eight cycles and `build_confidential_balance_trace` runs a full hash there.
///
/// If someone ever "optimises" the padding cycle into a freeze, phase 1 would
/// start demanding `next == poseidon_round(current)` on rows 224..=253 against a
/// trace that holds `next == current`, and roughly one honest C4 proof in eight
/// would fail on chain with `TransitionConstraintFailed` — the C3 (2026-05-29)
/// and C6 (2026-08-01) defect, a third time. This pins the shape.
#[test]
fn c4_padding_cycle_is_a_real_hash_not_a_freeze() {
    let w = common::w4(0);
    // `check_semantics_4` carries the cycle-7 assertions and the full transition
    // sweep, which together are the statement. Named separately so the reason
    // survives in the test list.
    common::check_semantics_4(&w, &common::prove4(&w));
}
