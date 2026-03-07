//! Poseidon hash function over the Goldilocks field (p = 2^64 - 2^32 + 1).
//!
//! Parameters follow the Poseidon specification for 128-bit security:
//! - S-box: x^7 (alpha = 7, since gcd(7, p-1) = 1 for Goldilocks)
//! - Width t = 3 for 2-to-1 hashing (rate 2, capacity 1)
//! - Width t = 5 for 4-to-1 hashing (rate 4, capacity 1)
//! - Full rounds R_f = 8 (4 at start, 4 at end)
//! - Partial rounds R_p = 22 (for t=3), 22 (for t=5)

pub mod constants;

use winterfell::math::{fields::f64::BaseElement, FieldElement};

/// Apply the S-box: x -> x^7
/// Exponent alpha=7 chosen because gcd(7, p-1) = 1 for Goldilocks.
#[inline(always)]
fn sbox(x: BaseElement) -> BaseElement {
    let x2 = x * x;
    let x4 = x2 * x2;
    let x3 = x2 * x;
    x4 * x3
}

/// Poseidon permutation for width t = 3 (2-to-1 hash).
/// State: [s0, s1, s2] where s2 is capacity.
///
/// Uses 30 FULL rounds (full S-box on all elements every round).
/// This matches the AIR constraint structure for STARK proving.
pub fn permutation_t3(state: &mut [BaseElement; 3]) {
    let rc = &constants::ROUND_CONSTANTS_T3;
    let mds = &constants::MDS_MATRIX_T3;

    for round in 0..30 {
        // Add round constants
        for i in 0..3 {
            state[i] = state[i] + rc[round * 3 + i];
        }
        // Full S-box on ALL elements
        for i in 0..3 {
            state[i] = sbox(state[i]);
        }
        // MDS matrix multiplication
        mds_multiply_t3(state, mds);
    }
}

/// Poseidon permutation for width t = 5 (4-to-1 hash).
/// Uses 30 FULL rounds (full S-box on all elements every round).
pub fn permutation_t5(state: &mut [BaseElement; 5]) {
    let rc = &constants::ROUND_CONSTANTS_T5;
    let mds = &constants::MDS_MATRIX_T5;

    for round in 0..30 {
        for i in 0..5 {
            state[i] = state[i] + rc[round * 5 + i];
        }
        for i in 0..5 {
            state[i] = sbox(state[i]);
        }
        mds_multiply_t5(state, mds);
    }
}

/// MDS matrix-vector multiplication for t=3
fn mds_multiply_t3(state: &mut [BaseElement; 3], mds: &[[BaseElement; 3]; 3]) {
    let mut result = [BaseElement::ZERO; 3];
    for i in 0..3 {
        for j in 0..3 {
            result[i] = result[i] + mds[i][j] * state[j];
        }
    }
    *state = result;
}

/// MDS matrix-vector multiplication for t=5
fn mds_multiply_t5(state: &mut [BaseElement; 5], mds: &[[BaseElement; 5]; 5]) {
    let mut result = [BaseElement::ZERO; 5];
    for i in 0..5 {
        for j in 0..5 {
            result[i] = result[i] + mds[i][j] * state[j];
        }
    }
    *state = result;
}

/// Hash 1 field element: Poseidon(x) using t=3 (rate=2, but only 1 input)
/// Returns the first element of the output state.
pub fn hash1(input: BaseElement) -> BaseElement {
    let mut state = [input, BaseElement::ZERO, BaseElement::ZERO];
    permutation_t3(&mut state);
    state[0]
}

/// Hash 2 field elements: Poseidon(a, b) using t=3 (rate=2)
pub fn hash2(a: BaseElement, b: BaseElement) -> BaseElement {
    let mut state = [a, b, BaseElement::ZERO];
    permutation_t3(&mut state);
    state[0]
}

/// Hash 4 field elements: Poseidon(a, b, c, d) using t=5 (rate=4)
pub fn hash4(
    a: BaseElement,
    b: BaseElement,
    c: BaseElement,
    d: BaseElement,
) -> BaseElement {
    let mut state = [a, b, c, d, BaseElement::ZERO];
    permutation_t5(&mut state);
    state[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sbox_identity() {
        // sbox(0) = 0^7 = 0
        assert_eq!(sbox(BaseElement::ZERO), BaseElement::ZERO);
        // sbox(1) = 1^7 = 1
        assert_eq!(sbox(BaseElement::ONE), BaseElement::ONE);
    }

    #[test]
    fn test_hash1_deterministic() {
        let x = BaseElement::new(42);
        let h1 = hash1(x);
        let h2 = hash1(x);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash1_different_inputs() {
        let h1 = hash1(BaseElement::new(1));
        let h2 = hash1(BaseElement::new(2));
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_hash2_deterministic() {
        let a = BaseElement::new(100);
        let b = BaseElement::new(200);
        assert_eq!(hash2(a, b), hash2(a, b));
    }

    #[test]
    fn test_hash2_order_matters() {
        let a = BaseElement::new(1);
        let b = BaseElement::new(2);
        assert_ne!(hash2(a, b), hash2(b, a));
    }

    #[test]
    fn test_hash4_deterministic() {
        let a = BaseElement::new(10);
        let b = BaseElement::new(20);
        let c = BaseElement::new(30);
        let d = BaseElement::new(40);
        assert_eq!(hash4(a, b, c, d), hash4(a, b, c, d));
    }
}
