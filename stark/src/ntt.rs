//! [WP0d 2026-09-19] Radix-2 NTT evaluation on a multiplicative coset.
//!
//! The compact prover commits every column on the coset `h * <omega>` of the
//! LDE subgroup (`compact::lde_coset_shift`, B7). Before WP0d it built each
//! such column by evaluating the column's polynomial at every coset point one
//! point at a time, `n * lde_size` multiplications per column. This module
//! evaluates the same polynomial on the same points in the same order with one
//! radix-2 transform, `(lde_size / 2) * log2(lde_size)` butterflies.
//!
//! # Why the output is the same, bit for bit
//!
//! `f(h * omega^i) = sum_j (c_j * h^j) * omega^(i*j)`, so scaling coefficient
//! `j` by `h^j` and taking the ordinary transform of the scaled vector over
//! `<omega>` gives exactly the coset evaluation. Goldilocks arithmetic is exact
//! (no rounding, no approximation), so any correct way of computing that sum
//! returns the same field element, and the canonical `as_int()` every
//! serialisation goes through is then the same integer. The order is natural
//! (`out[i]` is the point `h * omega^i`), which is the order the per-point loop
//! wrote.
//!
//! A coefficient vector longer than the domain is folded (`j mod size`), which
//! is still exact because `omega^size = 1`. The prover never hands one in (its
//! columns have at most `n <= lde_size` coefficients), but the per-point loop
//! accepted it, so this does too rather than silently dropping terms.
//!
//! Tests: `tests` below (differential against the defining sum at every
//! power-of-two size up to 2^12), `compact::wp0d_ntt_lde` (the rewritten
//! builders against the pre-WP0d bodies) and `stark/tests/wp0d_ntt_lde.rs`
//! (byte-identical proofs on all eight circuits plus legacy C0).

use winterfell::math::fields::f64::BaseElement;
use winterfell::math::FieldElement;

/// A coset `shift * <omega>` of the multiplicative subgroup of order `size`,
/// with the transform's twiddle factors computed once so every column
/// evaluated on it shares them.
pub(crate) struct CosetDomain {
    size: usize,
    shift: BaseElement,
    /// `omega^k` for `k = 0 .. size/2`.
    twiddles: Vec<BaseElement>,
}

impl CosetDomain {
    /// `omega` must have multiplicative order EXACTLY `size` (a power of two),
    /// and `shift` must be non-zero. Both are checked: a wrong-order generator
    /// or a zero shift does not fail loudly downstream, it evaluates a
    /// different polynomial.
    pub(crate) fn new(size: usize, omega: BaseElement, shift: BaseElement) -> Self {
        assert!(size.is_power_of_two(), "NTT domain size {size} is not a power of two");
        assert_ne!(shift, BaseElement::ZERO, "a zero shift collapses the coset to a point");
        assert_eq!(
            omega.exp(size as u64),
            BaseElement::ONE,
            "omega^{size} != 1: omega does not generate a subgroup of order {size}",
        );
        if size > 1 {
            assert_ne!(
                omega.exp((size / 2) as u64),
                BaseElement::ONE,
                "omega^{} == 1: omega's order is smaller than {size}",
                size / 2,
            );
        }
        let mut twiddles = Vec::with_capacity(size / 2);
        let mut w = BaseElement::ONE;
        for _ in 0..size / 2 {
            twiddles.push(w);
            w *= omega;
        }
        CosetDomain { size, shift, twiddles }
    }

    /// `out[i] = sum_j coeffs[j] * (shift * omega^i)^j` for `i = 0..size`, in
    /// natural order.
    pub(crate) fn evaluate(&self, coeffs: &[BaseElement]) -> Vec<BaseElement> {
        let n = self.size;
        let mut a = vec![BaseElement::ZERO; n];
        let mut p = BaseElement::ONE;
        for (j, &c) in coeffs.iter().enumerate() {
            a[j & (n - 1)] += c * p;
            p *= self.shift;
        }
        self.transform_in_place(&mut a);
        a
    }

    /// Iterative Cooley-Tukey, decimation in time: bit-reverse the input, then
    /// `log2(size)` rounds of butterflies. `a[i] <- sum_j a[j] * omega^(i*j)`.
    fn transform_in_place(&self, a: &mut [BaseElement]) {
        let n = a.len();
        debug_assert_eq!(n, self.size);
        if n <= 1 {
            return;
        }
        let log_n = n.trailing_zeros();
        for i in 0..n {
            let j = i.reverse_bits() >> (usize::BITS - log_n);
            if i < j {
                a.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            // A butterfly of span `len` needs the len-th root omega^(n/len).
            let stride = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..half {
                    let t = self.twiddles[k * stride] * a[start + k + half];
                    let u = a[start + k];
                    a[start + k] = u + t;
                    a[start + k + half] = u - t;
                }
            }
            len <<= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A generator of the order-`size` subgroup, derived here rather than
    /// borrowed from `compact.rs` so a shared mistake cannot hide.
    fn root_of_unity(size: usize) -> BaseElement {
        assert!(size.is_power_of_two() && size <= 1 << 32);
        // 7 generates the multiplicative group of Goldilocks, so
        // 7^((p-1)/size) has order exactly `size`.
        let p_minus_1: u64 = 0xFFFF_FFFF_0000_0000;
        BaseElement::new(7).exp(p_minus_1 / size as u64)
    }

    fn felts(seed: u64, len: usize) -> Vec<BaseElement> {
        let mut z = seed | 1;
        (0..len)
            .map(|_| {
                z ^= z << 13;
                z ^= z >> 7;
                z ^= z << 17;
                BaseElement::new(z)
            })
            .collect()
    }

    /// The definition, spelled out: every point, every power, no shortcut.
    fn naive(coeffs: &[BaseElement], omega: BaseElement, shift: BaseElement, size: usize) -> Vec<BaseElement> {
        let mut out = Vec::with_capacity(size);
        let mut x = shift;
        for _ in 0..size {
            let mut acc = BaseElement::ZERO;
            let mut xp = BaseElement::ONE;
            for &c in coeffs {
                acc += c * xp;
                xp *= x;
            }
            out.push(acc);
            x *= omega;
        }
        out
    }

    /// Every power-of-two size up to 2^12, every shape of coefficient vector
    /// (empty, one term, shorter than the domain, exactly the domain, and
    /// LONGER than the domain, which the prover never produces but which must
    /// still wrap), on the unshifted subgroup, on the prover's coset and on a
    /// random coset.
    #[test]
    fn coset_evaluate_matches_the_naive_sum_at_every_size() {
        let shifts = [BaseElement::ONE, BaseElement::new(7), BaseElement::new(0x0123_4567_89AB_CDEF)];
        let mut cases = 0usize;
        for log in 0..=12u32 {
            let size = 1usize << log;
            let omega = root_of_unity(size);
            let lens: Vec<usize> = if size <= 1024 {
                vec![0, 1, 2, size / 2, size.saturating_sub(1), size, size + 1, 2 * size + 3]
            } else {
                // The naive sum is size * len; keep the big sizes to the
                // shapes the prover actually produces (n = size / 16).
                vec![1, size / 16, size / 16 + 1]
            };
            for (s, &shift) in shifts.iter().enumerate() {
                let dom = CosetDomain::new(size, omega, shift);
                for &len in &lens {
                    let coeffs = felts(((log as u64) << 40) ^ ((s as u64) << 32) ^ len as u64, len);
                    assert_eq!(
                        dom.evaluate(&coeffs),
                        naive(&coeffs, omega, shift, size),
                        "size {size}, {len} coefficients, shift #{s}",
                    );
                    cases += 1;
                }
            }
        }
        assert_eq!(cases, 11 * 3 * 8 + 2 * 3 * 3, "the case grid shrank");
    }

    /// Non-vacuity of the check above: the evaluation is not a constant and
    /// does depend on the shift, so "matches the naive sum" cannot be two
    /// zero vectors agreeing.
    #[test]
    fn the_evaluation_moves_with_the_coefficients_and_the_shift() {
        let size = 64;
        let omega = root_of_unity(size);
        let c = felts(0xFEED, 16);
        let on_subgroup = CosetDomain::new(size, omega, BaseElement::ONE).evaluate(&c);
        let on_coset = CosetDomain::new(size, omega, BaseElement::new(7)).evaluate(&c);
        assert_ne!(on_subgroup, on_coset, "the shift did not move the evaluation");
        assert_ne!(on_subgroup, vec![BaseElement::ZERO; size], "evaluation is identically zero");
        // f(1) on the subgroup is the plain sum of the coefficients.
        let sum = c.iter().fold(BaseElement::ZERO, |a, &b| a + b);
        assert_eq!(on_subgroup[0], sum, "out[0] on the subgroup is f(1)");
    }

    #[test]
    #[should_panic(expected = "omega does not generate a subgroup of order")]
    fn an_omega_of_larger_order_is_refused() {
        // order 16, claimed 8: omega^8 = -1.
        CosetDomain::new(8, root_of_unity(16), BaseElement::ONE);
    }

    #[test]
    #[should_panic(expected = "omega's order is smaller than")]
    fn an_omega_of_smaller_order_is_refused() {
        // order 4, claimed 8: omega^4 = 1.
        CosetDomain::new(8, root_of_unity(4), BaseElement::ONE);
    }

    #[test]
    #[should_panic(expected = "a zero shift collapses the coset")]
    fn a_zero_shift_is_refused() {
        CosetDomain::new(8, root_of_unity(8), BaseElement::ZERO);
    }
}
