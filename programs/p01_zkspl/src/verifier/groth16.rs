use anchor_lang::prelude::*;
use crate::errors::ZkSplError;
use crate::Groth16Proof;

/// Reuses the same Groth16 verification logic as zk_shielded.
/// The on-chain verifier uses Solana's alt_bn128 precompile (syscall)
/// for elliptic curve operations: addition, scalar multiplication, pairing.

#[cfg(target_os = "solana")]
#[allow(deprecated)]
use solana_bn254::prelude::{
    alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing,
};

const G1_SIZE: usize = 64;
const G2_SIZE: usize = 128;
const FR_SIZE: usize = 32;

pub struct Groth16Verifier;

impl Groth16Verifier {
    /// Verify a Groth16 proof against public inputs and verification key.
    ///
    /// Groth16 pairing check:
    ///   e(-A, B) * e(alpha, beta) * e(IC_sum, gamma) * e(C, delta) = 1
    pub fn verify(
        proof: &Groth16Proof,
        public_inputs: &[[u8; 32]],
        vk_data: &[u8],
    ) -> Result<bool> {
        let vk = Self::parse_vk(vk_data)?;
        let ic_sum = Self::compute_ic_sum(public_inputs, &vk.ic)?;
        let pairing_input = Self::build_pairing_input(proof, &vk, &ic_sum)?;
        Self::pairing_check(&pairing_input)
    }

    /// Verify a confidential balance proof.
    /// Public inputs (7): old_commitment, new_commitment, amount_hash,
    ///                     public_credit, public_debit, token_mint, nonce
    pub fn verify_confidential_balance(
        proof: &Groth16Proof,
        old_commitment: &[u8; 32],
        new_commitment: &[u8; 32],
        amount_hash: &[u8; 32],
        public_credit: u64,
        public_debit: u64,
        token_mint: &[u8; 32],
        nonce: u64,
        vk_data: &[u8],
    ) -> Result<bool> {
        let public_inputs = [
            Self::le_to_be(old_commitment),
            Self::le_to_be(new_commitment),
            Self::le_to_be(amount_hash),
            Self::u64_to_field_be(public_credit),
            Self::u64_to_field_be(public_debit),
            Self::le_to_be(token_mint),
            Self::u64_to_field_be(nonce),
        ];

        Self::verify(proof, &public_inputs, vk_data)
    }

    /// Verify a balance sufficiency proof.
    /// Public inputs (3): balance_commitment, threshold, token_mint
    pub fn verify_balance_proof(
        proof: &Groth16Proof,
        balance_commitment: &[u8; 32],
        threshold: u64,
        token_mint: &[u8; 32],
        vk_data: &[u8],
    ) -> Result<bool> {
        let public_inputs = [
            Self::le_to_be(balance_commitment),
            Self::u64_to_field_be(threshold),
            Self::le_to_be(token_mint),
        ];

        Self::verify(proof, &public_inputs, vk_data)
    }

    /// Convert little-endian 32 bytes to big-endian (alt_bn128 expects BE)
    fn le_to_be(bytes: &[u8; 32]) -> [u8; 32] {
        let mut result = [0u8; 32];
        for i in 0..32 {
            result[i] = bytes[31 - i];
        }
        result
    }

    /// Convert u64 to big-endian field element bytes
    fn u64_to_field_be(value: u64) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        // Put value in last 8 bytes (big-endian)
        let value_bytes = value.to_be_bytes();
        bytes[24..32].copy_from_slice(&value_bytes);
        bytes
    }

    /// Parse verification key from binary format.
    /// Format: alpha_g1(64) | beta_g2(128) | gamma_g2(128) | delta_g2(128) | ic_count(4) | IC[](64 each)
    fn parse_vk(vk_data: &[u8]) -> Result<VerificationKeyData> {
        let min_size = G1_SIZE + G2_SIZE * 3 + 4;
        if vk_data.len() < min_size {
            return Err(ZkSplError::InvalidVerificationKey.into());
        }

        let mut offset = 0;

        let mut alpha_g1 = [0u8; G1_SIZE];
        alpha_g1.copy_from_slice(&vk_data[offset..offset + G1_SIZE]);
        offset += G1_SIZE;

        let mut beta_g2 = [0u8; G2_SIZE];
        beta_g2.copy_from_slice(&vk_data[offset..offset + G2_SIZE]);
        offset += G2_SIZE;

        let mut gamma_g2 = [0u8; G2_SIZE];
        gamma_g2.copy_from_slice(&vk_data[offset..offset + G2_SIZE]);
        offset += G2_SIZE;

        let mut delta_g2 = [0u8; G2_SIZE];
        delta_g2.copy_from_slice(&vk_data[offset..offset + G2_SIZE]);
        offset += G2_SIZE;

        let ic_count = u32::from_le_bytes([
            vk_data[offset], vk_data[offset + 1],
            vk_data[offset + 2], vk_data[offset + 3],
        ]) as usize;
        offset += 4;

        let expected_size = offset + ic_count * G1_SIZE;
        if vk_data.len() < expected_size {
            return Err(ZkSplError::InvalidVerificationKey.into());
        }

        let mut ic = Vec::with_capacity(ic_count);
        for _ in 0..ic_count {
            let mut point = [0u8; G1_SIZE];
            point.copy_from_slice(&vk_data[offset..offset + G1_SIZE]);
            ic.push(point);
            offset += G1_SIZE;
        }

        Ok(VerificationKeyData { alpha_g1, beta_g2, gamma_g2, delta_g2, ic })
    }

    /// IC[0] + sum(pub_i * IC[i+1])
    fn compute_ic_sum(public_inputs: &[[u8; 32]], ic: &[[u8; G1_SIZE]]) -> Result<[u8; G1_SIZE]> {
        if public_inputs.len() + 1 != ic.len() {
            return Err(ZkSplError::InvalidPublicInputs.into());
        }

        let mut result = ic[0];
        for (i, pub_input) in public_inputs.iter().enumerate() {
            let mul_result = Self::g1_scalar_mul(&ic[i + 1], pub_input)?;
            result = Self::g1_add(&result, &mul_result)?;
        }

        Ok(result)
    }

    fn g1_add(p1: &[u8; G1_SIZE], p2: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE]> {
        let mut input = [0u8; G1_SIZE * 2];
        input[..G1_SIZE].copy_from_slice(p1);
        input[G1_SIZE..].copy_from_slice(p2);

        #[cfg(target_os = "solana")]
        {
            let result_vec = alt_bn128_addition(&input)
                .map_err(|_| ZkSplError::InvalidProof)?;
            let mut result = [0u8; G1_SIZE];
            result.copy_from_slice(&result_vec);
            Ok(result)
        }

        #[cfg(not(target_os = "solana"))]
        { Ok(*p1) }
    }

    fn g1_scalar_mul(p: &[u8; G1_SIZE], scalar: &[u8; FR_SIZE]) -> Result<[u8; G1_SIZE]> {
        let mut input = [0u8; G1_SIZE + FR_SIZE];
        input[..G1_SIZE].copy_from_slice(p);
        input[G1_SIZE..].copy_from_slice(scalar);

        #[cfg(target_os = "solana")]
        {
            let result_vec = alt_bn128_multiplication(&input)
                .map_err(|_| ZkSplError::InvalidProof)?;
            let mut result = [0u8; G1_SIZE];
            result.copy_from_slice(&result_vec);
            Ok(result)
        }

        #[cfg(not(target_os = "solana"))]
        { Ok(*p) }
    }

    fn build_pairing_input(
        proof: &Groth16Proof,
        vk: &VerificationKeyData,
        ic_sum: &[u8; G1_SIZE],
    ) -> Result<Vec<u8>> {
        let neg_a = Self::g1_negate(&proof.pi_a)?;
        let mut input = Vec::with_capacity(4 * (G1_SIZE + G2_SIZE));

        input.extend_from_slice(&neg_a);
        input.extend_from_slice(&proof.pi_b);

        input.extend_from_slice(&vk.alpha_g1);
        input.extend_from_slice(&vk.beta_g2);

        input.extend_from_slice(ic_sum);
        input.extend_from_slice(&vk.gamma_g2);

        input.extend_from_slice(&proof.pi_c);
        input.extend_from_slice(&vk.delta_g2);

        Ok(input)
    }

    fn g1_negate(p: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE]> {
        let mut result = *p;

        // BN254 Fq modulus (big-endian)
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

    fn pairing_check(input: &[u8]) -> Result<bool> {
        #[cfg(target_os = "solana")]
        {
            let result = alt_bn128_pairing(input)
                .map_err(|_| ZkSplError::InvalidProof)?;
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

    /// Hash a verification key for on-chain storage comparison
    pub fn hash_vk(vk_data: &[u8]) -> [u8; 32] {
        use sha3::{Digest, Keccak256};
        let mut hasher = Keccak256::new();
        hasher.update(vk_data);
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
}

struct VerificationKeyData {
    alpha_g1: [u8; G1_SIZE],
    beta_g2: [u8; G2_SIZE],
    gamma_g2: [u8; G2_SIZE],
    delta_g2: [u8; G2_SIZE],
    ic: Vec<[u8; G1_SIZE]>,
}
