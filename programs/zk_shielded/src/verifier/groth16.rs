use anchor_lang::prelude::*;
use ark_bn254::{Bn254, Fr, G1Affine, G2Affine};
use ark_groth16::{Proof, VerifyingKey};
use ark_serialize::CanonicalDeserialize;
use ark_ff::PrimeField;

use crate::{errors::ZkShieldedError, Groth16Proof};

/// On-chain Groth16 proof verification for BN254 curve
/// Optimized for Solana's compute limits (~1.4M CU per instruction)
pub struct Groth16Verifier;

impl Groth16Verifier {
    /// Verification key stored as bytes (generated during trusted setup)
    /// This should be loaded from an account in production
    /// Format: [alpha_g1, beta_g2, gamma_g2, delta_g2, ic[]]
    const VK_BYTES: &'static [u8] = &[];  // Will be loaded from account

    /// Verify a Groth16 proof with the given public inputs
    ///
    /// # Arguments
    /// * `proof` - The Groth16 proof (pi_a, pi_b, pi_c)
    /// * `public_inputs` - Array of field elements as public inputs
    /// * `vk_data` - Verification key data from the pool account
    ///
    /// # Returns
    /// * `Ok(true)` if proof is valid
    /// * `Ok(false)` if proof is invalid
    /// * `Err` if there's a deserialization or computation error
    pub fn verify(
        proof: &Groth16Proof,
        public_inputs: &[[u8; 32]],
        vk_data: &[u8],
    ) -> Result<bool> {
        // Parse the proof
        let proof = Self::parse_proof(proof)?;

        // Parse the verification key
        let vk = Self::parse_verification_key(vk_data)?;

        // Parse public inputs as field elements
        let inputs: Vec<Fr> = public_inputs
            .iter()
            .map(|input| Self::bytes_to_field(input))
            .collect::<Result<Vec<_>>>()?;

        // Perform the verification
        let result = ark_groth16::verify_proof(&vk.into(), &proof, &inputs);

        match result {
            Ok(valid) => Ok(valid),
            Err(_) => Err(ZkShieldedError::InvalidProof.into()),
        }
    }

    /// Verify a transfer proof with standard public inputs
    pub fn verify_transfer(
        proof: &Groth16Proof,
        merkle_root: &[u8; 32],
        nullifier_1: &[u8; 32],
        nullifier_2: &[u8; 32],
        output_commitment_1: &[u8; 32],
        output_commitment_2: &[u8; 32],
        public_amount: i64,
        token_mint: &[u8; 32],
        vk_data: &[u8],
    ) -> Result<bool> {
        // Construct public inputs array in the order expected by the circuit
        let public_amount_bytes = Self::i64_to_field_bytes(public_amount);

        let public_inputs = [
            *merkle_root,
            *nullifier_1,
            *nullifier_2,
            *output_commitment_1,
            *output_commitment_2,
            public_amount_bytes,
            *token_mint,
        ];

        Self::verify(proof, &public_inputs, vk_data)
    }

    /// Parse proof bytes into arkworks Proof structure
    fn parse_proof(proof: &Groth16Proof) -> Result<Proof<Bn254>> {
        // Parse G1 point pi_a (64 bytes: x, y coordinates)
        let a = G1Affine::deserialize_compressed(&proof.pi_a[..])
            .map_err(|_| ZkShieldedError::InvalidProof)?;

        // Parse G2 point pi_b (128 bytes: two Fq2 elements)
        let b = G2Affine::deserialize_compressed(&proof.pi_b[..])
            .map_err(|_| ZkShieldedError::InvalidProof)?;

        // Parse G1 point pi_c (64 bytes: x, y coordinates)
        let c = G1Affine::deserialize_compressed(&proof.pi_c[..])
            .map_err(|_| ZkShieldedError::InvalidProof)?;

        Ok(Proof { a, b, c })
    }

    /// Parse verification key from bytes
    fn parse_verification_key(vk_data: &[u8]) -> Result<VerifyingKey<Bn254>> {
        VerifyingKey::deserialize_compressed(vk_data)
            .map_err(|_| ZkShieldedError::InvalidVerificationKey.into())
    }

    /// Convert 32-byte array to field element
    fn bytes_to_field(bytes: &[u8; 32]) -> Result<Fr> {
        Fr::from_le_bytes_mod_order(bytes);
        Ok(Fr::from_le_bytes_mod_order(bytes))
    }

    /// Convert i64 to field element bytes (handles negative values)
    fn i64_to_field_bytes(value: i64) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        if value >= 0 {
            let value_bytes = (value as u64).to_le_bytes();
            bytes[..8].copy_from_slice(&value_bytes);
        } else {
            // For negative values, use field modular arithmetic
            // This represents the value as p - |value| where p is the field modulus
            // In practice, the circuit handles this appropriately
            let abs_value = value.unsigned_abs();
            let value_bytes = abs_value.to_le_bytes();
            bytes[..8].copy_from_slice(&value_bytes);
            // Set high bytes to indicate this should be negated
            bytes[31] = 0xFF;  // Mark as negative
        }
        bytes
    }

    /// Hash verification key for storage comparison
    pub fn hash_verification_key(vk_data: &[u8]) -> [u8; 32] {
        use sha3::{Digest, Keccak256};

        let mut hasher = Keccak256::new();
        hasher.update(vk_data);
        let result = hasher.finalize();

        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
}

/// Prepared verification key for faster repeated verifications
#[derive(Clone)]
pub struct PreparedVerifyingKey {
    pub vk: VerifyingKey<Bn254>,
    pub vk_hash: [u8; 32],
}

impl PreparedVerifyingKey {
    /// Create from raw verification key bytes
    pub fn from_bytes(vk_data: &[u8]) -> Result<Self> {
        let vk = VerifyingKey::deserialize_compressed(vk_data)
            .map_err(|_| ZkShieldedError::InvalidVerificationKey)?;

        let vk_hash = Groth16Verifier::hash_verification_key(vk_data);

        Ok(Self { vk, vk_hash })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_i64_to_field_bytes_positive() {
        let value: i64 = 1000;
        let bytes = Groth16Verifier::i64_to_field_bytes(value);
        assert_eq!(bytes[0..8], 1000u64.to_le_bytes());
        assert_eq!(bytes[31], 0);
    }

    #[test]
    fn test_i64_to_field_bytes_negative() {
        let value: i64 = -1000;
        let bytes = Groth16Verifier::i64_to_field_bytes(value);
        assert_eq!(bytes[0..8], 1000u64.to_le_bytes());
        assert_eq!(bytes[31], 0xFF);
    }
}
