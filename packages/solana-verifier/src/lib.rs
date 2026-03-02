//! # p01-solana-verifier
//!
//! On-chain Groth16 proof verification for Solana programs using alt_bn128 syscalls.
//!
//! Every Solana ZK project writes its own Groth16 verifier and hits the same bugs:
//! - LE/BE endianness mismatch
//! - snarkjs G2 point format differs from EIP-197
//! - Compute budget estimation for N public inputs
//! - VK management (upload, hash, hot-swap)
//!
//! This crate solves all of them in one place.
//!
//! ## Quick Start
//!
//! ```rust,ignore
//! use p01_solana_verifier::{verify_proof, VerifierError};
//!
//! let result = verify_proof(
//!     &vk_data,           // Verification key bytes
//!     &proof_bytes,        // Groth16 proof (256 bytes)
//!     &public_inputs,      // Array of [u8; 32] in LE (converted automatically)
//! )?;
//! ```

pub mod verifier;
pub mod types;
pub mod endianness;
pub mod vk;
pub mod proof_format;
pub mod patterns;

pub use verifier::Groth16Verifier;
pub use types::{VerifierError, Groth16Proof};
pub use endianness::{le_to_be, be_to_le};
pub use vk::{compute_vk_hash, parse_vk};
pub use proof_format::proof_from_snarkjs;

/// Convenience function: verify a Groth16 proof.
///
/// Public inputs should be in **little-endian** format (matching Solana storage).
/// The LE->BE conversion is handled automatically.
///
/// Returns `Ok(true)` if the proof is valid, `Ok(false)` if invalid,
/// or `Err(VerifierError)` if the inputs are malformed.
pub fn verify_proof(
    vk_data: &[u8],
    proof: &Groth16Proof,
    public_inputs_le: &[[u8; 32]],
) -> Result<bool, VerifierError> {
    // Convert LE inputs to BE for alt_bn128
    let public_inputs_be: Vec<[u8; 32]> = public_inputs_le
        .iter()
        .map(|input| le_to_be(input))
        .collect();

    Groth16Verifier::verify(proof, &public_inputs_be, vk_data)
}
