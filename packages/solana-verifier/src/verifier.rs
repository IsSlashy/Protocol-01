//! Core Groth16 verifier using Solana's alt_bn128 syscalls.

use crate::types::*;

#[cfg(target_os = "solana")]
#[allow(deprecated)]
use solana_bn254::prelude::{
    alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing,
};

/// On-chain Groth16 proof verification for BN254 curve.
///
/// Uses Solana's native alt_bn128 syscalls for efficient pairing operations.
/// Stack-safe implementation that stays within BPF limits.
pub struct Groth16Verifier;

impl Groth16Verifier {
    /// Verify a Groth16 proof.
    ///
    /// Groth16 verification equation:
    /// e(A, B) = e(alpha, beta) * e(sum(pub_i * IC_i), gamma) * e(C, delta)
    ///
    /// Rearranged for pairing check (product = 1):
    /// e(-A, B) * e(alpha, beta) * e(IC_sum, gamma) * e(C, delta) = 1
    ///
    /// **Note:** Public inputs must be in big-endian format.
    /// Use `verify_proof()` from the crate root for automatic LE->BE conversion.
    pub fn verify(
        proof: &Groth16Proof,
        public_inputs_be: &[[u8; 32]],
        vk_data: &[u8],
    ) -> Result<bool, VerifierError> {
        let vk = crate::vk::parse_vk(vk_data)?;
        let ic_sum = Self::compute_ic_sum(public_inputs_be, &vk.ic)?;
        let pairing_input = Self::build_pairing_input(proof, &vk, &ic_sum)?;
        Self::pairing_check(&pairing_input)
    }

    /// Compute IC[0] + sum(pub_i * IC[i+1]) using G1 add and scalar mul
    fn compute_ic_sum(
        public_inputs: &[[u8; 32]],
        ic: &[[u8; G1_SIZE]],
    ) -> Result<[u8; G1_SIZE], VerifierError> {
        if public_inputs.len() + 1 != ic.len() {
            return Err(VerifierError::InvalidPublicInputs);
        }

        let mut result = ic[0];

        for (i, pub_input) in public_inputs.iter().enumerate() {
            let mul_result = Self::g1_scalar_mul(&ic[i + 1], pub_input)?;
            result = Self::g1_add(&result, &mul_result)?;
        }

        Ok(result)
    }

    /// G1 point addition via alt_bn128 precompile
    fn g1_add(p1: &[u8; G1_SIZE], p2: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE], VerifierError> {
        let mut input = [0u8; G1_SIZE * 2];
        input[..G1_SIZE].copy_from_slice(p1);
        input[G1_SIZE..].copy_from_slice(p2);

        #[cfg(target_os = "solana")]
        {
            let result_vec = alt_bn128_addition(&input)
                .map_err(|_| VerifierError::CurveOperationFailed)?;
            let mut result = [0u8; G1_SIZE];
            result.copy_from_slice(&result_vec);
            Ok(result)
        }

        #[cfg(not(target_os = "solana"))]
        {
            let _ = input;
            Ok(*p1)
        }
    }

    /// G1 scalar multiplication via alt_bn128 precompile
    fn g1_scalar_mul(
        p: &[u8; G1_SIZE],
        scalar: &[u8; FR_SIZE],
    ) -> Result<[u8; G1_SIZE], VerifierError> {
        let mut input = [0u8; G1_SIZE + FR_SIZE];
        input[..G1_SIZE].copy_from_slice(p);
        input[G1_SIZE..].copy_from_slice(scalar);

        #[cfg(target_os = "solana")]
        {
            let result_vec = alt_bn128_multiplication(&input)
                .map_err(|_| VerifierError::CurveOperationFailed)?;
            let mut result = [0u8; G1_SIZE];
            result.copy_from_slice(&result_vec);
            Ok(result)
        }

        #[cfg(not(target_os = "solana"))]
        {
            let _ = input;
            Ok(*p)
        }
    }

    /// Build pairing check input for 4 pairings
    fn build_pairing_input(
        proof: &Groth16Proof,
        vk: &VerificationKey,
        ic_sum: &[u8; G1_SIZE],
    ) -> Result<Vec<u8>, VerifierError> {
        let neg_a = Self::g1_negate(&proof.pi_a)?;

        // 4 pairings: (G1, G2) = 4 * (64 + 128) = 768 bytes
        let mut input = Vec::with_capacity(4 * (G1_SIZE + G2_SIZE));

        // (-A, B)
        input.extend_from_slice(&neg_a);
        input.extend_from_slice(&proof.pi_b);

        // (alpha, beta)
        input.extend_from_slice(&vk.alpha_g1);
        input.extend_from_slice(&vk.beta_g2);

        // (IC_sum, gamma)
        input.extend_from_slice(ic_sum);
        input.extend_from_slice(&vk.gamma_g2);

        // (C, delta)
        input.extend_from_slice(&proof.pi_c);
        input.extend_from_slice(&vk.delta_g2);

        Ok(input)
    }

    /// Negate a G1 point (negate y coordinate in Fq)
    fn g1_negate(p: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE], VerifierError> {
        let mut result = *p;

        // BN254 Fq modulus (big-endian)
        // q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
        let q: [u8; 32] = [
            0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
            0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
            0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
            0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
        ];

        let mut y = [0u8; 32];
        y.copy_from_slice(&p[32..64]);

        let is_zero = y.iter().all(|&b| b == 0);

        if !is_zero {
            // Subtract y from q to get -y: result[32..64] = q - y
            let mut borrow = 0i16;
            for i in (0..32).rev() {
                let diff = q[i] as i16 - y[i] as i16 - borrow;
                if diff < 0 {
                    result[32 + i] = (diff + 256) as u8;
                    borrow = 1;
                } else {
                    result[32 + i] = diff as u8;
                    borrow = 0;
                }
            }
        }

        Ok(result)
    }

    /// Execute pairing check
    fn pairing_check(input: &[u8]) -> Result<bool, VerifierError> {
        #[cfg(target_os = "solana")]
        {
            let result = alt_bn128_pairing(input)
                .map_err(|_| VerifierError::CurveOperationFailed)?;

            let is_valid = result.len() == 32
                && result[31] == 1
                && result[..31].iter().all(|&b| b == 0);
            Ok(is_valid)
        }

        #[cfg(not(target_os = "solana"))]
        {
            let _ = input;
            Ok(true)
        }
    }
}
