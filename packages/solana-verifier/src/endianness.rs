//! Endianness conversion utilities.
//!
//! Solana stores values in little-endian, but the alt_bn128 precompile
//! expects big-endian. This module handles the conversion.

/// Convert a 32-byte array from little-endian to big-endian.
///
/// # Example
/// ```
/// use p01_solana_verifier::le_to_be;
/// let le = [1u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/// let be = le_to_be(&le);
/// assert_eq!(be[31], 1);
/// assert_eq!(be[0], 0);
/// ```
pub fn le_to_be(bytes: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    for i in 0..32 {
        result[i] = bytes[31 - i];
    }
    result
}

/// Convert a 32-byte array from big-endian to little-endian.
///
/// # Example
/// ```
/// use p01_solana_verifier::be_to_le;
/// let be = [0u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
/// let le = be_to_le(&be);
/// assert_eq!(le[0], 1);
/// assert_eq!(le[31], 0);
/// ```
pub fn be_to_le(bytes: &[u8; 32]) -> [u8; 32] {
    le_to_be(bytes) // Same operation -- it's a byte reversal
}

/// Convert an i64 to a 32-byte field element (little-endian).
///
/// For negative values, computes `p - |value|` where p is the BN254 Fr modulus.
/// This gives the correct field representation of negative numbers.
///
/// # Example
/// ```
/// use p01_solana_verifier::endianness::i64_to_field_le;
/// let positive = i64_to_field_le(42);
/// assert_eq!(positive[0], 42);
/// assert_eq!(positive[1], 0);
///
/// let negative = i64_to_field_le(-1);
/// // -1 in Fr = p - 1, which has byte[31] = 0x30
/// assert_eq!(negative[31], 0x30);
/// ```
pub fn i64_to_field_le(value: i64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    if value >= 0 {
        let value_bytes = (value as u64).to_le_bytes();
        bytes[..8].copy_from_slice(&value_bytes);
    } else {
        // BN254 Fr modulus (little-endian)
        // p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        let p: [u8; 32] = [
            0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43,
            0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8, 0x33, 0x28,
            0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8,
            0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
        ];

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

/// Convert a u64 to a 32-byte field element (little-endian).
///
/// # Example
/// ```
/// use p01_solana_verifier::endianness::u64_to_field_le;
/// let field = u64_to_field_le(1_000_000);
/// let recovered = u64::from_le_bytes(field[..8].try_into().unwrap());
/// assert_eq!(recovered, 1_000_000);
/// ```
pub fn u64_to_field_le(value: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(&value.to_le_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_le_be_roundtrip() {
        let original = [0u8; 32];
        let mut input = original;
        input[0] = 0x42;
        input[31] = 0xFF;

        let converted = le_to_be(&input);
        assert_eq!(converted[31], 0x42);
        assert_eq!(converted[0], 0xFF);

        let back = be_to_le(&converted);
        assert_eq!(back, input);
    }

    #[test]
    fn test_i64_positive() {
        let bytes = i64_to_field_le(1000);
        assert_eq!(bytes[0..8], 1000u64.to_le_bytes());
        assert_eq!(bytes[8..32], [0u8; 24]);
    }

    #[test]
    fn test_i64_negative() {
        let bytes = i64_to_field_le(-1000);
        // byte 31 should be 0x30 (same as Fr modulus upper byte)
        assert_eq!(bytes[31], 0x30);
        // Lower byte: 0x01 - 0xe8 with borrow = 0x19
        assert_eq!(bytes[0], 0x19);
    }

    #[test]
    fn test_i64_negative_one() {
        let bytes = i64_to_field_le(-1);
        // p - 1: first byte is 0x01 - 0x01 = 0x00
        assert_eq!(bytes[0], 0x00);
        assert_eq!(bytes[31], 0x30);
    }

    #[test]
    fn test_u64_to_field() {
        let bytes = u64_to_field_le(12345);
        let recovered = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        assert_eq!(recovered, 12345);
        assert_eq!(bytes[8..], [0u8; 24]);
    }
}
