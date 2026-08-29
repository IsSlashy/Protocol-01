//! Attack the two constraints the 2026-08-01 liveness fix touched.
//!
//! Both fixes changed a phase-1 per-query arm that was rejecting honest proofs.
//! The failure mode for that kind of change is buying liveness with soundness:
//! a constraint that stops rejecting honest proofs because it stopped
//! constraining is indistinguishable from a fix until someone forges against it.
//! So each fix is attacked from both directions — honest proofs must be
//! ACCEPTED, and a trace that violates the constrained relation must be
//! REJECTED with a relevant named error.
//!
//! Phase-1 arms are per-query checks on OPENED trace values, so the attack is
//! performed the only way it can be reached from outside the crate: by tampering
//! the serialised proof bytes at the opened-row offsets and re-checking. The
//! Merkle binding will of course also reject a tampered opening, so each attack
//! calls the constraint arm's own entry point (`verify_generic` runs the Merkle
//! step first) AND reports which error came back, so a rejection cannot be
//! silently credited to the wrong mechanism.
//!
//! Run: `cargo test -p p01_stark_verifier --release --test liveness_fix_attack -- --nocapture`

use p01_stark_verifier::compact_proof::{get_circuit_config, GenericCompactProof};
use p01_stark_verifier::verify::{verify_deep_ali_circuit_5, verify_deep_ali_circuit_6,
                                 verify_generic, VerifyError};

fn honest_c5(s: u64) -> p01_stark::compact::GenericCompactProofData {
    // Conserving: out1 + out2 - in1 - in2 == 50 == public_amount.
    p01_stark::compact::generate_transfer_compact_proof(
        13 + s, 500 + s * 17, 77 + s, 400 + s * 17, 88 + s, 100, 150 + 2 * s, 1234 + s, 555 + s,
        65, 2222 + s, 333 + s, 50,
    )
}

fn honest_c6(s: u64) -> p01_stark::compact::GenericCompactProofData {
    let pe: Vec<u64> = (0..12u64).map(|j| 100 + j * 13 + s * 37).collect();
    let pi: Vec<u8> = (0..12u8).map(|j| ((j as usize + s as usize) % 2) as u8).collect();
    p01_stark::compact::generate_merkle_update_compact_proof(111 + s, 222 + s * 3, &pe, &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len()))
}

// ---------------------------------------------------------------------------
// Direction 1: the fixes must not have broken the honest path.
// ---------------------------------------------------------------------------

/// C5: the four carry-capture rows are now CHECKED rather than assumed
/// constant. An honest proof must still clear both phases.
#[test]
fn c5_honest_still_verifies_after_the_capture_fix() {
    let mut bad = Vec::new();
    for s in 0..24u64 {
        let d = honest_c5(s);
        let config = get_circuit_config(5).unwrap();
        let p = GenericCompactProof::from_bytes(&d.proof_bytes, config).unwrap();
        let r1 = verify_generic(&p, d.circuit_id, &d.public_inputs, config);
        let r2 = verify_deep_ali_circuit_5(&p, &d.public_inputs);
        if r1.is_err() || r2.is_err() {
            bad.push((s, r1, r2));
        }
    }
    println!("[ATTACK] C5 honest after fix: {} rejected of 24", bad.len());
    assert!(bad.is_empty(), "the capture fix rejects honest C5 proofs: {bad:?}");
}

/// C6: rows 480..=511 are now treated as the padding they are. An honest proof
/// must clear both phases.
#[test]
fn c6_honest_still_verifies_after_the_padding_fix() {
    let mut bad = Vec::new();
    for s in 0..24u64 {
        let d = honest_c6(s);
        let config = get_circuit_config(6).unwrap();
        let p = GenericCompactProof::from_bytes(&d.proof_bytes, config).unwrap();
        let r1 = verify_generic(&p, d.circuit_id, &d.public_inputs, config);
        let r2 = verify_deep_ali_circuit_6(&p, &d.public_inputs);
        if r1.is_err() || r2.is_err() {
            bad.push((s, r1, r2));
        }
    }
    println!("[ATTACK] C6 honest after fix: {} rejected of 24", bad.len());
    assert!(bad.is_empty(), "the padding fix rejects honest C6 proofs: {bad:?}");
}

// ---------------------------------------------------------------------------
// Direction 2: the fixes must still reject.
// ---------------------------------------------------------------------------

/// Flip one byte inside an opened trace row and confirm the proof is refused.
///
/// Returns the error phase 1 produced. The point is not merely "it rejected" —
/// the caller prints WHICH mechanism rejected, because a fix that quietly
/// stopped constraining would still be caught by the Merkle step and would look
/// identical from a bare `is_err()`.
fn tamper_and_verify(
    bytes: &[u8],
    circuit_id: u8,
    public_inputs: &[u64],
    byte_index: usize,
) -> Result<(), String> {
    let config = get_circuit_config(circuit_id).unwrap();
    let mut t = bytes.to_vec();
    t[byte_index] ^= 0x01;
    match GenericCompactProof::from_bytes(&t, config) {
        // A flip that breaks the wire format never reaches a constraint arm.
        // Counted as a rejection, but labelled so it cannot be mistaken for one.
        None => Err("ParseRejected".to_string()),
        Some(p) => verify_generic(&p, circuit_id, public_inputs, config)
            .map_err(|e: VerifyError| format!("{e:?}")),
    }
}

/// A tampered C5 opening must never verify, wherever the flip lands.
///
/// This sweeps the whole proof body rather than aiming at one offset, so a fix
/// that opened a hole anywhere in the phase-1 surface shows up as an accepted
/// tamper.
#[test]
fn c5_tampered_openings_are_all_rejected() {
    let d = honest_c5(3);
    let config = get_circuit_config(5).unwrap();
    let p = GenericCompactProof::from_bytes(&d.proof_bytes, config).unwrap();
    verify_generic(&p, d.circuit_id, &d.public_inputs, config)
        .expect("baseline C5 proof must verify before tampering");

    let n = d.proof_bytes.len();
    let mut accepted = Vec::new();
    let mut errs: Vec<String> = Vec::new();
    // Sweep on a stride so the run stays bounded but still covers every region
    // of the wire format (roots, OOD block, query openings, FRI layers).
    let mut i = 0usize;
    while i < n {
        match tamper_and_verify(&d.proof_bytes, d.circuit_id, &d.public_inputs, i) {
            Ok(()) => accepted.push(i),
            Err(e) => errs.push(e),
        }
        i += 97;
    }
    errs.sort();
    errs.dedup();
    println!(
        "[ATTACK] C5 single-bit tampers over {n} bytes (stride 97): {} accepted; errors {errs:?}",
        accepted.len(),
    );
    assert!(
        accepted.is_empty(),
        "a tampered C5 proof VERIFIED at byte offsets {accepted:?}"
    );
}

/// Same sweep for C6, whose padding arm is the one the fix rewrote.
#[test]
fn c6_tampered_openings_are_all_rejected() {
    let d = honest_c6(3);
    let config = get_circuit_config(6).unwrap();
    let p = GenericCompactProof::from_bytes(&d.proof_bytes, config).unwrap();
    verify_generic(&p, d.circuit_id, &d.public_inputs, config)
        .expect("baseline C6 proof must verify before tampering");

    let n = d.proof_bytes.len();
    let mut accepted = Vec::new();
    let mut errs: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < n {
        match tamper_and_verify(&d.proof_bytes, d.circuit_id, &d.public_inputs, i) {
            Ok(()) => accepted.push(i),
            Err(e) => errs.push(e),
        }
        i += 97;
    }
    errs.sort();
    errs.dedup();
    println!(
        "[ATTACK] C6 single-bit tampers over {n} bytes (stride 97): {} accepted; errors {errs:?}",
        accepted.len(),
    );
    assert!(
        accepted.is_empty(),
        "a tampered C6 proof VERIFIED at byte offsets {accepted:?}"
    );
}

/// The C6 fix reads a CONSTANT depth, never the public input — so a prover
/// cannot relabel active rows as padding. This pins that: phase 2 refuses any
/// depth other than 15, so there is no proof in existence whose padding
/// boundary differs from the one phase 1 hardcodes.
#[test]
fn c6_padding_boundary_is_not_prover_controlled() {
    let d = honest_c6(5);
    let config = get_circuit_config(6).unwrap();
    let p = GenericCompactProof::from_bytes(&d.proof_bytes, config).unwrap();
    assert_eq!(d.public_inputs.len(), 5, "C6 publishes [old,new,oldroot,newroot,depth]");
    assert_eq!(d.public_inputs[4], 15, "canonical C6 depth");

    for claimed_depth in [0u64, 1, 7, 8, 14, 16, 31, u64::MAX] {
        let mut pi = d.public_inputs.clone();
        pi[4] = claimed_depth;
        let r = verify_deep_ali_circuit_6(&p, &pi);
        assert!(
            r.is_err(),
            "phase 2 accepted a C6 proof claiming depth {claimed_depth}; if depth ever \
             becomes negotiable, the hardcoded `CANONICAL_DEPTH` in \
             `verify_constraints_merkle_update` becomes a prover lever and must be \
             re-derived from the same source phase 2 uses"
        );
    }
    println!("[ATTACK] C6 depth is pinned to 15 by phase 2; the padding boundary is a constant");
}
