//! v1: the calculator against the figures the repository already pins, and the
//! assumptions it makes about the deployed verifier.

use std::fs;

use p01_security_levels::calc::{self, Regime};
use p01_security_levels::params::{self, Sampler, StarkParams};
use p01_security_levels::repo_root;

fn v1() -> Vec<StarkParams> {
    params::v1_circuits()
}

fn read_repo(rel: &str) -> String {
    let path = repo_root().join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
}

/// `const NAME: [u32; N] = [a, b, ...];` out of a Rust source file.
fn pinned_array(src: &str, name: &str) -> Vec<u32> {
    let decl = format!("const {name}: [u32; ");
    let start = src.find(&decl).unwrap_or_else(|| panic!("{name} is not declared in the file"));
    let rest = &src[start..];
    let open = rest.find("= [").expect("array literal") + 3;
    let close = rest[open..].find(']').expect("closing bracket") + open;
    rest[open..close]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u32>().unwrap_or_else(|e| panic!("{name}: {s:?} is not a u32: {e}")))
        .collect()
}

/// The figures named in the WP1 spec: C7 = 42 unique-decoding, 47 conjectured.
/// Those are the figures of the model the repository pins them in: challenges
/// uniform over F_p, and `floor(min(query term, field floor))`.
#[test]
fn c7_reproduces_the_known_v1_figures() {
    let c7 = v1().into_iter().find(|p| p.label == "C7").expect("C7 is in compact_proof.rs");

    let repo = calc::repo_convention(&c7);
    assert_eq!(calc::floor_bits(repo.unconditional), 42, "repo formula, unique decoding: {repo:?}");
    assert_eq!(calc::floor_bits(repo.conjectured), 47, "repo formula, conjectured: {repo:?}");

    // The union bound over every term, same idealised sampler, same floors.
    let ud = calc::evaluate(&c7, Regime::UniqueDecoding, Sampler::Uniform);
    let conj = calc::evaluate(&c7, Regime::Conjectured, Sampler::Uniform);
    assert_eq!(calc::floor_bits(ud.bits), 42, "union bound, unique decoding: {:.4}", ud.bits);
    assert_eq!(calc::floor_bits(conj.bits), 47, "union bound, conjectured: {:.4}", conj.bits);
}

/// Every entry of the two arrays `b1_deep_binding.rs` pins, however many
/// circuits they cover when this runs (7 before WP0a, 8 after).
#[test]
fn the_idealised_model_reproduces_every_pinned_v1_figure() {
    let src = read_repo("programs/p01_stark_verifier/tests/b1_deep_binding.rs");
    let conj = pinned_array(&src, "B2_CONJECTURED_FORGERY_BITS");
    let uncond = pinned_array(&src, "B2_UNCONDITIONAL_FORGERY_BITS");
    assert_eq!(conj.len(), uncond.len());
    assert!(conj.len() >= 7, "b1 pins at least C0..C6, got {}", conj.len());

    let circuits = v1();
    for (id, (&pin_conj, &pin_uncond)) in conj.iter().zip(&uncond).enumerate() {
        let p = &circuits[id];
        assert_eq!(p.label, format!("C{id}"));
        let repo = calc::repo_convention(p);
        assert_eq!(calc::floor_bits(repo.conjectured), pin_conj, "C{id} conjectured, repo formula");
        assert_eq!(calc::floor_bits(repo.unconditional), pin_uncond, "C{id} unconditional, repo formula");

        let ud = calc::evaluate(p, Regime::UniqueDecoding, Sampler::Uniform).bits;
        let cj = calc::evaluate(p, Regime::Conjectured, Sampler::Uniform).bits;
        assert_eq!(calc::floor_bits(ud), pin_uncond, "C{id} unique decoding, union bound {ud:.4}");
        assert_eq!(calc::floor_bits(cj), pin_conj, "C{id} conjectured, union bound {cj:.4}");
    }
}

/// The deployed sampler (`u64 mod p`, 0 -> 1) puts up to twice the uniform
/// mass on a challenge value, so every field-bound term can double: at most
/// one bit, and never a gain.
#[test]
fn the_shipped_sampler_costs_between_zero_and_one_bit() {
    for p in v1() {
        for regime in Regime::ALL {
            let ideal = calc::evaluate(&p, regime, Sampler::Uniform).bits;
            let shipped = calc::evaluate(&p, regime, Sampler::U64ModP).bits;
            let loss = ideal - shipped;
            assert!(
                loss > 0.0 && loss <= 1.01,
                "{} {:?}: uniform {ideal:.4}, shipped {shipped:.4}, loss {loss:.4}",
                p.label,
                regime
            );
        }
    }
}

/// The v1 model assumes every challenge is ONE base-field element, drawn as
/// `u64 % p` with 0 mapped to 1. If the verifier changes how it samples, this
/// goes red and the model has to be revisited.
#[test]
fn v1_challenges_are_base_field_elements_drawn_u64_mod_p() {
    let src = read_repo("programs/p01_stark_verifier/src/verify.rs");
    for needle in [
        "fn derive_fri_alpha(state: &[u8; 32]) -> Felt {",
        "fn derive_deep_coeff(base_seed: &[u8; 32]) -> Felt {",
        "let z = u64::from_le_bytes(hash[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;",
        "    ) % GOLDILOCKS_PRIME;\n    if alpha == 0 {\n        alpha = 1;",
        "let mut a = u64::from_le_bytes(h[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;\n    if a == 0 { a = 1; }",
    ] {
        let normalised = src.replace("\r\n", "\n");
        assert!(normalised.contains(needle), "verify.rs no longer contains {needle:?}");
    }
    for p in v1() {
        assert_eq!(p.ext_degree, 1, "{}", p.label);
        assert_eq!(p.sampler, Sampler::U64ModP, "{}", p.label);
    }
}

/// `CONSTRAINT_BOUND` is an assumption; this shows it cannot matter.
#[test]
fn the_constraint_bound_never_moves_a_figure() {
    for p in v1().into_iter().chain(params::v2_profiles()) {
        let mut wide = p.clone();
        wide.constraint_bound = 1024;
        for regime in Regime::ALL {
            let a = calc::evaluate(&p, regime, p.sampler).bits;
            let b = calc::evaluate(&wide, regime, p.sampler).bits;
            assert!(b <= a, "{} {regime:?}: more constraints cannot help", p.label);
            assert!(a - b < 0.01, "{} {regime:?}: C=64 {a:.4} vs C=1024 {b:.4}", p.label);
        }
    }
}

/// The transition-constraint counts the AIRs declare stay well under the bound.
#[test]
fn the_v1_transition_constraint_counts_fit_the_bound() {
    let dir = repo_root().join("stark/src/air");
    let mut counts = Vec::new();
    for entry in fs::read_dir(&dir).expect("stark/src/air") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let src = fs::read_to_string(&path).expect("air source");
        for line in src.lines() {
            let l = line.trim();
            if l.starts_with("pub const ") && l.contains("_NUM_CONSTRAINTS: usize = ") {
                let n = l.rsplit("= ").next().unwrap().trim_end_matches(';').trim();
                counts.push((l.to_string(), n.parse::<usize>().expect("count")));
            }
        }
    }
    assert!(counts.len() >= 7, "expected the per-circuit counts, found {counts:?}");
    for (decl, n) in &counts {
        assert!(*n * 2 <= params::CONSTRAINT_BOUND, "{decl}: leaves no room for boundary assertions");
    }
}

/// The Johnson regimes pick the best m by exhaustive search over
/// `M_MIN..M_MAX`, where M_MIN = 3 is the smallest m the theorems allow. The
/// best m is a local maximum and stays far from the search's upper edge. It is
/// not always interior: on all eight v1 circuits (both Johnson regimes, both
/// samplers) and on Q under BCIKS20 it is m = 3, the theorems' own lower
/// bound, so only m + 1 is compared there. It is interior for Q under BCHKS25
/// (m = 9), for R (56 and 492) and for R-128 (7 and 46).
#[test]
fn the_optimal_johnson_m_is_inside_the_search_range() {
    assert_eq!(calc::M_MIN, 3, "BCIKS20 Thm 5.1 and Thm 8.3 hold for m >= 3");
    let mut at_lower_bound = std::collections::BTreeSet::new();
    for p in v1().into_iter().chain(params::v2_profiles()) {
        for regime in [Regime::JohnsonBciks20, Regime::JohnsonBchks25] {
            for sampler in [Sampler::Uniform, p.sampler] {
                let r = calc::evaluate(&p, regime, sampler);
                assert!(r.m.is_some(), "{} {regime:?}: a Johnson result carries its m", p.label);
                let m = r.m.unwrap();
                assert!((calc::M_MIN..calc::M_MAX / 2).contains(&m), "{} {regime:?}: m = {m}", p.label);
                if m == calc::M_MIN {
                    at_lower_bound.insert(format!("{} {regime:?} {sampler:?}", p.label));
                }
                // and it is a maximum: the neighbours are not better
                let here = calc::evaluate_at_m(&p, regime, sampler, m).bits;
                assert!((here - r.bits).abs() < 1e-9);
                for other in [m.saturating_sub(1).max(calc::M_MIN), m + 1] {
                    let there = calc::evaluate_at_m(&p, regime, sampler, other).bits;
                    assert!(there <= here + 1e-9, "{} {regime:?}: m={other} beats m={m}", p.label);
                }
            }
        }
    }
    // where the optimum sits at the lower bound: every v1 case, and Q under BCIKS20
    let mut expected = std::collections::BTreeSet::new();
    for p in v1() {
        for regime in [Regime::JohnsonBciks20, Regime::JohnsonBchks25] {
            for sampler in [Sampler::Uniform, Sampler::U64ModP] {
                expected.insert(format!("{} {regime:?} {sampler:?}", p.label));
            }
        }
    }
    expected.insert(format!("Q {:?} {:?}", Regime::JohnsonBciks20, Sampler::Uniform));
    assert_eq!(at_lower_bound, expected, "the optima at m = M_MIN moved; update the doc comment above and the report");
}
