//! WHICH C6 rows the phase-1 per-query check rejects on an honest trace.
//!
//! `tests/honest_liveness.rs` establishes THAT the shipped verifier rejects
//! honest C6 proofs. This file localises it, because "some proofs fail" is not
//! actionable and "rows 480..509 fail" is.
//!
//! `verify_constraints_merkle_update` (verify.rs) branches on
//! `pos_in_cycle = (pos / blowup) % 32` alone:
//!
//! ```text
//!   pos_in_cycle <  num_rounds (30)  -> require a Poseidon round on cols 0-2 and 3-5
//!   pos_in_cycle == 31               -> free transition
//!   otherwise (pos_in_cycle == 30)   -> require identity on all 10 columns
//! ```
//!
//! Nothing in that branch knows whether the CYCLE is active. A depth-15 witness
//! fills 15 cycles (rows 0..479) and pads the sixteenth (rows 480..511), and the
//! AIR disables the round constraint over the padding with a periodic
//! `round_active` column that the per-query check does not have. So the check
//! demands a Poseidon round of a row that the honest prover deliberately did not
//! hash.
//!
//! This test does not assert a fix. It measures the bad row set and the
//! resulting honest-rejection rate, so both are on the record with numbers.

use p01_stark_verifier::compact_proof::{get_circuit_config, GenericCompactProof};
use p01_stark_verifier::verify::verify_generic;

const WITNESSES: usize = 128;

#[test]
fn locate_the_c6_rows_that_reject_an_honest_trace() {
    let config = get_circuit_config(6).expect("C6 config");
    let cycle = 32usize;
    let depth = 15usize;
    let active_rows = depth * cycle;

    let mut accepted_rows = vec![0usize; config.trace_length];
    let mut rejected_rows = vec![0usize; config.trace_length];
    let mut n_rejected = 0usize;
    let mut aligned_total = 0usize;

    for i in 0..WITNESSES {
        let s = i as u64;
        let pe: Vec<u64> = (0..15u64).map(|j| 100 + j * 13 + s * 37).collect();
        let pi: Vec<u8> = (0..15u8).map(|j| ((j as usize + i) % 2) as u8).collect();
        let data =
            p01_stark::compact::generate_merkle_update_compact_proof(111 + s, 222 + s * 3, &pe, &pi);
        let proof = GenericCompactProof::from_bytes(&data.proof_bytes, config).expect("parse");
        let rows: Vec<usize> = proof
            .queries
            .iter()
            .map(|q| q.position as usize)
            .filter(|p| p % config.blowup == 0)
            .map(|p| (p / config.blowup) % config.trace_length)
            .collect();
        aligned_total += rows.len();
        let ok = verify_generic(&proof, data.circuit_id, &data.public_inputs, config).is_ok();
        if ok {
            for r in rows {
                accepted_rows[r] += 1;
            }
        } else {
            n_rejected += 1;
            for r in rows {
                rejected_rows[r] += 1;
            }
        }
    }

    let suspect: Vec<usize> = (0..config.trace_length)
        .filter(|&r| rejected_rows[r] > 0 && accepted_rows[r] == 0)
        .collect();
    let cleared: Vec<usize> = (0..config.trace_length)
        .filter(|&r| accepted_rows[r] > 0)
        .collect();

    println!(
        "[C6 PADDING] {WITNESSES} honest depth-{depth} witnesses, {n_rejected} rejected \
         ({:.1}%), {aligned_total} aligned queries seen in total",
        100.0 * n_rejected as f64 / WITNESSES as f64,
    );
    println!("[C6 PADDING] active rows are 0..{}, padding is {}..{}", active_rows - 1, active_rows, config.trace_length - 1);
    println!("[C6 PADDING] rows seen ONLY in rejected proofs: {suspect:?}");
    println!(
        "[C6 PADDING] rows CLEARED by at least one accepted proof: {} distinct, max {}",
        cleared.len(),
        cleared.iter().max().copied().unwrap_or(0),
    );
    let suspect_in_padding = suspect.iter().filter(|&&r| r >= active_rows).count();
    println!(
        "[C6 PADDING] of the {} suspect rows, {suspect_in_padding} are in the padding cycle",
        suspect.len(),
    );
    let cleared_in_padding: Vec<usize> = cleared.iter().copied().filter(|&r| r >= active_rows).collect();
    println!(
        "[C6 PADDING] padding rows that an ACCEPTED proof queried (so are harmless): \
         {cleared_in_padding:?}",
    );

    // The predicted rate if, and only if, the bad rows are exactly the padding
    // rows the check treats as active hash rows.
    let predicted_bad_rows = (config.trace_length - active_rows).min(config.num_rounds);
    let predicted =
        1.0 - (1.0 - predicted_bad_rows as f64 / config.lde_size as f64).powi(config.num_queries as i32);
    println!(
        "[C6 PADDING] if the bad set is the {predicted_bad_rows} padding rows with \
         pos_in_cycle < num_rounds, the honest rejection rate is {:.2}%",
        predicted * 100.0,
    );

    assert!(
        n_rejected > 0,
        "this probe found no honest C6 rejection in {WITNESSES} witnesses — if that is \
         reproducible the defect honest_liveness measured has been fixed and both \
         files should be revisited together",
    );
}

/// The same localisation for C5 (transfer), which `honest_liveness` shows
/// rejecting honest proofs too — and with TWO distinct error variants, so there
/// are at least two independent row sets to find.
#[test]
fn locate_the_c5_rows_that_reject_an_honest_trace() {
    let config = get_circuit_config(5).expect("C5 config");
    let cycle = 32usize;

    let mut accepted_rows = vec![0usize; config.trace_length];
    let mut rejected_rows: Vec<Vec<String>> = vec![Vec::new(); config.trace_length];
    let mut n_rejected = 0usize;

    for i in 0..WITNESSES {
        let s = i as u64;
        let data = p01_stark::compact::generate_transfer_compact_proof(
            13 + s, 500 + s * 17, 77 + s, 400 + s * 17, 88 + s, 100, 150, 1234 + s, 555 + s, 65,
            2222 + s, 333 + s, 50,
        );
        let proof = GenericCompactProof::from_bytes(&data.proof_bytes, config).expect("parse");
        let rows: Vec<usize> = proof
            .queries
            .iter()
            .map(|q| q.position as usize)
            .filter(|p| p % config.blowup == 0)
            .map(|p| (p / config.blowup) % config.trace_length)
            .collect();
        match verify_generic(&proof, data.circuit_id, &data.public_inputs, config) {
            Ok(()) => {
                for r in rows {
                    accepted_rows[r] += 1;
                }
            }
            Err(e) => {
                n_rejected += 1;
                for r in rows {
                    rejected_rows[r].push(format!("{e:?}"));
                }
            }
        }
    }

    println!(
        "[C5 ROWS] {WITNESSES} honest witnesses, {n_rejected} rejected ({:.1}%)",
        100.0 * n_rejected as f64 / WITNESSES as f64,
    );
    for r in 0..config.trace_length {
        if !rejected_rows[r].is_empty() && accepted_rows[r] == 0 {
            println!(
                "[C5 ROWS] row {r} (cycle {}, pos_in_cycle {}) NEVER cleared; errors {:?}",
                r / cycle,
                r % cycle,
                rejected_rows[r],
            );
        }
    }
    let cleared_mod30: Vec<usize> = (0..config.trace_length)
        .filter(|&r| accepted_rows[r] > 0 && r % cycle == cycle - 2)
        .collect();
    println!(
        "[C5 ROWS] rows with pos_in_cycle == 30 that an ACCEPTED proof queried: {cleared_mod30:?}",
    );
    println!(
        "[C5 ROWS] row 385 (the acc boundary assertion row) cleared {} times, rejected {} times",
        accepted_rows[385],
        rejected_rows[385].len(),
    );

    assert!(
        n_rejected > 0,
        "no honest C5 rejection in {WITNESSES} witnesses — revisit together with \
         honest_liveness if this becomes reproducible",
    );
}
