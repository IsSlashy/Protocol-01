//! Does additive `Z_H·r` trace masking fit the DEPLOYED DEEP-ALI verifier?
//!
//! Companion to `zk_feasibility.rs` (same self-contained Goldilocks arithmetic,
//! same "measure, don't assume" contract). That file answered the hiding half:
//! blinding with r ≥ 46 free coefficients defeats Lagrange recovery. THIS file
//! answers the completeness half against the verifier that is actually on
//! devnet, and the answer is that two pinned constants reject every honestly
//! masked proof:
//!
//!   * `CircuitConfig.fri_final_poly_degree_bound = 1` on all seven circuits
//!     (branch `b7-drop-aligned-checks`, compact_proof.rs — "[B2] MEASURED
//!     post-segmentation"), enforced once per proof by
//!     `check_final_poly_degree_bound` before the FRI query loop. The bound is
//!     the statement `deg(D) <= trace_length - 2`, which is only true while
//!     every trace column has degree < n. Masking makes deg(T') = n + r - 1,
//!     so the DEEP composition's trace part has degree n + r - 3 and its
//!     9-fold fold-down has degree 1, not 0 → `FriFinalPolyDegreeTooHigh`.
//!
//!   * `quotient_segments = 8` = ceil((8n-7)/n), pinned in the same config and
//!     asserted in BOTH directions by the prover's `segment_quotient_poly`.
//!     The degree-7 Poseidon S-box multiplies the mask's degree contribution
//!     by 7: deg(Q') grows by 7r = 322, past the 8×512 coefficient budget →
//!     the masked quotient needs a 9th segment the wire format cannot carry.
//!
//! Everything below is either computed from first principles and validated
//! in-file (the fold rule, the coset non-vanishing, the ×7 degree growth), or
//! imported as a named measurement with its provenance stated (the 4088).
//!
//! The current branch's working-tree verifier (pre-B1) has NO terminal degree
//! bound and NO coset — against it, honest masked proofs would pass, but it is
//! not the deployed artifact and its FRI enforces no degree at all. The
//! deployed program is `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`
//! (elf sha256 3ba71cdd…, attested 2026-08-04, generation b2+coset), built
//! from `b7-drop-aligned-checks`.
//!
//! Run: `cargo test -p p01-stark --release --test masking_deep_degree_gate -- --nocapture`

// ---------------------------------------------------------------------------
// Goldilocks field, u128-backed. Identical idiom to zk_feasibility.rs.
// ---------------------------------------------------------------------------

const P: u128 = 0xFFFF_FFFF_0000_0001;

#[inline]
fn fadd(a: u64, b: u64) -> u64 {
    ((a as u128 + b as u128) % P) as u64
}
#[inline]
fn fsub(a: u64, b: u64) -> u64 {
    ((a as u128 + P - b as u128) % P) as u64
}
#[inline]
fn fmul(a: u64, b: u64) -> u64 {
    ((a as u128 * b as u128) % P) as u64
}
fn fpow(mut a: u64, mut e: u64) -> u64 {
    let mut r: u64 = 1;
    while e > 0 {
        if e & 1 == 1 {
            r = fmul(r, a);
        }
        a = fmul(a, a);
        e >>= 1;
    }
    r
}
fn finv(a: u64) -> u64 {
    fpow(a, 0xFFFF_FFFE_FFFF_FFFF)
}

// ---------------------------------------------------------------------------
// The deployed constants this file measures AGAINST. They live on the
// b7-drop-aligned-checks branch, not in this tree — imported by value with
// their source pinned, exactly like zk_feasibility.rs pins GEN_512.
// ---------------------------------------------------------------------------

/// Trace length of the C3/C5/C6/C7-envelope circuits.
const N: usize = 512;
/// LDE size at blowup 16.
const LDE: usize = 8192;
/// Deployed LDE coset shift h (b7 verify.rs `LDE_COSET_SHIFT`).
const H: u64 = 7;
/// folds = log2(LDE / fri_final_poly_size) = log2(8192/16).
const NUM_FOLDS: usize = 9;
/// b7 compact_proof.rs, every circuit: "[B2] MEASURED post-segmentation".
const DEPLOYED_FINAL_POLY_DEGREE_BOUND: usize = 1;
/// b7 compact_proof.rs: quotient_segments = ceil((8n-7)/n) = 8.
const DEPLOYED_QUOTIENT_SEGMENTS: usize = 8;
/// Measured quotient degree on the 512-row circuits, LDE 8192 — instrumented
/// `divide_by_vanishing` reading, 2026-07-28 ("[B2] circuit=c6-style q_deg=4088").
/// The B2 segmentation was sized from this exact number.
const MEASURED_UNMASKED_Q_DEG: usize = 4088;
/// Poseidon S-box exponent: the AIR's maximal degree in the trace variables.
const SBOX_DEGREE: usize = 7;
/// The ZK gate's mask budget: 2 openings × 22 queries + 2 OOD points.
const MASK_COEFFS_R: usize = 46;

/// LDE generator for size 8192 (verify.rs `GENERATOR_8192`, both branches).
const GEN_8192: u64 = 0x1544_EF23_35D1_7997;

// ---------------------------------------------------------------------------
// Polynomial helpers (dense coefficient form, ascending).
// ---------------------------------------------------------------------------

fn poly_eval(coeffs: &[u64], x: u64) -> u64 {
    let mut acc = 0u64;
    for &c in coeffs.iter().rev() {
        acc = fadd(fmul(acc, x), c);
    }
    acc
}

fn poly_deg(coeffs: &[u64]) -> usize {
    coeffs.iter().rposition(|&c| c != 0).unwrap_or(0)
}

/// One FRI fold in coefficient space: f(x) = fe(x²) + x·fo(x²) ⇒ fe + α·fo.
fn fold_coeffs(coeffs: &[u64], alpha: u64) -> Vec<u64> {
    let mut out = Vec::with_capacity(coeffs.len().div_ceil(2));
    for pair in coeffs.chunks(2) {
        let even = pair[0];
        let odd = if pair.len() > 1 { pair[1] } else { 0 };
        out.push(fadd(even, fmul(alpha, odd)));
    }
    out
}

/// Deterministic filler that is not secretly low-degree.
fn pseudo_random(seed: u64, i: u64) -> u64 {
    // splitmix64, reduced into the field.
    let mut z = seed.wrapping_add(i.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    (z ^ (z >> 31)) % (P as u64)
}

// ---------------------------------------------------------------------------
// Guard: the coefficient-space fold used below IS the verifier's
// evaluation-space fold `(f(y)+f(-y))/2 + α·(f(y)-f(-y))/(2y)`.
// If this fails, the fold-down degrees printed later are meaningless.
// ---------------------------------------------------------------------------
fn self_check_fold_rule() {
    let coeffs: Vec<u64> = (0..37).map(|i| pseudo_random(0xF01D, i)).collect();
    let alpha = pseudo_random(0xA1FA, 1);
    let folded = fold_coeffs(&coeffs, alpha);
    for t in 1..6u64 {
        let y = fpow(H, t); // arbitrary nonzero points, coset-flavoured
        let f_y = poly_eval(&coeffs, y);
        let f_neg_y = poly_eval(&coeffs, fsub(0, y));
        let even = fmul(fadd(f_y, f_neg_y), finv(2));
        let odd = fmul(fsub(f_y, f_neg_y), finv(fmul(2, y)));
        let expected = fadd(even, fmul(alpha, odd));
        assert_eq!(
            poly_eval(&folded, fmul(y, y)),
            expected,
            "coefficient fold disagrees with the verifier's evaluation fold"
        );
    }
}

// ---------------------------------------------------------------------------
// FACT 1 — the coset is NECESSARY: on the raw subgroup, Z_H vanishes at every
// trace-aligned LDE position, so the mask contributes exactly zero there and
// the opening is the raw witness row. On the deployed h·⟨g⟩ coset, Z_H
// vanishes NOWHERE, so every opened point carries mask entropy.
// ---------------------------------------------------------------------------
#[test]
fn coset_is_necessary_z_h_vanishes_on_aligned_subgroup_points_only() {
    assert_eq!(fpow(GEN_8192, LDE as u64), 1, "GEN_8192 is not an 8192nd root");
    assert_ne!(fpow(GEN_8192, (LDE / 2) as u64), 1, "GEN_8192 not primitive");

    // Z_H(x) = x^512 - 1 on x = g^pos: x^512 = (g^512)^pos cycles with period 16.
    let g_512 = fpow(GEN_8192, N as u64);
    let mut aligned_zero = 0usize;
    for pos in 0..16u64 {
        let zh = fsub(fpow(g_512, pos), 1);
        if pos == 0 {
            assert_eq!(zh, 0, "position 0 IS a trace point; Z_H must vanish");
        }
        if zh == 0 {
            aligned_zero += 1;
        }
    }
    // Exactly the pos ≡ 0 (mod 16) residue class: 1 of the 16 classes, i.e.
    // 512 of 8192 positions — the 1-in-16 raw-row leak the working-tree
    // verifier still has (~76% of 22-query proofs hit at least one).
    assert_eq!(aligned_zero, 1, "expected exactly one vanishing residue class");

    // On the deployed coset x = h·g^pos: x^512 = h^512·(g^512)^pos. h = 7 has
    // full multiplicative order, so h^512 is not a 16th root of unity and
    // Z_H(x) ≠ 0 for every one of the 16 residue classes — no opened point is
    // ever a raw trace row.
    let h_512 = fpow(H, N as u64);
    for pos in 0..16u64 {
        let zh = fsub(fmul(h_512, fpow(g_512, pos)), 1);
        assert_ne!(zh, 0, "Z_H vanishes on the coset at residue class {pos}");
    }
    println!("coset necessity: subgroup leaks 1/16 of positions raw; coset leaks none.");
}

// ---------------------------------------------------------------------------
// FACT 2 — the deployed terminal degree bound REJECTS an honestly masked
// proof. deg(T') = N + R - 1, the DEEP trace part has degree N + R - 3, and
// its real 9-fold fold-down has degree 1 while the deployed bound admits only
// degree 0. This is done with an actual polynomial and actual folds, not a
// degree formula.
// ---------------------------------------------------------------------------
#[test]
fn masked_deep_composition_fails_deployed_terminal_degree_bound() {
    self_check_fold_rule();

    // The DEEP composition's trace part for a masked column: degree N + R - 3.
    // (S(x) - ℓ(x)) / ((x-z)(x-zg)) with deg(S) = deg(T') = N + R - 1. We build
    // a dense polynomial of exactly that degree; only the degree matters to the
    // fold-down, and the fold is linear, so one worst-degree term suffices.
    let deep_deg = N + MASK_COEFFS_R - 3; // 555
    let mut d: Vec<u64> = (0..=deep_deg as u64).map(|i| pseudo_random(0xD_EE_9, i)).collect();
    if *d.last().unwrap() == 0 {
        *d.last_mut().unwrap() = 1;
    }
    assert_eq!(poly_deg(&d), deep_deg);

    // Fold 9 times with pseudo-random challenges, exactly the verifier's chain.
    let mut cur = d;
    for i in 0..NUM_FOLDS {
        cur = fold_coeffs(&cur, pseudo_random(0xA1FA_0000, i as u64));
    }
    let final_deg = poly_deg(&cur);
    println!(
        "masked DEEP composition: deg {} → fold-down deg {} (deployed bound admits < {})",
        deep_deg, final_deg, DEPLOYED_FINAL_POLY_DEGREE_BOUND
    );

    // The honest prover publishes the true interpolant of the final layer —
    // this polynomial. Coefficient index 1 is nonzero, the deployed
    // `check_final_poly_degree_bound(_, 1)` returns FriFinalPolyDegreeTooHigh.
    assert!(
        final_deg >= DEPLOYED_FINAL_POLY_DEGREE_BOUND,
        "expected the masked fold-down to exceed the deployed bound — if this \
         fails, the completeness argument against masking is WRONG and the \
         plan can proceed without touching the verifier"
    );

    // Control: the unmasked degree budget (deg(D) = N - 2) folds down to a
    // constant, which is exactly why the bound could be pinned at 1.
    let mut ctrl: Vec<u64> = (0..=(N - 2) as u64).map(|i| pseudo_random(0xC7_01, i)).collect();
    if *ctrl.last().unwrap() == 0 {
        *ctrl.last_mut().unwrap() = 1;
    }
    for i in 0..NUM_FOLDS {
        ctrl = fold_coeffs(&ctrl, pseudo_random(0xA1FA_1111, i as u64));
    }
    assert_eq!(poly_deg(&ctrl), 0, "unmasked deg N-2 must fold to a constant");

    // The smallest bound that accepts the masked fold-down is 2 — the concrete
    // soundness price: rho 1/16 → 2/16, i.e. 4 → 3 bits per query.
    assert!(final_deg < 2, "bound 2 should be sufficient for r = 46");
}

// ---------------------------------------------------------------------------
// FACT 3 — the ×SBOX_DEGREE growth is real, measured on an actual power-7
// composition, and it overflows the deployed 8-segment quotient budget.
// ---------------------------------------------------------------------------
#[test]
fn masked_quotient_overflows_deployed_segment_budget() {
    // Miniature with the real structure: n = 32, mask r = 6. t' = t + Z_H·m.
    // c' = (t')^7 must gain exactly SBOX_DEGREE · r over c = t^7.
    let n = 32usize;
    let r = 6usize;
    let mut t: Vec<u64> = (0..n as u64).map(|i| pseudo_random(0x7ACE, i)).collect();
    if *t.last().unwrap() == 0 {
        *t.last_mut().unwrap() = 1;
    }
    // Z_H·m: coefficients of m shifted up by n, minus m (Z_H = x^n - 1).
    let m: Vec<u64> = (0..r as u64).map(|i| pseudo_random(0x3A5C, i)).collect();
    let mut t_masked = vec![0u64; n + r];
    t_masked[..n].copy_from_slice(&t);
    for (i, &mi) in m.iter().enumerate() {
        t_masked[n + i] = fadd(t_masked[n + i], mi);
        t_masked[i] = fsub(t_masked[i], mi);
    }
    assert_eq!(poly_deg(&t_masked), n + r - 1);

    // Dense multiply — n is tiny, O(k²) is fine.
    fn poly_mul(a: &[u64], b: &[u64]) -> Vec<u64> {
        let mut out = vec![0u64; a.len() + b.len() - 1];
        for (i, &ai) in a.iter().enumerate() {
            if ai == 0 {
                continue;
            }
            for (j, &bj) in b.iter().enumerate() {
                out[i + j] = fadd(out[i + j], fmul(ai, bj));
            }
        }
        out
    }
    let mut pow7 = t.clone();
    let mut pow7_masked = t_masked.clone();
    for _ in 1..SBOX_DEGREE {
        pow7 = poly_mul(&pow7, &t);
        pow7_masked = poly_mul(&pow7_masked, &t_masked);
    }
    let growth = poly_deg(&pow7_masked) - poly_deg(&pow7);
    assert_eq!(
        growth,
        SBOX_DEGREE * r,
        "S-box degree growth is not ×{SBOX_DEGREE} — the segment arithmetic below is wrong"
    );
    println!("measured S-box masking growth on n={n}, r={r}: +{growth} = {SBOX_DEGREE}·{r}");

    // Scale to the deployed circuits: base = the MEASURED 4088, growth = 7·46.
    let masked_q_deg = MEASURED_UNMASKED_Q_DEG + SBOX_DEGREE * MASK_COEFFS_R; // 4410
    let budget = DEPLOYED_QUOTIENT_SEGMENTS * N - 1; // 4095
    println!(
        "masked quotient degree {} vs deployed segment budget {} ({} segments × {})",
        masked_q_deg, budget, DEPLOYED_QUOTIENT_SEGMENTS, N
    );
    assert!(
        masked_q_deg > budget,
        "masked quotient fits the deployed segments — the wire-format objection is WRONG"
    );
    // And the margin is not close: the conclusion only flips if today's real
    // quotient degree were ≤ 3773, contradicting the 4088 measurement by 315.
    assert!(MEASURED_UNMASKED_Q_DEG > budget - SBOX_DEGREE * MASK_COEFFS_R + 300);
    // A 9th segment carries it: ceil((4410+1)/512) = 9.
    assert_eq!((masked_q_deg + 1).div_ceil(N), DEPLOYED_QUOTIENT_SEGMENTS + 1);
}
