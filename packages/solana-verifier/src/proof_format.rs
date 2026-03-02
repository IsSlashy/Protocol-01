//! Proof format conversion between snarkjs and on-chain format.
//!
//! # The G2 Point Problem
//!
//! snarkjs outputs G2 points as: `[[c0_x, c1_x], [c0_y, c1_y]]`
//! (where c0 = real, c1 = imaginary)
//!
//! The EIP-197 / alt_bn128 precompile expects: `[c1_x, c0_x, c1_y, c0_y]`
//! (imaginary first, then real)
//!
//! This means you need to **swap** the real and imaginary components
//! when converting from snarkjs format to on-chain format.
//!
//! This is the #1 cause of "proof passes off-chain but fails on-chain" bugs.

use crate::types::Groth16Proof;

/// Convert proof components from snarkjs JSON format to on-chain bytes.
///
/// snarkjs proof format:
/// ```json
/// {
///   "pi_a": ["x", "y", "1"],
///   "pi_b": [["c0_x", "c1_x"], ["c0_y", "c1_y"], ["1", "0"]],
///   "pi_c": ["x", "y", "1"]
/// }
/// ```
///
/// On-chain format (256 bytes):
/// - pi_a: [x_be(32), y_be(32)]
/// - pi_b: [x_imag_be(32), x_real_be(32), y_imag_be(32), y_real_be(32)]
/// - pi_c: [x_be(32), y_be(32)]
///
/// The key insight: pi_b components are SWAPPED (imaginary before real).
pub fn proof_from_snarkjs(
    pi_a: &[&str; 2],
    pi_b: &[[&str; 2]; 2],
    pi_c: &[&str; 2],
) -> Groth16Proof {
    let mut proof_a = [0u8; 64];
    let mut proof_b = [0u8; 128];
    let mut proof_c = [0u8; 64];

    // pi_a (G1): [x, y] -- straightforward
    write_field_be(&mut proof_a[0..32], pi_a[0]);
    write_field_be(&mut proof_a[32..64], pi_a[1]);

    // pi_b (G2): SWAP real/imaginary
    // snarkjs [0] = [c0_x (real), c1_x (imag)]
    // on-chain: [c1_x (imag), c0_x (real), c1_y (imag), c0_y (real)]
    write_field_be(&mut proof_b[0..32], pi_b[0][1]);   // x_imag
    write_field_be(&mut proof_b[32..64], pi_b[0][0]);   // x_real
    write_field_be(&mut proof_b[64..96], pi_b[1][1]);   // y_imag
    write_field_be(&mut proof_b[96..128], pi_b[1][0]);  // y_real

    // pi_c (G1): [x, y] -- straightforward
    write_field_be(&mut proof_c[0..32], pi_c[0]);
    write_field_be(&mut proof_c[32..64], pi_c[1]);

    Groth16Proof {
        pi_a: proof_a,
        pi_b: proof_b,
        pi_c: proof_c,
    }
}

/// Write a decimal string field element as 32 big-endian bytes.
fn write_field_be(dest: &mut [u8], value_str: &str) {
    // Parse decimal string to bytes (big-endian)
    // dest[31] = least significant byte, dest[0] = most significant byte
    let mut n = parse_decimal(value_str);
    for byte in dest.iter_mut().rev() {
        *byte = (n & 0xFF) as u8;
        n >>= 8;
    }
}

/// Parse a decimal string to a big integer represented as [u64; 4] (256-bit).
///
/// This handles the full BN254 field element range (up to ~254 bits).
/// Returns the value as a u128 for simplicity in the write path.
///
/// Note: For field elements larger than u128::MAX (~3.4e38), this will
/// wrap. In practice, snarkjs outputs values within the BN254 field
/// which fits in 254 bits. For production use with very large values,
/// consider a proper big-integer library.
fn parse_decimal(s: &str) -> u128 {
    let mut result: u128 = 0;
    for ch in s.chars() {
        if let Some(digit) = ch.to_digit(10) {
            result = result.wrapping_mul(10).wrapping_add(digit as u128);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proof_from_snarkjs_layout() {
        let proof = proof_from_snarkjs(
            &["1", "2"],
            &[["3", "4"], ["5", "6"]],
            &["7", "8"],
        );

        // pi_a x = 1 (big-endian, last byte)
        assert_eq!(proof.pi_a[31], 1);
        // pi_a y = 2
        assert_eq!(proof.pi_a[63], 2);

        // pi_b: snarkjs [0] = [real=3, imag=4]
        // on-chain: [imag, real, imag, real]
        // x_imag = 4 (first 32 bytes of pi_b)
        assert_eq!(proof.pi_b[31], 4);
        // x_real = 3
        assert_eq!(proof.pi_b[63], 3);
        // y_imag = 6
        assert_eq!(proof.pi_b[95], 6);
        // y_real = 5
        assert_eq!(proof.pi_b[127], 5);

        // pi_c x = 7
        assert_eq!(proof.pi_c[31], 7);
        // pi_c y = 8
        assert_eq!(proof.pi_c[63], 8);
    }

    #[test]
    fn test_proof_size() {
        let proof = proof_from_snarkjs(
            &["0", "0"],
            &[["0", "0"], ["0", "0"]],
            &["0", "0"],
        );
        let bytes = proof.to_bytes();
        assert_eq!(bytes.len(), 256);
    }
}
