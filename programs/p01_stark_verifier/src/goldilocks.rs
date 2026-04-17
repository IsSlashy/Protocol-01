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
}

/// Reduce a 128-bit product modulo the Goldilocks prime.
/// Uses the identity: 2^64 ≡ 2^32 - 1 (mod p)
#[inline]
fn reduce128(x: u128) -> u64 {
    let low = x as u64;
    let high = (x >> 64) as u64;

    // high * 2^64 ≡ high * (2^32 - 1) mod p
    let (h_low, h_high) = high.overflowing_mul(0xFFFFFFFF); // 2^32 - 1
    // If overflow, we need another reduction step
    let reduced = if h_high {
        // This shouldn't happen for our use case since high < 2^64
        // and 0xFFFFFFFF < 2^32, so product < 2^96 which fits in u128
        // but handle conservatively
        let full = (high as u128) * (0xFFFFFFFF_u128);
        let r = full as u64;
        let carry = (full >> 64) as u64;
        // carry * 2^64 mod p = carry * (2^32 - 1)
        let extra = carry.wrapping_mul(0xFFFFFFFF);
        let (s, c) = r.overflowing_add(extra);
        if c { s.wrapping_sub(MODULUS) } else { s }
    } else {
        h_low
    };

    // low + reduced mod p
    let (sum, carry) = low.overflowing_add(reduced);
    if carry || sum >= MODULUS {
        sum.wrapping_sub(MODULUS)
    } else {
        sum
    }
}
