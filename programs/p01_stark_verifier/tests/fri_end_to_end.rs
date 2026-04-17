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
use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::{verify_generic, verify_subscriber_ownership};

#[test]
fn legacy_subscriber_ownership_roundtrip() {
    let data = p01_stark::compact::generate_compact_proof(42);
    let proof = CompactStarkProof::from_bytes(&data.proof_bytes)
        .expect("legacy proof should parse");
    verify_subscriber_ownership(&proof, Felt::new(data.commitment))
        .expect("honest legacy proof should verify end-to-end (FRI fold check included)");
}

/// [P1.1 PR 4] DEEP-ALI soundness: a tampered `ood_quotient` must be rejected.
///
/// The prover's claimed Q(z) is absorbed into the Fiat-Shamir transcript
/// (see `build_base_seed`) BEFORE query-position derivation, so any tamper
/// is caught via the transcript binding path (query positions don't match)
/// — the DEEP-ALI check `C(z) == Q(z) · Z_T(z)` is the additional, direct
/// binding that activates when the transcript happens to collide. Either
/// rejection path is sound; we just require that verification fails.
#[test]
fn legacy_rejects_tampered_ood_quotient() {
    let data = p01_stark::compact::generate_compact_proof(42);
    let mut proof = CompactStarkProof::from_bytes(&data.proof_bytes)
        .expect("legacy proof should parse");

    let original = proof.ood_quotient.as_u64();
    proof.ood_quotient = Felt::new(original.wrapping_add(1) % 0xFFFFFFFF00000001_u64);

    let err = verify_subscriber_ownership(&proof, Felt::new(data.commitment))
        .expect_err("tampered ood_quotient must fail verification");
    let _ = err; // any error variant is acceptable; what matters is rejection.
}

#[test]
fn generic_pool_commitment_roundtrip() {
    let data = p01_stark::compact::generate_pool_commitment_proof(
        0xDEADBEEF_u64, 0xCAFEBABE_u64, 7, 0xA55A_u64,
    );
    let config = &CONFIG_POOL_COMMITMENT;
    let proof = GenericCompactProof::from_bytes(&data.proof_bytes, config)
        .expect("generic proof should parse");
    verify_generic(&proof, data.circuit_id, &data.public_inputs, config)
        .expect("honest generic proof should verify end-to-end");
}

#[test]
fn config_lookup_matches_prover_circuit_id() {
    let data = p01_stark::compact::generate_pool_commitment_proof(1, 2, 3, 4);
    let config = get_circuit_config(data.circuit_id).expect("config for circuit id");
    assert_eq!(config.lde_size, CONFIG_POOL_COMMITMENT.lde_size);
}
