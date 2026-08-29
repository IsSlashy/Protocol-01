//! End-to-end integration tests for the FRI LDT wire-up (P1.1 PR 1-3).
//!
//! Generates a real compact proof with the off-chain prover (`p01-stark`)
//! then feeds the bytes through the on-chain verifier's parser + full
//! `verify_generic` / `verify_subscriber_ownership` pipeline. This is the
//! first test that exercises PR 3's `verify_fri_generic` / `verify_fri_legacy`
//! on honest prover output end-to-end.

use p01_stark_verifier::compact_proof::{
    get_circuit_config, CompactStarkProof, GenericCompactProof, CONFIG_POOL_COMMITMENT,
};
use p01_stark_verifier::goldilocks::{Felt, MODULUS};
use p01_stark_verifier::verify::{verify_generic, verify_subscriber_ownership, VerifyError};

#[test]
fn legacy_subscriber_ownership_roundtrip() {
    let data = p01_stark::compact::generate_compact_proof(42);
    let proof = CompactStarkProof::from_bytes(&data.proof_bytes)
        .expect("legacy proof should parse");
    verify_subscriber_ownership(&proof, Felt::new(data.commitment))
        .expect("honest legacy proof should verify end-to-end (FRI fold check included)");
}

/// A tampered `ood_quotient` must be rejected — and this test is precise about
/// WHY, because the reason is not the one it used to claim.
///
/// **What this test does NOT show.** `ood_quotient` is absorbed into the
/// Fiat-Shamir transcript (`build_base_seed`) before query-position derivation,
/// so flipping it in a PARSED proof changes the derived positions and step 2
/// rejects. That happens whether or not the verifier has any DEEP binding at all,
/// so this test is NOT evidence for B1. Its old docstring said the DEEP-ALI check
/// was "the additional, direct binding that activates when the transcript happens
/// to collide"; that was wrong twice over — the identity is solvable for
/// `ood_quotient` by construction, and the body then accepted any error variant,
/// so the test would have stayed green against a verifier with no binding.
///
/// The coordinated-forgery suite (`tests/b1_deep_binding.rs`) is the test that
/// exercises the binding: it re-solves `ood_quotient` from the AIR and rebuilds
/// the whole transcript, so positions and Merkle openings all pass.
///
/// What this test pins now: the tamper is caught, and it is caught at the
/// GRINDING step, named. MEASURED — the first guess (`InvalidQueryPosition`) was
/// wrong: `ood_quotient` sits inside the base seed the proof-of-work is done
/// over, so moving it invalidates the nonce before positions are ever derived.
/// `InsufficientQueries` is the (badly named) variant `verify_grinding` returns.
#[test]
fn legacy_rejects_tampered_ood_quotient_via_the_transcript_not_the_identity() {
    let data = p01_stark::compact::generate_compact_proof(42);
    // [B2] `ood_quotient` is no longer one owned felt on the parsed struct — it
    // is a borrowed `quotient_segments`-wide slice into the proof buffer, so the
    // tamper happens on the WIRE and the proof is re-parsed. Same property, and
    // strictly closer to what an attacker can actually do.
    //
    // Legacy header: trace_root 32 | quotient_root 32 | ood_current 3*8 |
    // ood_next 3*8 | ood_z 8, so segment 0 of ood_quotient starts at byte 120.
    let mut bytes = data.proof_bytes.clone();
    const OOD_QUOTIENT_OFF: usize = 32 + 32 + 24 + 24 + 8;
    let original = u64::from_le_bytes(
        bytes[OOD_QUOTIENT_OFF..OOD_QUOTIENT_OFF + 8].try_into().unwrap(),
    );
    let tampered = original.wrapping_add(1) % 0xFFFFFFFF00000001_u64;
    bytes[OOD_QUOTIENT_OFF..OOD_QUOTIENT_OFF + 8].copy_from_slice(&tampered.to_le_bytes());

    let proof = CompactStarkProof::from_bytes(&bytes)
        .expect("legacy proof should still parse after a canonical tamper");

    let err = verify_subscriber_ownership(&proof, Felt::new(data.commitment))
        .expect_err("tampered ood_quotient must fail verification");
    assert_eq!(
        err,
        VerifyError::InsufficientQueries,
        "the tamper is caught by the GRINDING binding, NOT by the DEEP-ALI \
         identity and NOT by FRI. If this variant ever changes, re-read the \
         docstring before adjusting it.",
    );
}

/// [B1] The terminal degree bound must be CAPABLE of rejecting, and it must
/// compare the REDUCED felt rather than raw bytes.
///
/// `MODULUS` is a legal `u64` that reduces to zero, so "the tail bytes are zero"
/// and "the tail felts are zero" are different predicates. The parser therefore
/// refuses non-canonical coefficients outright, on BOTH parsers and in EVERY
/// slot — otherwise the transcript (which absorbs raw bytes) and the tail check
/// (which reads the reduced value) would disagree about the same slot.
#[test]
fn final_poly_rejects_non_canonical_coefficients() {
    /// Byte offset + count of the `fri_final_poly` field.
    /// Header: trace_root 32 | quotient_root 32 | ood_current 8w | ood_next 8w |
    /// ood_z 8 | ood_quotient 8k | num_fri_layers 1 | roots 32L | fps u16 | poly.
    ///
    /// [B2] `ood_quotient` is `quotient_segments` felts, not one.
    fn final_poly_offset(
        bytes: &[u8],
        trace_width: usize,
        quotient_segments: usize,
    ) -> (usize, usize) {
        let mut c = 32 + 32 + trace_width * 8 * 2 + 8 + quotient_segments * 8;
        let num_layers = bytes[c] as usize;
        c += 1 + num_layers * 32;
        let fps = u16::from_le_bytes([bytes[c], bytes[c + 1]]) as usize;
        (c + 2, fps)
    }

    // Generic path (C1).
    let data = p01_stark::compact::generate_pool_commitment_proof(111, 222, 333, 444, &p01_stark::compact::c1_deterministic_probe_mask());
    let config = &CONFIG_POOL_COMMITMENT;
    let (off, fps) = final_poly_offset(&data.proof_bytes, config.trace_width, config.quotient_segments);
    assert_eq!(fps, config.fri_final_poly_size);
    assert!(
        config.fri_final_poly_degree_bound < fps,
        "C1 terminal check would be VACUOUS: bound {} >= size {fps}",
        config.fri_final_poly_degree_bound,
    );
    // Honest tail really is all zeros — the bound is not vacuously satisfied.
    for i in config.fri_final_poly_degree_bound..fps {
        let raw = u64::from_le_bytes(
            data.proof_bytes[off + i * 8..off + i * 8 + 8].try_into().unwrap(),
        );
        assert_eq!(raw, 0, "honest C1 final poly coeff {i} must be zero");
    }
    for slot in [0usize, config.fri_final_poly_degree_bound, fps - 1] {
        let mut bytes = data.proof_bytes.clone();
        bytes[off + slot * 8..off + slot * 8 + 8].copy_from_slice(&MODULUS.to_le_bytes());
        assert!(
            GenericCompactProof::from_bytes(&bytes, config).is_none(),
            "MODULUS in generic final-poly slot {slot} must fail the parse-time \
             canonicity check",
        );
    }
    // A CANONICAL non-zero above the bound still parses, and is rejected.
    //
    // MEASURED: the rejection is `InsufficientQueries`, i.e. the GRINDING check,
    // not the degree bound — the final poly is absorbed into the grinding
    // transcript before positions are derived, so a byte patch invalidates the
    // proof-of-work nonce first. That is why a byte patch can never be the test
    // for the degree bound; only a prover that grinds AFTER publishing the high
    // coefficient can reach it. See `tests/b1_deep_binding.rs`, which does
    // exactly that.
    let mut bytes = data.proof_bytes.clone();
    bytes[off + (fps - 1) * 8..off + (fps - 1) * 8 + 8].copy_from_slice(&1u64.to_le_bytes());
    let proof = GenericCompactProof::from_bytes(&bytes, config)
        .expect("a canonical 1 still parses; the degree bound is a verify-time check");
    let err = verify_generic(&proof, data.circuit_id, &data.public_inputs, config)
        .expect_err("a non-zero coefficient above the degree bound must be rejected");
    assert_eq!(
        err,
        VerifyError::InsufficientQueries,
        "a byte patch is caught by grinding before the degree bound is reached",
    );

    // Legacy path (C0), whose bound is 7 rather than 8.
    let c0 = p01_stark::compact::generate_compact_proof(42);
    let (off, fps) = final_poly_offset(&c0.proof_bytes, 3, p01_stark_verifier::compact_proof::LEGACY_QUOTIENT_SEGMENTS);
    for i in p01_stark_verifier::compact_proof::LEGACY_FRI_FINAL_POLY_DEGREE_BOUND..fps {
        let raw =
            u64::from_le_bytes(c0.proof_bytes[off + i * 8..off + i * 8 + 8].try_into().unwrap());
        assert_eq!(raw, 0, "honest C0 final poly coeff {i} must be zero");
    }
    let mut bytes = c0.proof_bytes.clone();
    bytes[off + (fps - 1) * 8..off + (fps - 1) * 8 + 8].copy_from_slice(&MODULUS.to_le_bytes());
    assert!(
        CompactStarkProof::from_bytes(&bytes).is_none(),
        "legacy parser must reject MODULUS in a final-poly slot",
    );
}

#[test]
fn generic_pool_commitment_roundtrip() {
    let data = p01_stark::compact::generate_pool_commitment_proof(
        0xDEADBEEF_u64, 0xCAFEBABE_u64, 7, 0xA55A_u64, &p01_stark::compact::c1_deterministic_probe_mask());
    let config = &CONFIG_POOL_COMMITMENT;
    let proof = GenericCompactProof::from_bytes(&data.proof_bytes, config)
        .expect("generic proof should parse");
    verify_generic(&proof, data.circuit_id, &data.public_inputs, config)
        .expect("honest generic proof should verify end-to-end");
}

#[test]
fn config_lookup_matches_prover_circuit_id() {
    let data = p01_stark::compact::generate_pool_commitment_proof(1, 2, 3, 4, &p01_stark::compact::c1_deterministic_probe_mask());
    let config = get_circuit_config(data.circuit_id).expect("config for circuit id");
    assert_eq!(config.lde_size, CONFIG_POOL_COMMITMENT.lde_size);
}
