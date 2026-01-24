use anchor_lang::prelude::*;
use crate::{errors::ZkShieldedError, Groth16Proof};

// Use Solana's built-in alt_bn128 operations
#[cfg(target_os = "solana")]
use solana_program::alt_bn128::prelude::{
    alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing,
};

/// G1 point size (uncompressed): 64 bytes (32 for x, 32 for y)
const G1_SIZE: usize = 64;
/// G2 point size (uncompressed): 128 bytes (64 for x, 64 for y)
const G2_SIZE: usize = 128;
/// Scalar field element size: 32 bytes
const FR_SIZE: usize = 32;

/// On-chain Groth16 proof verification for BN254 curve
/// Uses Solana's native alt_bn128 syscall for efficient pairing operations
/// Stack-safe implementation that stays within BPF limits
pub struct Groth16Verifier;

impl Groth16Verifier {
    /// Verify a Groth16 proof using Solana's native syscall
    ///
    /// Groth16 verification equation:
    /// e(A, B) = e(alpha, beta) * e(sum(pub_i * IC_i), gamma) * e(C, delta)
    ///
    /// Rearranged for pairing check (product = 1):
    /// e(-A, B) * e(alpha, beta) * e(sum(pub_i * IC_i), gamma) * e(C, delta) = 1
    pub fn verify(
        proof: &Groth16Proof,
        public_inputs: &[[u8; 32]],
        vk_data: &[u8],
    ) -> Result<bool> {
        // Parse verification key components
        let vk = Self::parse_vk(vk_data)?;

        // Compute linear combination: IC[0] + sum(pub_i * IC[i+1])
        let ic_sum = Self::compute_ic_sum(public_inputs, &vk.ic)?;

        // Build pairing input:
        // 4 pairings: (-A, B), (alpha, beta), (IC_sum, gamma), (C, delta)
        let pairing_input = Self::build_pairing_input(
            proof,
            &vk,
            &ic_sum,
        )?;

        // Execute pairing check via syscall
        Self::pairing_check(&pairing_input)
    }

    /// Verify a transfer proof with standard public inputs
    ///
    /// IMPORTANT: Public inputs are received in little-endian format (matching Solana storage)
    /// but the alt_bn128 precompile expects big-endian. We convert inside this function.
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
        let public_amount_bytes = Self::i64_to_field_bytes(public_amount);

        // Convert public inputs from little-endian to big-endian for alt_bn128 pairing
        let public_inputs = [
            Self::le_to_be(merkle_root),
            Self::le_to_be(nullifier_1),
            Self::le_to_be(nullifier_2),
            Self::le_to_be(output_commitment_1),
            Self::le_to_be(output_commitment_2),
            Self::le_to_be(&public_amount_bytes),
            Self::le_to_be(token_mint),
        ];

        Self::verify(proof, &public_inputs, vk_data)
    }

    /// Convert 32-byte array from little-endian to big-endian
    fn le_to_be(bytes: &[u8; 32]) -> [u8; 32] {
        let mut result = [0u8; 32];
        for i in 0..32 {
            result[i] = bytes[31 - i];
        }
        result
    }

    /// Parse verification key from bytes
    /// Format: alpha_g1 (64) | beta_g2 (128) | gamma_g2 (128) | delta_g2 (128) | ic_count (4) | IC[] (64 each)
    fn parse_vk(vk_data: &[u8]) -> Result<VerificationKeyData> {
        let min_size = G1_SIZE + G2_SIZE * 3 + 4;
        if vk_data.len() < min_size {
            return Err(ZkShieldedError::InvalidVerificationKey.into());
        }

        let mut offset = 0;

        // Alpha G1 (64 bytes)
        let mut alpha_g1 = [0u8; G1_SIZE];
        alpha_g1.copy_from_slice(&vk_data[offset..offset + G1_SIZE]);
        offset += G1_SIZE;

        // Beta G2 (128 bytes)
        let mut beta_g2 = [0u8; G2_SIZE];
        beta_g2.copy_from_slice(&vk_data[offset..offset + G2_SIZE]);
        offset += G2_SIZE;

        // Gamma G2 (128 bytes)
        let mut gamma_g2 = [0u8; G2_SIZE];
        gamma_g2.copy_from_slice(&vk_data[offset..offset + G2_SIZE]);
        offset += G2_SIZE;

        // Delta G2 (128 bytes)
        let mut delta_g2 = [0u8; G2_SIZE];
        delta_g2.copy_from_slice(&vk_data[offset..offset + G2_SIZE]);
        offset += G2_SIZE;

        // IC count (4 bytes, little endian)
        let ic_count = u32::from_le_bytes([
            vk_data[offset],
            vk_data[offset + 1],
            vk_data[offset + 2],
            vk_data[offset + 3],
        ]) as usize;
        offset += 4;

        // IC points (64 bytes each)
        let expected_size = offset + ic_count * G1_SIZE;
        if vk_data.len() < expected_size {
            return Err(ZkShieldedError::InvalidVerificationKey.into());
        }

        let mut ic = Vec::with_capacity(ic_count);
        for _ in 0..ic_count {
            let mut point = [0u8; G1_SIZE];
            point.copy_from_slice(&vk_data[offset..offset + G1_SIZE]);
            ic.push(point);
            offset += G1_SIZE;
        }

        Ok(VerificationKeyData {
            alpha_g1,
            beta_g2,
            gamma_g2,
            delta_g2,
            ic,
        })
    }

    /// Compute IC[0] + sum(pub_i * IC[i+1]) using G1 add and scalar mul
    fn compute_ic_sum(public_inputs: &[[u8; 32]], ic: &[[u8; G1_SIZE]]) -> Result<[u8; G1_SIZE]> {
        if public_inputs.len() + 1 != ic.len() {
            return Err(ZkShieldedError::InvalidPublicInputs.into());
        }

        // Start with IC[0]
        let mut result = ic[0];

        // Add pub_i * IC[i+1] for each public input
        for (i, pub_input) in public_inputs.iter().enumerate() {
            // Scalar multiplication: pub_i * IC[i+1]
            let mul_result = Self::g1_scalar_mul(&ic[i + 1], pub_input)?;
            // Point addition: result + mul_result
            result = Self::g1_add(&result, &mul_result)?;
        }

        Ok(result)
    }

    /// G1 point addition using Solana's alt_bn128 precompile
    fn g1_add(p1: &[u8; G1_SIZE], p2: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE]> {
        let mut input = [0u8; G1_SIZE * 2];
        input[..G1_SIZE].copy_from_slice(p1);
        input[G1_SIZE..].copy_from_slice(p2);

        #[cfg(target_os = "solana")]
        {
            let result_vec = alt_bn128_addition(&input)
                .map_err(|_| ZkShieldedError::InvalidProof)?;
            let mut result = [0u8; G1_SIZE];
            result.copy_from_slice(&result_vec);
            Ok(result)
        }

        #[cfg(not(target_os = "solana"))]
        {
            // For testing: just return p1 (not mathematically correct)
            Ok(*p1)
        }
    }

    /// G1 scalar multiplication using Solana's alt_bn128 precompile
    fn g1_scalar_mul(p: &[u8; G1_SIZE], scalar: &[u8; FR_SIZE]) -> Result<[u8; G1_SIZE]> {
        let mut input = [0u8; G1_SIZE + FR_SIZE];
        input[..G1_SIZE].copy_from_slice(p);
        input[G1_SIZE..].copy_from_slice(scalar);

        #[cfg(target_os = "solana")]
        {
            let result_vec = alt_bn128_multiplication(&input)
                .map_err(|_| ZkShieldedError::InvalidProof)?;
            let mut result = [0u8; G1_SIZE];
            result.copy_from_slice(&result_vec);
            Ok(result)
        }

        #[cfg(not(target_os = "solana"))]
        {
            // For testing: just return p (not mathematically correct)
            Ok(*p)
        }
    }

    /// Build pairing check input for 4 pairings
    fn build_pairing_input(
        proof: &Groth16Proof,
        vk: &VerificationKeyData,
        ic_sum: &[u8; G1_SIZE],
    ) -> Result<Vec<u8>> {
        // Negate A for the pairing equation
        let neg_a = Self::g1_negate(&proof.pi_a)?;

        // 4 pairings: (G1, G2) pairs = 4 * (64 + 128) = 768 bytes
        let mut input = Vec::with_capacity(4 * (G1_SIZE + G2_SIZE));

        // Pairing 1: (-A, B)
        input.extend_from_slice(&neg_a);
        input.extend_from_slice(&proof.pi_b);

        // Pairing 2: (alpha, beta)
        input.extend_from_slice(&vk.alpha_g1);
        input.extend_from_slice(&vk.beta_g2);

        // Pairing 3: (IC_sum, gamma)
        input.extend_from_slice(ic_sum);
        input.extend_from_slice(&vk.gamma_g2);

        // Pairing 4: (C, delta)
        input.extend_from_slice(&proof.pi_c);
        input.extend_from_slice(&vk.delta_g2);

        Ok(input)
    }

    /// Negate G1 point (negate y coordinate in the field)
    /// Input/output are in BIG-ENDIAN format (as expected by alt_bn128)
    fn g1_negate(p: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE]> {
        let mut result = *p;

        // BN254 field modulus for Fq (BIG-ENDIAN)
        // q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
        let q: [u8; 32] = [
            0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
            0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
            0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
            0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
        ];

        // Copy y coordinate (bytes 32-63)
        let mut y = [0u8; 32];
        y.copy_from_slice(&p[32..64]);

        // Check if y is zero
        let is_zero = y.iter().all(|&b| b == 0);

        if !is_zero {
            // Subtract y from q to get -y: result[32..64] = q - y
            // For big-endian, we subtract from the END (index 31) to the START (index 0)
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

    /// Execute pairing check: e(P1, Q1) * e(P2, Q2) * ... = 1
    fn pairing_check(input: &[u8]) -> Result<bool> {
        #[cfg(target_os = "solana")]
        {
            let result = alt_bn128_pairing(input)
                .map_err(|_| ZkShieldedError::InvalidProof)?;

            // Result is 1 (as 32-byte big-endian) if pairing check passes
            let is_valid = result.len() == 32
                && result[31] == 1
                && result[..31].iter().all(|&b| b == 0);
            Ok(is_valid)
        }

        #[cfg(not(target_os = "solana"))]
        {
            // For testing: always return true
            let _ = input;
            Ok(true)
        }
    }

    /// Convert i64 to field element bytes (handles negative values)
    /// For negative values, returns FIELD_MODULUS - |value| (little-endian)
    fn i64_to_field_bytes(value: i64) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        if value >= 0 {
            let value_bytes = (value as u64).to_le_bytes();
            bytes[..8].copy_from_slice(&value_bytes);
        } else {
            // For negative values: -x in field = p - x where p is BN254 Fr modulus
            // BN254 Fr modulus (little-endian):
            // p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
            let p: [u8; 32] = [
                0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43,
                0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8, 0x33, 0x28,
                0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8,
                0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
            ];

            // Compute p - |value| using subtraction with borrow
            let abs_value = value.unsigned_abs();
            let abs_bytes = abs_value.to_le_bytes();

            let mut borrow: u16 = 0;
            for i in 0..32 {
                let p_byte = p[i] as u16;
                let v_byte = if i < 8 { abs_bytes[i] as u16 } else { 0 };
                let diff = p_byte.wrapping_sub(v_byte).wrapping_sub(borrow);

                if p_byte < v_byte + borrow {
                    bytes[i] = diff as u8;
                    borrow = 1;
                } else {
                    bytes[i] = diff as u8;
                    borrow = 0;
                }
            }
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

/// Parsed verification key data (heap-allocated to reduce stack usage)
struct VerificationKeyData {
    alpha_g1: [u8; G1_SIZE],
    beta_g2: [u8; G2_SIZE],
    gamma_g2: [u8; G2_SIZE],
    delta_g2: [u8; G2_SIZE],
    ic: Vec<[u8; G1_SIZE]>,
}

/// Prepared verification key for caching
#[derive(Clone)]
pub struct PreparedVerifyingKey {
    pub vk_data: Vec<u8>,
    pub vk_hash: [u8; 32],
}

impl PreparedVerifyingKey {
    /// Create from raw verification key bytes
    pub fn from_bytes(vk_data: &[u8]) -> Result<Self> {
        let vk_hash = Groth16Verifier::hash_verification_key(vk_data);
        Ok(Self {
            vk_data: vk_data.to_vec(),
            vk_hash
        })
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
        assert_eq!(bytes[8..32], [0u8; 24]);
    }

    #[test]
    fn test_i64_to_field_bytes_negative() {
        // -1000 in BN254 Fr field = p - 1000
        // p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        // p - 1000 = 21888242871839275222246405745257275088548364400416034343698204186575808494617
        let value: i64 = -1000;
        let bytes = Groth16Verifier::i64_to_field_bytes(value);

        // p - 1000 in little-endian should have the lower bytes modified
        // p[0..8] in LE = 0x43e1f593f0000001
        // p - 1000: the first byte should be 0x01 - 0xe8 (1000 in LE starts with 0xe8, 0x03, ...)
        // Actually 1000 = 0x3E8, so LE is [0xe8, 0x03, 0, 0, 0, 0, 0, 0]
        // p[0..8] LE = [0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43]
        // So p - 1000: 0x01 - 0xe8 needs borrow -> (256 + 1 - 232) = 25 = 0x19, borrow=1
        // Then 0x00 - 0x03 - 1 (borrow) -> (256 - 4) = 252 = 0xfc, borrow=1
        // Then 0x00 - 0x00 - 1 -> (256 - 1) = 255 = 0xff, borrow=1
        // And so on...

        // The important thing is it should NOT have 0xFF at byte 31
        // byte 31 for p is 0x30, and we're subtracting from it with possible borrow
        // Since 1000 is small, the upper bytes should remain mostly unchanged

        // Verify it's a valid field element (not the buggy 0xFF marker)
        // For -1000, byte 31 should be 0x30 (same as p's byte 31, since the subtraction
        // doesn't propagate that far for such a small number)
        assert_eq!(bytes[31], 0x30);

        // Verify the lower bytes are correctly computed
        // p - 1000 lower byte: 0x01 - 0xe8 with borrow = 0x19
        assert_eq!(bytes[0], 0x19);
    }

    #[test]
    fn test_i64_to_field_bytes_negative_one() {
        // -1 in BN254 Fr field = p - 1
        let value: i64 = -1;
        let bytes = Groth16Verifier::i64_to_field_bytes(value);

        // p - 1: the first byte should be 0x01 - 0x01 = 0x00
        assert_eq!(bytes[0], 0x00);
        // byte 31 should still be 0x30
        assert_eq!(bytes[31], 0x30);
    }
}
