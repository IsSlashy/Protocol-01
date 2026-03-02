//! Verification key parsing and hashing.

use crate::types::*;

/// Parse a verification key from binary format.
///
/// Binary format:
/// - alpha_g1: 64 bytes (G1 point)
/// - beta_g2: 128 bytes (G2 point)
/// - gamma_g2: 128 bytes (G2 point)
/// - delta_g2: 128 bytes (G2 point)
/// - ic_count: 4 bytes (u32, little-endian)
/// - IC[]: ic_count * 64 bytes (G1 points)
pub fn parse_vk(vk_data: &[u8]) -> Result<VerificationKey, VerifierError> {
    let min_size = G1_SIZE + G2_SIZE * 3 + 4;
    if vk_data.len() < min_size {
        return Err(VerifierError::InvalidVerificationKey);
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
        vk_data[offset],
        vk_data[offset + 1],
        vk_data[offset + 2],
        vk_data[offset + 3],
    ]) as usize;
    offset += 4;

    let expected_size = offset + ic_count * G1_SIZE;
    if vk_data.len() < expected_size {
        return Err(VerifierError::InvalidVerificationKey);
    }

    let mut ic = Vec::with_capacity(ic_count);
    for _ in 0..ic_count {
        let mut point = [0u8; G1_SIZE];
        point.copy_from_slice(&vk_data[offset..offset + G1_SIZE]);
        ic.push(point);
        offset += G1_SIZE;
    }

    Ok(VerificationKey {
        alpha_g1,
        beta_g2,
        gamma_g2,
        delta_g2,
        ic,
    })
}

/// Compute a keccak256 hash of a verification key.
///
/// Used for on-chain VK comparison -- store the hash instead of the full VK
/// to save account space.
///
/// # Example
/// ```
/// use p01_solana_verifier::compute_vk_hash;
/// let vk_data = vec![0u8; 512];
/// let hash = compute_vk_hash(&vk_data);
/// assert_eq!(hash.len(), 32);
/// ```
pub fn compute_vk_hash(vk_data: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};

    let mut hasher = Keccak256::new();
    hasher.update(vk_data);
    let result = hasher.finalize();

    let mut hash = [0u8; 32];
    hash.copy_from_slice(&result);
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_vk_too_small() {
        let data = vec![0u8; 10];
        assert_eq!(parse_vk(&data).unwrap_err(), VerifierError::InvalidVerificationKey);
    }

    #[test]
    fn test_parse_vk_valid_minimal() {
        // alpha_g1(64) + beta_g2(128) + gamma_g2(128) + delta_g2(128) + ic_count(4) = 452
        // ic_count = 1 -> + 64 = 516 total
        let mut data = vec![0u8; 516];
        // Set ic_count = 1 at offset 448
        data[448] = 1;
        data[449] = 0;
        data[450] = 0;
        data[451] = 0;

        let vk = parse_vk(&data).unwrap();
        assert_eq!(vk.ic.len(), 1);
    }

    #[test]
    fn test_parse_vk_ic_count_mismatch() {
        // Header says 5 IC points but data is too short
        let mut data = vec![0u8; 452];
        data[448] = 5;
        assert_eq!(parse_vk(&data).unwrap_err(), VerifierError::InvalidVerificationKey);
    }

    #[test]
    fn test_vk_hash_deterministic() {
        let data = vec![42u8; 100];
        let hash1 = compute_vk_hash(&data);
        let hash2 = compute_vk_hash(&data);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_vk_hash_different_inputs() {
        let data1 = vec![1u8; 100];
        let data2 = vec![2u8; 100];
        assert_ne!(compute_vk_hash(&data1), compute_vk_hash(&data2));
    }
}
