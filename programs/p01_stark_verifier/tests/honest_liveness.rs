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
//! # C7
//!
//! [WP0a 2026-09-18] Until this date the suite proved C0 through C6 and never
//! generated a C7 witness, while `ci.yml` described it as what proves an honest
//! C7 proof clears both phases. The dispatcher below had carried a `7 =>` arm
//! since 2026-08-24 and nothing called it. C7 now runs on the same
//! `common::w7` family `c7_binding` and `b2_segment_binding` use, each witness
//! checked by `check_semantics_7` below before it is proved.
//!
//! Run with: `cargo test -p p01_stark_verifier --release --test honest_liveness -- --nocapture`

mod common;

use common::WITNESSES;
use p01_stark_verifier::compact_proof::{
    get_circuit_config, CompactStarkProof, GenericCompactProof,
};
use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::{
    verify_deep_ali_circuit_0_masked, verify_deep_ali_circuit_1, verify_deep_ali_circuit_2,
    verify_deep_ali_circuit_3,
    verify_deep_ali_circuit_4, verify_deep_ali_circuit_5, verify_deep_ali_circuit_6,
    verify_deep_ali_circuit_7,
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
        // [ZK-MASK-C0 2026-09-11] The masked C0 runs its phase 2 inline on chain;
        // here it is the same function, called after phase 1.
        0 => verify_deep_ali_circuit_0_masked(proof, public_inputs),
        1 => verify_deep_ali_circuit_1(proof, public_inputs),
        2 => verify_deep_ali_circuit_2(proof, public_inputs),
        3 => verify_deep_ali_circuit_3(proof, public_inputs),
        4 => verify_deep_ali_circuit_4(proof, public_inputs),
        5 => verify_deep_ali_circuit_5(proof, public_inputs),
        6 => verify_deep_ali_circuit_6(proof, public_inputs),
        7 => verify_deep_ali_circuit_7(proof, public_inputs),
        // [C7 2026-08-24] Was `_ => Ok(())`. A circuit added to the fixture
        // list but forgotten here passed phase 2 VACUOUSLY -- a false green in
        // the one suite whose job is to prove honest proofs clear BOTH phases.
        _ => Err(VerifyError::UnsupportedCircuit),
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
    // [WP0a 2026-09-18] Per-circuit wall time, printed, so the CI budget of the
    // slow-pins job can be read off one run instead of guessed.
    let started = std::time::Instant::now();
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
    println!("[LIVENESS] {label}: wall time {:.1}s", started.elapsed().as_secs_f64());
    o
}

// ============================================================================
// [WP0a 2026-09-18] C7 witness semantics
// ============================================================================

/// The C7 twin of `common::check_semantics_*`: the witness is an honest spend
/// BEFORE its proof is counted.
///
/// It lives here rather than in `common/mod.rs` only because WP0a's file set is
/// this suite; moving it there (and running it from
/// `liveness_generator_semantics.rs`) is the natural follow-up.
///
/// Same contract as its siblings:
///   * every public input is re-derived from the private witness along an
///     INDEPENDENT path — the reference `poseidon::hash2`, never
///     `air::spend::compute_spend_values` / `compute_spend_root`, which the
///     generator itself uses;
///   * the public inputs are pinned to the exact trace cells the AIR asserts on,
///     read from `SPEND_BOUNDARY_SPEC`, and the commitment to the cell that
///     carries it (it is NOT public, so no boundary assertion names it);
///   * the AIR's own transition polynomial vanishes at every frame of the trace
///     the generator commits to, the masked rows included.
fn check_semantics_7(w: &common::W7, data: &p01_stark::compact::GenericCompactProofData) {
    use p01_stark::air::spend;
    use p01_stark::poseidon::hash2;
    use p01_stark::BaseElement;
    let f = BaseElement::new;

    assert_eq!(w.path_elements.len(), spend::CANONICAL_DEPTH, "C7: depth is fixed by the trace layout");
    assert_eq!(w.path_indices.len(), spend::CANONICAL_DEPTH, "C7: index count must match the path");
    assert_eq!(w.mask.len(), spend::MASK_LEN, "C7: mask length");

    // The note, rebuilt from its preimages by the reference permutation.
    let nullifier = hash2(f(w.nullifier_preimage), f(w.secret));
    let commitment = hash2(nullifier, hash2(f(w.blinding), f(w.token_mint)));
    let mut root = commitment;
    for (e, &d) in w.path_elements.iter().zip(w.path_indices.iter()) {
        assert!(d == 0 || d == 1, "C7: path index must be binary, got {d}");
        root = if d == 0 { hash2(root, f(*e)) } else { hash2(f(*e), root) };
    }

    assert_eq!(data.circuit_id, 7, "C7: generator returned the wrong circuit id");
    assert_eq!(data.public_inputs.len(), spend::SPEND_NUM_PUBLIC_INPUTS, "C7: six public inputs");
    assert_eq!(f(data.public_inputs[0]), nullifier, "C7: nullifier is not Poseidon(preimage, secret)");
    assert_eq!(f(data.public_inputs[1]), root, "C7: root is not the real fold of the commitment");
    assert_eq!(&data.public_inputs[2..6], &w.recipient_hash[..], "C7: recipient hash limbs");

    let elems: Vec<BaseElement> = w.path_elements.iter().map(|&v| f(v)).collect();
    let (trace, t_nullifier, t_root) = spend::build_spend_trace(
        f(w.nullifier_preimage), f(w.secret), f(w.blinding), f(w.token_mint),
        &elems, &w.path_indices, &w.mask,
    );
    assert_eq!(t_nullifier, nullifier, "C7: the trace builder's nullifier");
    assert_eq!(t_root, root, "C7: the trace builder's root");
    assert_eq!(trace.len(), spend::TRACE_WIDTH, "C7: trace width");

    for &(col, row, source) in spend::SPEND_BOUNDARY_SPEC.iter() {
        let want = source.map(|i| f(data.public_inputs[i])).unwrap_or(BaseElement::new(0));
        assert_eq!(trace[col][row], want, "C7: boundary cell col {col} row {row}");
    }
    assert_eq!(
        trace[6][spend::ROW_COMMITMENT_OUT], commitment,
        "C7: the commitment row does not carry the commitment of this witness",
    );
    assert!(
        spend::ROW_MERKLE_ROOT_OUT < spend::FIRST_FREE_ROW,
        "the root row must stay OUT of the blinding region",
    );

    common::sweep_transitions(
        "C7",
        &trace,
        &spend::build_spend_periodic_columns(),
        spend::SPEND_NUM_CONSTRAINTS,
        spend::evaluate_spend_transition,
    );
}

/// ANTI-VACUITY for `check_semantics_7`: it must refuse a proof whose claimed
/// root is not the fold of its own witness. A semantic check that accepts
/// anything would let the C7 count below measure nothing, which is the exact
/// failure the 2026-08-01 C5 generator taught this suite.
#[test]
#[should_panic(expected = "C7: root is not the real fold of the commitment")]
fn check_semantics_7_refuses_a_root_that_is_not_the_witness_fold() {
    let w = common::w7(0);
    let mut d = common::prove7(&w);
    d.public_inputs[1] = (d.public_inputs[1] + 1) % 0xFFFF_FFFF_0000_0001;
    check_semantics_7(&w, &d);
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
        let started = std::time::Instant::now();
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
        println!("[LIVENESS] C0: wall time {:.1}s", started.elapsed().as_secs_f64());
        rejected.push(("C0", o.failures.len()));
    }

    // [ZK-MASK-C0 2026-09-11] The SHIPPING circuit 0 -- masked, generic, both
    // phases -- measured on the same 160 witnesses as the legacy control above.
    let c0m = run_generic("C0 masked", |i| {
        let w = common::w0(i);
        let d = common::prove0_masked(&w);
        common::check_semantics_0_masked(&w, &d);
        d
    });
    rejected.push(("C0 masked", c0m.failures.len()));

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

    // [WP0a 2026-09-18] C7, the spend circuit — both phases, like every generic
    // circuit above, through `verify_phase2`'s `7 =>` arm, which nothing had
    // called before this line existed.
    let c7 = run_generic("C7", |i| {
        let w = common::w7(i);
        let d = common::prove7(&w);
        check_semantics_7(&w, &d);
        d
    });
    rejected.push(("C7", c7.failures.len()));

    let total: usize = rejected.iter().map(|(_, n)| n).sum();
    // [WP0a] Was a literal `WITNESSES * 8`; the run count is the list's length.
    println!("[LIVENESS] TOTAL rejected honest proofs: {total} of {}", WITNESSES * rejected.len());
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
