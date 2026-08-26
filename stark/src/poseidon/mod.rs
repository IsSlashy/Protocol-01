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

    /// [P1.5] Parity vectors — these lock the Poseidon-t3 output for known inputs.
    /// The on-chain verifier's `poseidon_round` composed 30 times (see
    /// programs/p01_stark_verifier/tests for the mirror) MUST produce the same
    /// values. If either side changes (constants, MDS, S-box exponent), both
    /// this test and the on-chain parity test will drift together — signalling
    /// a prover↔verifier protocol break.
    #[test]
    fn parity_vectors_t3() {
        assert_eq!(
            hash2(BaseElement::new(0), BaseElement::new(0)).as_int(),
            parity::POSEIDON_T3_ZERO_ZERO,
        );
        assert_eq!(
            hash2(BaseElement::new(1), BaseElement::new(2)).as_int(),
            parity::POSEIDON_T3_ONE_TWO,
        );
    }

    #[test]
    fn parity_vectors_t5() {
        assert_eq!(
            hash4(
                BaseElement::new(1),
                BaseElement::new(2),
                BaseElement::new(3),
                BaseElement::new(4),
            ).as_int(),
            parity::POSEIDON_T5_ONE_TWO_THREE_FOUR,
        );
    }
}

/// Parity constants shared between the off-chain STARK prover and the on-chain
/// verifier. If any of these values changes you MUST update both:
///   - `stark/src/poseidon/mod.rs::parity`
///   - `programs/p01_stark_verifier/src/verify.rs::parity_tests`
#[cfg(test)]
pub(crate) mod parity {
    // hash2(0, 0) — canonical zero-seed reference
    pub const POSEIDON_T3_ZERO_ZERO: u64 = 18051734659105196655;
    // hash2(1, 2) — canonical (1,2) reference
    pub const POSEIDON_T3_ONE_TWO: u64 = 18184238532291717445;
    // hash4(1, 2, 3, 4)
    pub const POSEIDON_T5_ONE_TWO_THREE_FOUR: u64 = 3933389460072713373;

    // Goldilocks pow7 vectors — pin the S-box primitive across crates.
    // pow7(2) = 128, pow7(3) = 2187, pow7(p-1) = -1 mod p = MODULUS - 1
    pub const POW7_OF_TWO: u64 = 128;
    pub const POW7_OF_THREE: u64 = 2187;
}

#[cfg(test)]
mod pow7_tests {
    use super::{BaseElement, parity};
    use winterfell::math::FieldElement;

    #[inline]
    fn pow7(x: BaseElement) -> BaseElement {
        let x2 = x * x;
        let x4 = x2 * x2;
        let x3 = x2 * x;
        x4 * x3
    }

    #[test]
    fn pow7_parity_vectors() {
        assert_eq!(pow7(BaseElement::new(2)).as_int(), parity::POW7_OF_TWO);
        assert_eq!(pow7(BaseElement::new(3)).as_int(), parity::POW7_OF_THREE);
        // Edge: pow7(0) = 0, pow7(1) = 1
        assert_eq!(pow7(BaseElement::ZERO).as_int(), 0);
        assert_eq!(pow7(BaseElement::ONE).as_int(), 1);
    }
}

#[cfg(test)]
mod emit_for_zk_shielded {
    use super::*;
    use winterfell::math::StarkField;

    /// [C7 / step 7] Emit the t=3 Goldilocks Poseidon constants as RAW u64,
    /// plus parity vectors, for the on-chain pool program.
    ///
    /// `cargo test -p p01-stark --lib emit_poseidon_gl_for_zk_shielded -- --ignored --nocapture`
    ///
    /// WHY THIS EXISTS. `programs/zk_shielded` has NO Goldilocks Poseidon at
    /// all: `merkle_tree.rs::hash_pair` panics and its commented-out body is
    /// BN254, the wrong field. The v3 denominated tree works only because the
    /// client supplies the root (`insert_with_root`). C7 changes that: its
    /// public input 1 is a depth-12 SUBTREE root, so the spending instruction
    /// has to hash the remaining levels ITSELF before it can trust the proof.
    ///
    /// ⛔ The pool program cannot depend on this crate -- winterfell is a host
    /// dependency and will not go into a BPF program -- so it must carry its
    /// own copy. A hand-transcribed copy of ninety field constants is exactly
    /// the kind of silent divergence this repo has been bitten by, so the copy
    /// is GENERATED here and its agreement is pinned by the vectors below.
    #[test]
    #[ignore]
    fn emit_poseidon_gl_for_zk_shielded() {
        let rc = &constants::ROUND_CONSTANTS_T3;
        println!("pub const RC_T3: [u64; 90] = [");
        for (i, v) in rc.iter().enumerate() {
            let end = if i % 3 == 2 { "  // round " } else { "" };
            if end.is_empty() {
                println!("    0x{:016X},", v.as_int());
            } else {
                println!("    0x{:016X},{end}{}", v.as_int(), i / 3);
            }
        }
        println!("];");
        println!();

        // MDS is the circulant [[3,1,1],[1,3,1],[1,1,3]] -- three constants, no
        // table needed on chain: the product is s0*3 + s1 + s2 and rotations.
        let mds = &constants::MDS_MATRIX_T3;
        println!("// MDS_MATRIX_T3 (asserted circulant 3/1/1 so the on-chain form");
        println!("// can be three adds and one mul-by-3 instead of nine muls):");
        for row in mds.iter() {
            println!(
                "//   [{}, {}, {}]",
                row[0].as_int(),
                row[1].as_int(),
                row[2].as_int()
            );
        }
        assert_eq!(mds[0][0].as_int(), 3);
        assert_eq!(mds[0][1].as_int(), 1);
        assert_eq!(mds[0][2].as_int(), 1);
        println!();

        // Parity vectors. These are what pins the on-chain copy to this one.
        println!("pub const PARITY_HASH2: [(u64, u64, u64); 8] = [");
        let cases: [(u64, u64); 8] = [
            (0, 0),
            (1, 0),
            (0, 1),
            (1, 2),
            (0xFFFF_FFFF_0000_0000, 1),
            (42, 999),
            (0x0123_4567_89AB_CDEF, 0xFEDC_BA98_7654_3210),
            (0xFFFF_FFFF_0000_0000, 0xFFFF_FFFF_0000_0000),
        ];
        for (a, b) in cases.iter() {
            let out = hash2(BaseElement::new(*a), BaseElement::new(*b));
            println!("    (0x{:016X}, 0x{:016X}, 0x{:016X}),", a, b, out.as_int());
        }
        println!("];");
    }
}
