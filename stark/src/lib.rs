//! Protocol 01 STARK Proof System
//!
//! Quantum-resistant zero-knowledge proofs using Winterfell STARKs.
//! No trusted setup required — security based on hash functions (collision-resistant),
//! not elliptic curve pairings (vulnerable to Shor's algorithm).
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────┐
//! │ Client (browser WASM / mobile WebView)                  │
//! │                                                         │
//! │  ┌─────────┐    ┌───────────┐    ┌──────────────────┐  │
//! │  │ Witness  │───>│ Prover    │───>│ STARK Proof      │  │
//! │  │ (secret) │    │ (winter)  │    │ (~50KB, PQ-safe) │  │
//! │  └─────────┘    └───────────┘    └──────────────────┘  │
//! └──────────────────────────────────┬──────────────────────┘
//!                                    │ submit proof on-chain
//!                                    ▼
//! ┌─────────────────────────────────────────────────────────┐
//! │ Solana Program (p01_stark_verifier)                     │
//! │                                                         │
//! │  ┌──────────────────┐    ┌───────────────────────────┐  │
//! │  │ STARK Proof      │───>│ FRI Verifier (no_std)     │  │
//! │  │ (from account)   │    │ ~1.1M CU, hash-based     │  │
//! │  └──────────────────┘    └───────────────────────────┘  │
//! └─────────────────────────────────────────────────────────┘
//! ```
//!
//! # Circuits (AIR definitions)
//!
//! | Circuit                 | Circom Equivalent          | Status |
//! |-------------------------|----------------------------|--------|
//! | subscriber_ownership    | subscriber_ownership.circom| POC    |
//! | balance_proof           | balance_proof.circom       | TODO   |
//! | confidential_balance    | confidential_balance.circom| TODO   |
//! | denominated_pool        | denominated_pool.circom    | TODO   |
//! | denominated_transfer    | denominated_transfer.circom| TODO   |
//! | transfer                | transfer.circom            | TODO   |
//!
//! # Field
//!
//! Uses Goldilocks field (p = 2^64 - 2^32 + 1) for fast arithmetic.
//! This is a different field than BN254 used by Groth16 — existing commitments
//! are NOT compatible and require migration.

pub mod air;
pub mod poseidon;
pub mod prover;

#[cfg(feature = "std")]
pub mod verifier;

pub mod compact;

// Re-exports for convenience
pub use air::subscriber_ownership::{
    build_trace, compute_commitment, SubscriberOwnershipAir, SubscriberOwnershipPublicInputs,
};
pub use air::merkle_path::{
    build_merkle_trace, compute_merkle_root, MerklePathAir, MerklePathPublicInputs,
};
pub use air::denominated_pool::{
    build_pool_commitment_trace, compute_pool_values, DenominatedPoolAir,
    DenominatedPoolPublicInputs,
};
pub use air::balance_proof::{
    build_balance_proof_trace, compute_balance_commitment, BalanceProofAir,
    BalanceProofPublicInputs,
};
pub use prover::{prove_subscriber_ownership, StarkProofBytes};
pub use compact::{
    generate_pool_commitment_proof, generate_balance_compact_proof,
    generate_merkle_path_compact_proof, GenericCompactProofData,
    CIRCUIT_SUBSCRIBER_OWNERSHIP, CIRCUIT_POOL_COMMITMENT,
    CIRCUIT_BALANCE_PROOF, CIRCUIT_MERKLE_PATH,
};
pub use winterfell::math::fields::f64::BaseElement;

#[cfg(feature = "std")]
pub use verifier::verify_subscriber_ownership;

// WASM bindings for browser/WebView proof generation
#[cfg(feature = "wasm")]
mod wasm_api {
    use wasm_bindgen::prelude::*;
    use crate::compact::{
        generate_compact_proof, generate_pool_commitment_proof,
        generate_balance_compact_proof, generate_merkle_path_compact_proof,
    };

    /// Generate a compact STARK proof for subscriber_ownership.
    /// Returns JSON: { commitment: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_stark_proof(subscriber_secret: u64) -> String {
        let proof_data = generate_compact_proof(subscriber_secret);
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"commitment":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.commitment,
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Compute the Poseidon commitment for a secret (without generating a proof).
    #[wasm_bindgen]
    pub fn compute_stark_commitment(subscriber_secret: u64) -> String {
        let commitment = crate::air::subscriber_ownership::compute_commitment(
            crate::BaseElement::new(subscriber_secret)
        );
        commitment.as_int().to_string()
    }

    /// Generate a compact STARK proof for denominated pool commitment.
    /// Returns JSON: { circuit_id: 1, nullifier: string, commitment: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_pool_commitment_stark_proof(
        nullifier_preimage: u64,
        secret: u64,
        deposit_epoch: u64,
        token_mint: u64,
    ) -> String {
        let proof_data = generate_pool_commitment_proof(
            nullifier_preimage, secret, deposit_epoch, token_mint,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"nullifier":"{}","commitment":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Generate a compact STARK proof for balance commitment.
    /// Returns JSON: { circuit_id: 2, commitment: string, token_mint: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_balance_stark_proof(
        spending_key: u64,
        balance: u64,
        salt: u64,
        token_mint: u64,
    ) -> String {
        let proof_data = generate_balance_compact_proof(
            spending_key, balance, salt, token_mint,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"commitment":"{}","token_mint":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Generate a compact STARK proof for Merkle path inclusion.
    /// path_elements and path_indices are comma-separated strings.
    /// Returns JSON: { circuit_id: 3, leaf: string, root: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_merkle_path_stark_proof(
        leaf: u64,
        path_elements_csv: &str,
        path_indices_csv: &str,
    ) -> String {
        let path_elements: Vec<u64> = path_elements_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let path_indices: Vec<u8> = path_indices_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        let proof_data = generate_merkle_path_compact_proof(
            leaf, &path_elements, &path_indices,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"leaf":"{}","root":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }
}
