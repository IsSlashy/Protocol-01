//! The formulas against the worked examples their papers print.
//!
//! A formula typed wrong (an exponent 5 for 7, a 2 for a 3, rho for sqrt(rho))
//! moves these by bits, not by rounding. The tolerances are the papers' own
//! printed precision.

use p01_security_levels::calc::{self, Regime};
use p01_security_levels::params::{self, Sampler};

/// Haböck, "A summary on the FRI low degree test", eprint 2022/1216, version
/// of 2024-12-17, §3.5.1, first example: L = 300 polynomials, |F| = 2^128,
/// rho = 2^-5, |D0| = 2^12 / rho, m = 3, reductions {2^4, 2^3}. The paper
/// prints eps_C ~ 2^-67.21, and eps_Q ~ 2^-68.33 for the s = 30 of its table
/// (its prose says 29, which gives 2^-66.05; the table row "5 3 30" is the
/// one that matches the printed 2^-68.33).
#[test]
fn haboeck_2022_1216_example_goldilocks_squared() {
    let rho = 2f64.powi(-5);
    let d0 = 2f64.powi(17);
    let log2_eps_c = calc::log2_batched_fri_commit_error(300.0, 3, rho, d0, 16.0 + 8.0, 128.0);
    assert!(
        (log2_eps_c - (-67.21)).abs() < 0.01,
        "Haböck §3.5.1 prints eps_C ~ 2^-67.21, the calculator gives 2^{log2_eps_c:.3}"
    );
    let log2_eps_q = calc::log2_johnson_query_error(rho, 3, 30);
    assert!(
        (log2_eps_q - (-68.33)).abs() < 0.01,
        "Haböck §3.5.1 prints eps_Q ~ 2^-68.33 at s = 30, the calculator gives 2^{log2_eps_q:.3}"
    );
}

/// Same section, second example: |F| = 2^192, rho = 2^-6, |D0| = 2^18,
/// m = 1427, printed eps_C ~ 2^-67.00. The paper does not print that
/// example's reductions; the second term of eq. (7) is below 2^-150 for any
/// sum of arities up to |D0|, so it cannot move the printed figure.
#[test]
fn haboeck_2022_1216_example_goldilocks_cubed() {
    let log2_eps_c =
        calc::log2_batched_fri_commit_error(300.0, 1427, 2f64.powi(-6), 2f64.powi(18), 32.0, 192.0);
    assert!(
        (log2_eps_c - (-67.00)).abs() < 0.02,
        "Haböck §3.5.1 prints eps_C ~ 2^-67.00, the calculator gives 2^{log2_eps_c:.3}"
    );
}

/// BCIKS20 (eprint 2020/654), Theorem 8.3's numerical example: q >= 2^256,
/// n = 2^20, rho = 2^-4, m = 2^11 - 1, two functions (the theorem's
/// `1 / (2 rho^{3/2})` is eq. (7)'s `(L - 1/2) / 3` at L = 2). The paper
/// bounds eps_C below 2^-133 and alpha^65 below 2^-129.97.
#[test]
fn bciks20_theorem_8_3_numerical_example() {
    let m = (1u32 << 11) - 1;
    let rho = 2f64.powi(-4);
    let n = 2f64.powi(20);
    // The example bounds the sum of reduction factors by n.
    let log2_eps_c = calc::log2_batched_fri_commit_error(2.0, m, rho, n, n, 256.0);
    assert!(log2_eps_c < -133.0, "BCIKS20 bounds eps_C below 2^-133, got 2^{log2_eps_c:.3}");
    assert!(log2_eps_c > -135.0, "eps_C should sit just under 2^-133, got 2^{log2_eps_c:.3}");
    let log2_eps_q = calc::log2_johnson_query_error(rho, m, 65);
    assert!(
        log2_eps_q < -129.97 && log2_eps_q > -129.99,
        "BCIKS20 prints alpha^65 < 2^-129.97 (0.2500665^65), got 2^{log2_eps_q:.4}"
    );
}

/// The two helpers above are the formulas the published Johnson (BCIKS20)
/// figures are computed with, not a copy of them. At any m, the batching and
/// fold terms of `evaluate_at_m` add up to eq. (7) plus the one value gamma = 0,
/// and the query term is `log2_johnson_query_error` at rho+ plus the grinding.
/// Round 1's verifier found the published figures coming from two inline
/// copies of eq. (7) that these tests never reached: an exponent 7 -> 5 there
/// left the three tests above green.
#[test]
fn the_published_johnson_figures_go_through_these_formulas() {
    let c7 = params::v1_circuits().into_iter().find(|p| p.label == "C7").expect("C7 is in compact_proof.rs");
    for p in std::iter::once(c7).chain(params::v2_profiles()) {
        for m in [3u32, 7, 56, 492] {
            let r = calc::evaluate_at_m(&p, Regime::JohnsonBciks20, Sampler::Uniform, m);
            let prob = |group: &str| r.terms.iter().filter(|t| t.group == group).map(|t| t.prob).sum::<f64>();
            let log2_field = p.log2_field();
            let sum_arities = (p.fri_folding_arity as u32 * p.folds()) as f64;
            let eq7 = calc::log2_batched_fri_commit_error(
                p.batched_functions() as f64,
                m,
                p.rho(),
                p.lde_size as f64,
                sum_arities,
                log2_field,
            );
            let want = eq7.exp2() + (-log2_field).exp2();
            let got = prob("FRI batching") + prob("FRI folds");
            assert!(
                ((got - want) / want).abs() < 1e-9,
                "{} m={m}: batching + folds {got:e}, eq. (7) + 1/|F| {want:e}",
                p.label
            );
            let want_q = -calc::log2_johnson_query_error(p.rho_plus(), m, p.num_queries as u32) + p.grinding_bits as f64;
            let got_q = r.group_bits("FRI queries + grinding").expect("a query term");
            assert!((got_q - want_q).abs() < 1e-9, "{} m={m}: query term {got_q:.6}, helper {want_q:.6}", p.label);
        }
    }
}
