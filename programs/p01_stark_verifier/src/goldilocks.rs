/// Goldilocks field: p = 2^64 - 2^32 + 1
/// Fast modular arithmetic using the special structure of the prime.

pub const MODULUS: u64 = 0xFFFFFFFF00000001; // 2^64 - 2^32 + 1

/// A field element in the Goldilocks field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(transparent)]
pub struct Felt(pub u64);

impl Felt {
    pub const ZERO: Self = Felt(0);
    pub const ONE: Self = Felt(1);

    #[inline]
    pub const fn new(v: u64) -> Self {
        Felt(v % MODULUS)
    }

    #[inline]
    pub fn as_u64(self) -> u64 {
        self.0
    }

    #[inline]
    pub fn add(self, rhs: Self) -> Self {
        let (sum, carry) = self.0.overflowing_add(rhs.0);
        if carry || sum >= MODULUS {
            Felt(sum.wrapping_sub(MODULUS))
        } else {
            Felt(sum)
        }
    }

    #[inline]
    pub fn sub(self, rhs: Self) -> Self {
        if self.0 >= rhs.0 {
            Felt(self.0 - rhs.0)
        } else {
            Felt(MODULUS - (rhs.0 - self.0))
        }
    }

    #[inline]
    pub fn mul(self, rhs: Self) -> Self {
        let full = (self.0 as u128) * (rhs.0 as u128);
        Felt(reduce128(full))
    }

    /// x^7 = x^4 * x^2 * x (Poseidon S-box)
    #[inline]
    pub fn pow7(self) -> Self {
        let x2 = self.mul(self);
        let x4 = x2.mul(x2);
        x4.mul(x2).mul(self)
    }

    /// Modular exponentiation by squaring.
    pub fn exp(self, mut e: u64) -> Self {
        let mut result = Felt::ONE;
        let mut base = self;
        while e > 0 {
            if e & 1 == 1 {
                result = result.mul(base);
            }
            base = base.mul(base);
            e >>= 1;
        }
        result
    }

    /// Modular inverse using Fermat's little theorem: a^(-1) = a^(p-2) mod p
    pub fn inv(self) -> Self {
        self.exp(MODULUS - 2)
    }

    /// Serialize to little-endian bytes.
    pub fn to_le_bytes(self) -> [u8; 8] {
        self.0.to_le_bytes()
    }

    /// Deserialize from little-endian bytes.
    pub fn from_le_bytes(bytes: [u8; 8]) -> Self {
        let v = u64::from_le_bytes(bytes);
        Felt(v % MODULUS)
    }
}

#[cfg(test)]
mod parity_tests {
    use super::*;

    // References: `stark/src/poseidon/mod.rs::parity::POW7_OF_*`.
    const POW7_OF_TWO: u64 = 128;
    const POW7_OF_THREE: u64 = 2187;

    #[test]
    fn pow7_parity_vectors() {
        assert_eq!(Felt::new(2).pow7().as_u64(), POW7_OF_TWO);
        assert_eq!(Felt::new(3).pow7().as_u64(), POW7_OF_THREE);
        assert_eq!(Felt::ZERO.pow7().as_u64(), 0);
        assert_eq!(Felt::ONE.pow7().as_u64(), 1);
    }

    #[test]
    fn add_sub_mul_around_modulus() {
        // (MODULUS - 1) + 1 = 0 mod p
        let m1 = Felt::new(MODULUS - 1);
        assert_eq!(m1.add(Felt::ONE).as_u64(), 0);
        // 0 - 1 = MODULUS - 1
        assert_eq!(Felt::ZERO.sub(Felt::ONE).as_u64(), MODULUS - 1);
        // Multiplication wraparound: 2 * (p-1)/2 via composition
        // (p-1) * 2 mod p = p - 2
        let product = m1.mul(Felt::new(2));
        assert_eq!(product.as_u64(), MODULUS - 2);
    }

    /// Reference reduction, deliberately slow and obviously correct.
    fn reference_mul(a: u64, b: u64) -> u64 {
        (((a as u128) * (b as u128)) % (MODULUS as u128)) as u64
    }

    /// The three witnesses that the previous `reduce128` got wrong, each by
    /// exactly 2^32 - 1, with both operands canonical. Pinned so the defect
    /// cannot come back silently.
    #[test]
    fn reduce128_known_counterexamples() {
        const VECTORS: [(u64, u64); 3] = [
            (4294967300, 18446744065119617031),
            (4294967301, 18446744060824649742),
            (4294967302, 18446744056529682455),
        ];
        for (a, b) in VECTORS {
            assert!(a < MODULUS && b < MODULUS, "operands must be canonical");
            let got = Felt::new(a).mul(Felt::new(b)).as_u64();
            let want = reference_mul(a, b);
            assert_eq!(got, want, "mul({a}, {b}) = {got}, expected {want}");
        }
    }

    /// Structured differential test. Random sampling cannot reach this defect
    /// (200M pairs found nothing), so walk the edges on purpose: values near 0,
    /// near 2^32, near EPSILON, and near MODULUS, in every combination, plus a
    /// deterministic pseudo-random sweep.
    #[test]
    fn reduce128_differential_against_u128() {
        let mut edges: Vec<u64> = Vec::new();
        for base in [0u64, 1, 2, EPSILON, EPSILON + 1, 1u64 << 32, MODULUS] {
            for delta in 0..=4u64 {
                edges.push(base.wrapping_add(delta) % MODULUS);
                edges.push(base.wrapping_sub(delta) % MODULUS);
            }
        }
        for &a in &edges {
            for &b in &edges {
                assert_eq!(
                    Felt::new(a).mul(Felt::new(b)).as_u64(),
                    reference_mul(a, b),
                    "edge mul({a}, {b})"
                );
            }
        }

        // Deterministic sweep (xorshift64*), so a failure is reproducible.
        let mut s: u64 = 0x2545F4914F6CDD1D;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s % MODULUS
        };
        for _ in 0..200_000 {
            let a = next();
            let b = next();
            assert_eq!(
                Felt::new(a).mul(Felt::new(b)).as_u64(),
                reference_mul(a, b),
                "sweep mul({a}, {b})"
            );
        }
    }

    /// `pow7` is the Poseidon S-box and rides entirely on `reduce128`.
    #[test]
    fn pow7_matches_reference() {
        let reference_pow7 = |x: u64| {
            let mut acc: u128 = 1;
            for _ in 0..7 {
                acc = (acc * (x as u128)) % (MODULUS as u128);
            }
            acc as u64
        };
        for x in [0u64, 1, 2, EPSILON, EPSILON + 1, 1u64 << 32, MODULUS - 1, MODULUS - 2] {
            assert_eq!(Felt::new(x).pow7().as_u64(), reference_pow7(x), "pow7({x})");
        }
    }
}

/// `2^64 mod p`. Also `2^64 - MODULUS`, which is why subtracting MODULUS and
/// adding EPSILON are the same operation on a wrapped u64.
const EPSILON: u64 = 0xFFFF_FFFF; // 2^32 - 1

/// Reduce a 128-bit product modulo the Goldilocks prime.
///
/// Splits the high word, because the two halves have different weights:
///   2^64 ≡ 2^32 - 1 = EPSILON   (mod p)
///   2^96 ≡ 2^32·(2^32 - 1) = 2^64 - 2^32 ≡ -1   (mod p)
/// so for `x = lo + hi_lo·2^64 + hi_hi·2^96`:
///   x ≡ lo - hi_hi + hi_lo·EPSILON   (mod p)
///
/// The previous implementation multiplied the WHOLE high word by EPSILON and
/// then folded the 128-bit result back with `sum.wrapping_sub(MODULUS)` guarded
/// by `carry || sum >= MODULUS`. That guard is correct in `add`, where both
/// operands are canonical and so `a + b - p < p`, but it is wrong here: neither
/// `low` nor `reduced` is bounded by p, so a single correction can leave a value
/// that is still >= p, and it was returned unreduced. The result was then short
/// by exactly EPSILON. Three constructible witnesses, all with canonical
/// operands, are pinned in `reduce128_known_counterexamples` below.
///
/// Random testing could not find this: 200M random canonical pairs and 36M
/// near-maximal pairs produced zero mismatches. Do not "verify" this function by
/// sampling — the differential test below walks structured edge cases on purpose.
#[inline]
fn reduce128(x: u128) -> u64 {
    let x_lo = x as u64;
    let x_hi = (x >> 64) as u64;
    let x_hi_hi = x_hi >> 32; // weight 2^96 ≡ -1
    let x_hi_lo = x_hi & EPSILON; // weight 2^64 ≡ EPSILON

    // lo - hi_hi (mod p). On borrow the wrapped value is 2^64 too large, and
    // 2^64 ≡ EPSILON, so remove EPSILON rather than MODULUS.
    let (t0, borrow) = x_lo.overflowing_sub(x_hi_hi);
    let t0 = if borrow { t0.wrapping_sub(EPSILON) } else { t0 };

    // hi_lo < 2^32 and EPSILON < 2^32, so this cannot overflow u64.
    let t1 = x_hi_lo * EPSILON;

    // On carry the wrapped sum is 2^64 too small; add EPSILON back.
    let (t2, carry) = t0.overflowing_add(t1);
    let t2 = if carry { t2.wrapping_add(EPSILON) } else { t2 };

    // t2 < 2^64 and 2^64 - MODULUS = EPSILON, so one conditional subtraction is
    // always sufficient to land in [0, MODULUS).
    if t2 >= MODULUS {
        t2 - MODULUS
    } else {
        t2
    }
}
