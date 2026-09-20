//! v2 candidate profiles: well-formed, and where they stand against the
//! Phase 3 exit criterion of the master plan ("calculateur >= 100 bits Johnson
//! (théorème) pour C6v2 et C7v2").

use p01_security_levels::calc::{self, Regime};
use p01_security_levels::params::{self, Generation, Sampler};

fn profile(label: &str) -> params::StarkParams {
    params::v2_profiles().into_iter().find(|p| p.label == label).unwrap_or_else(|| panic!("no profile {label}"))
}

#[test]
fn the_v2_profiles_are_well_formed() {
    let profiles = params::v2_profiles();
    assert_eq!(profiles.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), ["Q", "R", "R-128"]);
    for p in &profiles {
        assert_eq!(p.generation, Generation::V2Candidate);
        assert_eq!(p.sampler, Sampler::Uniform, "v2 draws challenges by rejection sampling");
        assert!(p.lde_size.is_power_of_two() && p.fri_final_poly_size.is_power_of_two());
        assert!(p.fri_final_poly_degree_bound >= 1 && p.fri_final_poly_degree_bound < p.fri_final_poly_size);
        // The FRI rate the verifier would enforce is the trace rate.
        assert_eq!(p.fri_final_poly_degree_bound * p.blowup(), p.fri_final_poly_size, "{}", p.label);
        assert!((p.rho() - p.trace_length as f64 / p.lde_size as f64).abs() < 1e-15);
        assert_eq!(p.lde_size >> p.folds(), p.fri_final_poly_size);
        assert!(p.ext_degree >= 2, "v2 draws its challenges in an extension field");
    }
}

/// The master plan's Phase 3 exit: >= 100 bits in the Johnson (theorem)
/// regime for C6v2 and C7v2. R and R-128 meet it under BCIKS20, the regime
/// the public headline uses.
#[test]
fn profiles_r_and_r128_meet_the_phase3_exit_criterion() {
    for label in ["R", "R-128"] {
        let p = profile(label);
        let j = calc::evaluate(&p, Regime::JohnsonBciks20, p.sampler);
        assert!(j.bits >= 100.0, "{label}: Johnson (BCIKS20) {:.2} < 100", j.bits);
    }
}

/// Q does not: its quadratic extension leaves the BCIKS20 commit term, which
/// grows with |D0|^2 / |F|, in the way.
#[test]
fn profile_q_falls_short_of_the_exit_criterion() {
    let p = profile("Q");
    let j = calc::evaluate(&p, Regime::JohnsonBciks20, p.sampler);
    assert!(j.bits < 100.0, "Q: Johnson (BCIKS20) {:.2}", j.bits);
}

/// DESIGN-V2 §1's table quotes unique decoding ~49 / ~50 / ~61 and the
/// conjecture ~110 / ~173 / 173 for Q / R / R-128. The calculator must land
/// within a bit of those (the design derived them by hand).
#[test]
fn the_design_estimates_for_unique_decoding_and_the_conjecture_hold() {
    for (label, ud_est, conj_est) in [("Q", 49.0, 110.0), ("R", 50.0, 173.0), ("R-128", 61.0, 173.0)] {
        let p = profile(label);
        let ud = calc::evaluate(&p, Regime::UniqueDecoding, p.sampler).bits;
        let conj = calc::evaluate(&p, Regime::Conjectured, p.sampler).bits;
        assert!((ud - ud_est).abs() <= 1.0, "{label}: unique decoding {ud:.2} vs design ~{ud_est}");
        assert!((conj - conj_est).abs() <= 1.0, "{label}: conjectured {conj:.2} vs design ~{conj_est}");
    }
}
