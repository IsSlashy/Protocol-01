//! Does the shipped verifier accept EVERY honest proof, or only most of them?
//!
//! # Where this came from
//!
//! Not from reading the code. It came out of a mutation: forcing every query
//! position to be congruent to `0 mod blowup` made honest C3 and C6 proofs fail
//! with `TransitionConstraintFailed`. The mutation did not touch trace
//! generation, so the only thing it changed was WHICH rows got queried — which
//! means there exist trace rows where the shipped phase-1 per-query check
//! rejects an honest trace.
//!
//! Every honest-path test in this repo proves exactly one witness per circuit.
//! One witness draws one set of ~22-27 pseudorandom positions, of which ~1 in 16
//! is trace-aligned, so a per-row defect that costs a few percent of proofs is
//! invisible to a fixed-witness suite and shows up in production as "the
//! transaction sometimes fails, re-prove and it works".
//!
//! So this file proves MANY witnesses per circuit and counts. It is a
//! measurement first: the numbers are printed before anything is asserted.
//!
//! # What the assertion means
//!
//! Zero. A prover that follows the protocol must never produce a proof the
//! verifier rejects, because the user cannot tell that failure apart from a
//! forgery attempt, and on chain it costs them the fee and the transaction.
//!
//! # The precondition
//!
//! [2026-08-02] Every witness this file proves is now checked against its own
//! AIR before it is verified — see `tests/common/mod.rs`. The witness family
//! itself lives there, so this suite and `liveness_generator_semantics.rs`
//! cannot drift apart. That check is not decoration: on 2026-08-01 the C5
//! generator here was emitting mint-from-nothing witnesses, and their CORRECT
//! rejection was read as a verifier liveness defect for a full day. A liveness
//! number measured on invalid witnesses is not a number.
//!
//! Run with: `cargo test -p p01_stark_verifier --release --test honest_liveness -- --nocapture`

mod common;

use common::WITNESSES;
use p01_stark_verifier::compact_proof::{
    get_circuit_config, CompactStarkProof, GenericCompactProof,
};
use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::{
    verify_deep_ali_circuit_1, verify_deep_ali_circuit_2, verify_deep_ali_circuit_3,
    verify_deep_ali_circuit_4, verify_deep_ali_circuit_5, verify_deep_ali_circuit_6,
    verify_generic, verify_subscriber_ownership, VerifyError,
};

/// [2026-08-01] Phase 2 is a SEPARATE on-chain instruction
/// (`verify_deep_ali_phase2`) and this suite used to skip it entirely, so it
/// measured only half the verifier. An honest proof has to clear BOTH phases —
/// on chain a phase-2 failure costs the user exactly as much as a phase-1 one.
fn verify_phase2(
    proof: &GenericCompactProof,
    circuit_id: u8,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    match circuit_id {
        1 => verify_deep_ali_circuit_1(proof, public_inputs),
        2 => verify_deep_ali_circuit_2(proof, public_inputs),
        3 => verify_deep_ali_circuit_3(proof, public_inputs),
        4 => verify_deep_ali_circuit_4(proof, public_inputs),
        5 => verify_deep_ali_circuit_5(proof, public_inputs),
        6 => verify_deep_ali_circuit_6(proof, public_inputs),
        _ => Ok(()),
    }
}

struct Outcome {
    ok: usize,
    failures: Vec<(usize, VerifyError, Vec<usize>)>,
    /// Aligned trace rows seen in a proof that VERIFIED.
    good_rows: Vec<usize>,
    /// Aligned trace rows seen in a proof that was REJECTED.
    bad_rows: Vec<usize>,
}

fn aligned_rows(positions: &[u32], blowup: usize, trace_length: usize) -> Vec<usize> {
    positions
        .iter()
        .map(|&p| p as usize)
        .filter(|p| p % blowup == 0)
        .map(|p| (p / blowup) % trace_length)
        .collect()
}

fn report(label: &str, o: &Outcome) {
    println!(
        "[LIVENESS] {label}: {} of {WITNESSES} honest proofs verified, {} REJECTED",
        o.ok,
        o.failures.len(),
    );
    for (i, err, rows) in o.failures.iter().take(6) {
        let mut r = rows.clone();
        r.sort_unstable();
        println!("    witness {i}: {err:?}; aligned trace rows {r:?}");
    }
    if !o.bad_rows.is_empty() {
        let mut only_bad: Vec<usize> = o
            .bad_rows
            .iter()
            .copied()
            .filter(|r| !o.good_rows.contains(r))
            .collect();
        only_bad.sort_unstable();
        only_bad.dedup();
        let mut good: Vec<usize> = o.good_rows.clone();
        good.sort_unstable();
        good.dedup();
        println!(
            "    rows seen ONLY in rejected proofs: {only_bad:?}\n    \
             rows seen in at least one accepted proof: {} distinct",
            good.len(),
        );
    }
}

fn run_generic<F>(label: &str, mut make: F) -> Outcome
where
    F: FnMut(usize) -> p01_stark::compact::GenericCompactProofData,
{
    let mut o = Outcome { ok: 0, failures: Vec::new(), good_rows: Vec::new(), bad_rows: Vec::new() };
    for i in 0..WITNESSES {
        let data = make(i);
        let config = get_circuit_config(data.circuit_id).expect("config");
        let proof = GenericCompactProof::from_bytes(&data.proof_bytes, config)
            .unwrap_or_else(|| panic!("{label} witness {i}: honest proof must parse"));
        let positions: Vec<u32> = proof.queries.iter().map(|q| q.position).collect();
        let rows = aligned_rows(&positions, config.blowup, config.trace_length);
        // Both phases, in the on-chain order. Phase 1 first, then the mandatory
        // phase-2 DEEP-ALI instruction.
        let verdict = verify_generic(&proof, data.circuit_id, &data.public_inputs, config)
            .and_then(|()| verify_phase2(&proof, data.circuit_id, &data.public_inputs));
        match verdict {
            Ok(()) => {
                o.ok += 1;
                o.good_rows.extend(rows);
            }
            Err(e) => {
                o.bad_rows.extend(rows.iter().copied());
                o.failures.push((i, e, rows));
            }
        }
    }
    report(label, &o);
    o
}

#[test]
fn every_honest_proof_verifies_on_every_circuit() {
    let mut rejected: Vec<(&str, usize)> = Vec::new();

    // C0 — legacy path, its own parser and entry point.
    {
        let mut o = Outcome {
            ok: 0,
            failures: Vec::new(),
            good_rows: Vec::new(),
            bad_rows: Vec::new(),
        };
        let config = get_circuit_config(0).expect("C0 config");
        for i in 0..WITNESSES {
            let w = common::w0(i);
            let data = common::prove0(&w);
            common::check_semantics_0(&w, &data);
            let proof = CompactStarkProof::from_bytes(&data.proof_bytes)
                .unwrap_or_else(|| panic!("C0 witness {i}: honest proof must parse"));
            let positions: Vec<u32> = proof.queries.iter().map(|q| q.position).collect();
            let rows = aligned_rows(&positions, config.blowup, config.trace_length);
            match verify_subscriber_ownership(&proof, Felt::new(data.commitment)) {
                Ok(()) => {
                    o.ok += 1;
                    o.good_rows.extend(rows);
                }
                Err(e) => {
                    o.bad_rows.extend(rows.iter().copied());
                    o.failures.push((i, e, rows));
                }
            }
        }
        report("C0", &o);
        rejected.push(("C0", o.failures.len()));
    }

    let c1 = run_generic("C1", |i| {
        let w = common::w1(i);
        let d = common::prove1(&w);
        common::check_semantics_1(&w, &d);
        d
    });
    rejected.push(("C1", c1.failures.len()));

    let c2 = run_generic("C2", |i| {
        let w = common::w2(i);
        let d = common::prove2(&w);
        common::check_semantics_2(&w, &d);
        d
    });
    rejected.push(("C2", c2.failures.len()));

    let c3 = run_generic("C3", |i| {
        let w = common::w3(i);
        let d = common::prove3(&w);
        common::check_semantics_3(&w, &d);
        d
    });
    rejected.push(("C3", c3.failures.len()));

    let c4 = run_generic("C4", |i| {
        let w = common::w4(i);
        let d = common::prove4(&w);
        common::check_semantics_4(&w, &d);
        d
    });
    rejected.push(("C4", c4.failures.len()));

    // [2026-08-01] THE C5 GENERATOR WAS NOT PRODUCING HONEST WITNESSES.
    //
    // It held `out_amount_1 = 150`, `out_amount_2 = 65` and `public_amount = 50`
    // fixed while `in_amount_1 = 77 + s` and `in_amount_2 = 88 + s` both moved
    // with the witness index. The C5 AIR asserts
    //   acc(row 385) = out1 + out2 - in1 - in2 == public_amount
    // so the accumulator held `215 - (165 + 2s) = 50 - 2s` against a claimed 50:
    // every witness with `s != 0` was a mint-from-nothing of `2s` units, not an
    // honest proof. Its rejections were CORRECT rejections being counted as
    // liveness failures — and the "obvious fix" of relaxing the row-385 boundary
    // check to make them go green would have removed the phase-1 half of the
    // value-conservation gate.
    //
    // `out_amount_1` now moves with `s` too, so the relation holds identically
    // at `public_amount = 50` while the trace, and therefore the query
    // positions, still vary with every witness. The non-conserving case it used
    // to cover by accident is covered on purpose, and far more strongly, in
    // `tests/c5_conservation_probe.rs`.
    //
    // [2026-08-02] `common::w5` is now the ONLY definition of these numbers and
    // `common::check_semantics_5` asserts the conservation relation on every
    // single one before it is proved, so this cannot silently regress.
    let c5 = run_generic("C5", |i| {
        let w = common::w5(i);
        let d = common::prove5(&w);
        common::check_semantics_5(&w, &d);
        d
    });
    rejected.push(("C5", c5.failures.len()));

    let c6 = run_generic("C6", |i| {
        let w = common::w6(i);
        let d = common::prove6(&w);
        common::check_semantics_6(&w, &d);
        d
    });
    rejected.push(("C6", c6.failures.len()));

    let total: usize = rejected.iter().map(|(_, n)| n).sum();
    println!("[LIVENESS] TOTAL rejected honest proofs: {total} of {}", WITNESSES * 7);
    assert_eq!(
        total, 0,
        "\n\n  >>> THE VERIFIER REJECTS HONEST PROOFS <<<\n  \
         Per circuit, out of {WITNESSES} witnesses each: {rejected:?}\n  \
         An honest prover produced a proof the shipped verifier refuses. On chain \
         that is an indistinguishable-from-forgery failure that costs the user the \
         fee, and no fixed-witness test can see it — every honest-path test in this \
         repo proves exactly ONE witness per circuit.\n",
    );
}
