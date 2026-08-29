//! WHERE C5 value conservation is enforced, and where it is not.
//!
//! # Why this file exists
//!
//! `tests/honest_liveness.rs` used to report C5 rejecting a few percent of its
//! witnesses with `BoundaryConstraintFailed` at trace row 385. Row 385 is
//! `ROW_ACC_FINAL` — the value-conservation boundary `acc(385) == public_amount`.
//!
//! Those were not honest witnesses. The generator held the two output amounts
//! and `public_amount` fixed while both input amounts moved with the witness
//! index, so every witness but the first claimed `public_amount = 50` while its
//! accumulator held `50 - 2s`: a mint-from-nothing of `2s` units. The suite was
//! counting correct rejections as liveness failures, and the natural way to make
//! it green — relaxing the row-385 boundary check — would have deleted the
//! phase-1 half of the conservation gate.
//!
//! The generator is fixed. This file exists so the case it used to cover by
//! accident is covered on purpose, and so the phase-1/phase-2 split is a
//! measurement instead of a comment.
//!
//! # The split this file pins
//!
//! On chain a C5 proof clears two INSTRUCTIONS:
//!   * phase 1, `verify_stark_proof_v2` → `verify::verify_generic`
//!   * phase 2, `verify_deep_ali_phase2` → `verify::verify_deep_ali_circuit_5`
//!
//! Phase 1 does not bind col 6 (`acc`) in its per-query transition check at all
//! — that is deliberate and documented in `verify_constraints_transfer`. Its
//! only contact with conservation is the row-385 boundary assertion, which fires
//! solely when a trace-aligned query happens to land on that one row. Phase 2 is
//! where conservation is actually enforced, at a random OOD point, on every
//! proof.
//!
//! So the number that matters is: **a consumer that runs phase 1 and skips phase
//! 2 has no meaningful value-conservation check.** `phase1_alone_does_not_enforce
//! _conservation` measures exactly how weak that is, and
//! `phase2_rejects_every_non_conserving_witness` proves phase 2 closes it.
//!
//! Run: `cargo test -p p01_stark_verifier --release --test c5_conservation_probe -- --nocapture`

use p01_stark_verifier::compact_proof::{get_circuit_config, GenericCompactProof};
use p01_stark_verifier::verify::{verify_deep_ali_circuit_5, verify_generic, VerifyError};

struct Verdict {
    phase1: Result<(), VerifyError>,
    phase2: Result<(), VerifyError>,
}

/// One C5 proof, parameterised so a witness can be made to conserve or not.
///
/// Conservation relation the AIR asserts:
///   `acc(385) = out1 + out2 - in1 - in2 == public_amount`
#[allow(clippy::too_many_arguments)]
fn prove_c5(s: u64, in1: u64, in2: u64, out1: u64, out2: u64, public_amount: u64) -> Verdict {
    let data = p01_stark::compact::generate_transfer_compact_proof(
        13 + s,        // spending_key
        500 + s * 17,  // token_mint
        in1,           // in_amount_1
        400 + s * 17,  // in_rand_1
        in2,           // in_amount_2
        100,           // in_rand_2
        out1,          // out_amount_1
        1234 + s,      // out_recipient_1
        555 + s,       // out_rand_1
        out2,          // out_amount_2
        2222 + s,      // out_recipient_2
        333 + s,       // out_rand_2
        public_amount, &p01_stark::compact::c5_deterministic_probe_mask(), // public_amount
    );
    let config = get_circuit_config(5).expect("C5 config");
    let proof = GenericCompactProof::from_bytes(&data.proof_bytes, config)
        .expect("a well-formed C5 proof must parse");
    Verdict {
        phase1: verify_generic(&proof, data.circuit_id, &data.public_inputs, config),
        phase2: verify_deep_ali_circuit_5(&proof, &data.public_inputs),
    }
}

/// Baseline. A conserving witness must clear BOTH phases, every time.
///
/// `out1` moves with `s` so that `out1 + out2 - in1 - in2` stays exactly equal
/// to `public_amount`: the query positions vary, the conservation relation does
/// not. If this goes red the verifier has a real liveness defect.
#[test]
fn conserving_witnesses_clear_both_phases() {
    const N: u64 = 32;
    let mut bad = Vec::new();
    for s in 0..N {
        let (in1, in2) = (77 + s, 88 + s);
        let (out1, out2) = (150 + 2 * s, 65u64);
        let public_amount = (out1 + out2) - (in1 + in2);
        assert_eq!(public_amount, 50, "witness {s} must stay conserving");
        let v = prove_c5(s, in1, in2, out1, out2, public_amount);
        if v.phase1.is_err() || v.phase2.is_err() {
            bad.push((s, v.phase1, v.phase2));
        }
    }
    println!(
        "[C5-CONSERVE] conserving witnesses: {} of {N} cleared both phases, {} rejected",
        N as usize - bad.len(),
        bad.len(),
    );
    assert!(
        bad.is_empty(),
        "the verifier rejected a CONSERVING honest C5 witness: {bad:?}"
    );
}

/// Phase 2 must reject every mint-from-nothing witness. This is the gate.
#[test]
fn phase2_rejects_every_non_conserving_witness() {
    const N: u64 = 32;
    let mut accepted = Vec::new();
    for s in 1..=N {
        // acc(385) = 215 - (165 + 2s) = 50 - 2s, but the claim is always 50.
        // Every one of these mints 2s units of the token out of nothing.
        let v = prove_c5(s, 77 + s, 88 + s, 150, 65, 50);
        if v.phase2.is_ok() {
            accepted.push(s);
        }
    }
    println!(
        "[C5-CONSERVE] phase 2 vs mint-from-nothing: {} of {N} rejected, {} accepted {accepted:?}",
        N as usize - accepted.len(),
        accepted.len(),
    );
    assert!(
        accepted.is_empty(),
        "\n\n  >>> C5 VALUE CONSERVATION IS NOT ENFORCED <<<\n  \
         phase-2 DEEP-ALI ACCEPTED {} of {N} transfer proofs that mint value out \
         of nothing. C5 is the fund-moving circuit.\n",
        accepted.len(),
    );
}

/// How weak is phase 1 on its own? A measurement, not a demand.
///
/// This does NOT assert that phase 1 rejects — it cannot, by design. It asserts
/// the far weaker thing that phase 1 is not the gate, and prints the acceptance
/// rate so the cost of skipping phase 2 is a number on the record rather than an
/// assumption. Any consumer that treats `verified = true` as sufficient inherits
/// this rate directly.
#[test]
fn phase1_alone_does_not_enforce_conservation() {
    const N: u64 = 32;
    let mut phase1_accepted = 0usize;
    let mut phase1_errors: Vec<String> = Vec::new();
    for s in 1..=N {
        let v = prove_c5(s, 77 + s, 88 + s, 150, 65, 50);
        match v.phase1 {
            Ok(()) => phase1_accepted += 1,
            Err(e) => phase1_errors.push(format!("{e:?}")),
        }
        assert!(
            v.phase2.is_err(),
            "witness {s} mints value and must be rejected by phase 2"
        );
    }
    phase1_errors.sort();
    phase1_errors.dedup();
    println!(
        "[C5-CONSERVE] phase 1 ALONE vs mint-from-nothing: {phase1_accepted} of {N} ACCEPTED \
         ({:.1}%); rejecting errors seen: {phase1_errors:?}",
        100.0 * phase1_accepted as f64 / N as f64,
    );
    assert!(
        phase1_accepted > 0,
        "phase 1 unexpectedly rejected EVERY non-conserving witness. If that is now \
         true the comment in `verify_constraints_transfer` saying col 6 is left to \
         phase 2 is stale, and this test should be re-derived rather than deleted."
    );
}
