//! STARK verifier for Protocol 01 circuits.
//!
//! Two targets:
//! 1. `std` — native Rust for testing and benchmarking
//! 2. `no_std` — Solana SBF program (future: p01_stark_verifier)
//!
//! Verification is based on FRI (Fast Reed-Solomon IOP of Proximity),
//! which relies only on hash functions — no elliptic curve operations needed.
//! This makes it quantum-resistant under Grover's theorem (hash-bit security
//! degrades to sqrt, so 256-bit hashes provide 128-bit post-quantum security).

use winterfell::{
    crypto::{hashers::Blake3_256, DefaultRandomCoin, MerkleTree},
    math::fields::f64::BaseElement,
    verify, AcceptableOptions, Proof,
};

use crate::air::subscriber_ownership::{
    SubscriberOwnershipAir, SubscriberOwnershipPublicInputs,
};

/// Verification error types.
#[derive(Debug)]
pub enum VerifyError {
    /// The proof is invalid (constraint violations, bad FRI, etc.)
    InvalidProof(String),
    /// The proof bytes could not be deserialized
    DeserializationError(String),
}

impl core::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            VerifyError::InvalidProof(msg) => write!(f, "Invalid proof: {}", msg),
            VerifyError::DeserializationError(msg) => {
                write!(f, "Deserialization error: {}", msg)
            }
        }
    }
}

// Type aliases matching the prover's cryptographic parameters
type P01HashFn = Blake3_256<BaseElement>;
type P01VC = MerkleTree<P01HashFn>;
type P01RandomCoin = DefaultRandomCoin<P01HashFn>;

/// Verify a subscriber ownership STARK proof.
///
/// Returns `Ok(())` if the proof is valid, `Err(VerifyError)` otherwise.
///
/// The verifier checks:
/// 1. Boundary constraints (initial state, output = commitment)
/// 2. Transition constraints (Poseidon round function)
/// 3. FRI proof (low-degree testing)
/// 4. Deep composition polynomial consistency
pub fn verify_subscriber_ownership(
    proof_bytes: &[u8],
    commitment: u64,
) -> Result<(), VerifyError> {
    // Deserialize proof
    let proof = Proof::from_bytes(proof_bytes)
        .map_err(|e| VerifyError::DeserializationError(format!("{:?}", e)))?;

    let pub_inputs = SubscriberOwnershipPublicInputs {
        commitment: BaseElement::new(commitment),
    };

    // Accept any security level for now (POC)
    let acceptable = AcceptableOptions::MinConjecturedSecurity(0);

    // Verify using Winterfell
    verify::<SubscriberOwnershipAir, P01HashFn, P01RandomCoin, P01VC>(
        proof,
        pub_inputs,
        &acceptable,
    )
    .map_err(|e| VerifyError::InvalidProof(format!("{:?}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prover::{prove_subscriber_ownership, serialize_proof};

    #[test]
    fn test_prove_and_verify() {
        let secret = 42u64;

        // Prove
        let (proof, pub_inputs) = prove_subscriber_ownership(secret).unwrap();
        let serialized = serialize_proof(&proof, &pub_inputs);

        // Verify
        let result =
            verify_subscriber_ownership(&serialized.proof_bytes, serialized.commitment);

        assert!(
            result.is_ok(),
            "Verification should pass: {:?}",
            result.err()
        );
    }

    #[test]
    fn test_wrong_commitment_fails() {
        let secret = 42u64;

        // Prove
        let (proof, pub_inputs) = prove_subscriber_ownership(secret).unwrap();
        let serialized = serialize_proof(&proof, &pub_inputs);

        // Verify with wrong commitment
        let wrong_commitment = serialized.commitment.wrapping_add(1);
        let result = verify_subscriber_ownership(&serialized.proof_bytes, wrong_commitment);

        assert!(
            result.is_err(),
            "Verification should fail with wrong commitment"
        );
    }

    #[test]
    fn test_different_secrets_different_commitments() {
        let (_, pub1) = prove_subscriber_ownership(42).unwrap();
        let (_, pub2) = prove_subscriber_ownership(43).unwrap();

        assert_ne!(
            pub1.commitment, pub2.commitment,
            "Different secrets should produce different commitments"
        );
    }

    #[test]
    fn test_proof_roundtrip_serialization() {
        let (proof, pub_inputs) = prove_subscriber_ownership(100).unwrap();
        let serialized = serialize_proof(&proof, &pub_inputs);

        // Deserialize and re-serialize
        let proof2 = Proof::from_bytes(&serialized.proof_bytes).unwrap();
        let bytes2 = proof2.to_bytes();

        assert_eq!(
            serialized.proof_bytes, bytes2,
            "Roundtrip serialization should be identical"
        );
    }
}
