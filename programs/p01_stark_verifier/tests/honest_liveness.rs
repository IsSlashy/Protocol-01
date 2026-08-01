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
//! Run with: `cargo test -p p01_stark_verifier --release --test honest_liveness -- --nocapture`

use p01_stark_verifier::compact_proof::{
    get_circuit_config, CompactStarkProof, GenericCompactProof,
};
use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::{verify_generic, verify_subscriber_ownership, VerifyError};

/// Witnesses per circuit. Each one is a full prove + verify.
const WITNESSES: usize = 32;

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
        match verify_generic(&proof, data.circuit_id, &data.public_inputs, config) {
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
            let data = p01_stark::compact::generate_compact_proof(42 + i as u64 * 7919);
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
        let s = i as u64;
        p01_stark::compact::generate_pool_commitment_proof(111 + s, 222 + s * 3, 333 + s * 5, 444 + s * 7)
    });
    rejected.push(("C1", c1.failures.len()));

    let c2 = run_generic("C2", |i| {
        let s = i as u64;
        p01_stark::compact::generate_balance_compact_proof(42 + s, 1000 + s * 11, 777 + s, 999 + s * 3)
    });
    rejected.push(("C2", c2.failures.len()));

    let c3 = run_generic("C3", |i| {
        let s = i as u64;
        let pe: Vec<u64> = (0..15u64).map(|j| 1000 + j + s * 31).collect();
        let pi: Vec<u8> = (0..15u8).map(|j| ((j as usize + i) % 2) as u8).collect();
        p01_stark::compact::generate_merkle_path_compact_proof(777 + s, &pe, &pi)
    });
    rejected.push(("C3", c3.failures.len()));

    let c4 = run_generic("C4", |i| {
        let s = i as u64;
        p01_stark::compact::generate_confidential_balance_compact_proof(
            42 + s, 1000 + s * 13, 111 + s, 800 + s * 13, 222 + s, 200, 333 + s, 999 + s,
        )
    });
    rejected.push(("C4", c4.failures.len()));

    let c5 = run_generic("C5", |i| {
        let s = i as u64;
        p01_stark::compact::generate_transfer_compact_proof(
            13 + s, 500 + s * 17, 77 + s, 400 + s * 17, 88 + s, 100, 150, 1234 + s, 555 + s, 65,
            2222 + s, 333 + s, 50,
        )
    });
    rejected.push(("C5", c5.failures.len()));

    let c6 = run_generic("C6", |i| {
        let s = i as u64;
        let pe: Vec<u64> = (0..15u64).map(|j| 100 + j * 13 + s * 37).collect();
        let pi: Vec<u8> = (0..15u8).map(|j| ((j as usize + i) % 2) as u8).collect();
        p01_stark::compact::generate_merkle_update_compact_proof(111 + s, 222 + s * 3, &pe, &pi)
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
