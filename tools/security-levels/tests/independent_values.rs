//! Every term group of the headline and D1-gate figures, pinned against an
//! independent recomputation.
//!
//! The pins come from `scratchpad/v2-run/logs/WP1-fix1-indep.py` (log:
//! `WP1-fix1-indep.log`), Python, whose formulas are those of the round-1
//! verifier's own script (`verify-WP1-r1/indep_calc.py`), written from what
//! `docs/SECURITY-LEVELS.md` states and not from `calc.rs`. Its totals agree
//! with that script to four decimals.
//!
//! Why this exists: `the_generated_doc_is_current` compares the document with
//! the calculator, so a formula typed wrong in `calc.rs` followed by `--write`
//! passes it. Round 1's verifier did exactly that three ways (eq. (7)'s
//! exponent, its batching factor, the Johnson list size) and the suite stayed
//! green. These pins do not move when the document is regenerated.
//!
//! Tolerance: 0.001 bit (the pins are printed to four decimals). If a circuit
//! shape or a v2 profile changes on purpose, the shape assertions fail before
//! any pin does; re-run the script with the new shape and re-pin.
//!
//! The last three tests pin what is applied ON TOP of the IOP figure: the
//! classical SHA-256 cap, the quantum line, the hash-collision lines, and the
//! published-block entries and rendered cells built from them. Their values
//! come from `scratchpad/v2-run/logs/WP1-fix1b-indep.py` (log:
//! `WP1-fix1b-indep.log`), which writes those transforms from the statements
//! the document cites (BCS in the random-oracle model: min(iop, h/2); CMS19 in
//! the quantum random-oracle model: min(iop/2, h/3); birthday: b/2;
//! Brassard-Høyer-Tapp: b/3; b = 256 for SHA-256, 64 for one Goldilocks
//! element, 256 for four), not from `calc.rs`. Round 1b's verifier changed each
//! of those formulas, regenerated the document, and the suite stayed green
//! (mutations Q1, Q2, H1, H2 and H3 of `verify-WP1-r1b-mutations.log`).

use p01_security_levels::calc::{self, Regime};
use p01_security_levels::params::{self, Sampler, StarkParams};
use p01_security_levels::render;

const TOL: f64 = 1e-3;

/// (group, bits) as `RegimeResult::group_bits` names the groups.
type Groups = &'static [(&'static str, f64)];

struct Pin {
    regime: Regime,
    /// The optimal Johnson multiplicity, where the regime has one.
    m: Option<u32>,
    groups: Groups,
    total: f64,
}

const ALI: &str = "ALI";
const DEEP: &str = "DEEP";
const BATCH: &str = "FRI batching";
const FOLDS: &str = "FRI folds";
const QUERY: &str = "FRI queries + grinding";
const FLOOR: &str = "Field floor";

fn c7() -> StarkParams {
    let p = params::v1_circuits().into_iter().find(|p| p.label == "C7").expect("C7 is in compact_proof.rs");
    let shape = (
        p.trace_length,
        p.trace_width,
        p.quotient_segments,
        p.lde_size,
        p.fri_final_poly_size,
        p.fri_final_poly_degree_bound,
        p.num_queries,
        p.grinding_bits,
        p.ext_degree,
    );
    assert_eq!(shape, (512, 12, 8, 8192, 32, 2, 22, 22, 1), "C7's shape changed: re-derive the pins below");
    p
}

fn v2(label: &str, e: u32, lde: usize, bound: usize, q: usize) -> StarkParams {
    let p = params::v2_profiles().into_iter().find(|p| p.label == label).unwrap_or_else(|| panic!("no profile {label}"));
    let shape = (
        p.ext_degree,
        p.trace_length,
        p.trace_width,
        p.quotient_segments,
        p.lde_size,
        p.fri_final_poly_size,
        p.fri_final_poly_degree_bound,
        p.num_queries,
        p.grinding_bits,
    );
    assert_eq!(shape, (e, 1024, 36, 8, lde, 32, bound, q, 16), "profile {label} changed: re-derive the pins below");
    p
}

fn check(p: &StarkParams, sampler: Sampler, pins: &[Pin]) {
    for pin in pins {
        let r = calc::evaluate(p, pin.regime, sampler);
        let what = format!("{} {:?} {:?}", p.label, pin.regime, sampler);
        assert_eq!(r.m, pin.m, "{what}: optimal m");
        for &(group, want) in pin.groups {
            let got = r.group_bits(group).unwrap_or_else(|| panic!("{what}: no {group} term"));
            assert!((got - want).abs() < TOL, "{what}: {group} is {got:.4}, the independent recomputation gives {want:.4}");
        }
        assert!((r.bits - pin.total).abs() < TOL, "{what}: union {:.4}, independent {:.4}", r.bits, pin.total);
        if let Some(m) = pin.m {
            let at = calc::evaluate_at_m(p, pin.regime, sampler, m);
            assert!((at.bits - pin.total).abs() < TOL, "{what}: at m = {m}, {:.4} vs {:.4}", at.bits, pin.total);
        }
    }
}

#[test]
fn c7_as_shipped_matches_the_independent_recomputation_term_by_term() {
    check(
        &c7(),
        Sampler::U64ModP,
        &[
            Pin {
                regime: Regime::UniqueDecoding,
                m: None,
                groups: &[(ALI, 56.9556), (DEEP, 50.8276), (BATCH, 46.8460), (FOLDS, 50.0042), (QUERY, 42.0525)],
                total: 41.9926,
            },
            Pin {
                regime: Regime::UniqueDecodingBciks20,
                m: None,
                groups: &[(ALI, 56.9556), (DEEP, 50.8276), (BATCH, 45.7521), (FOLDS, 50.0042), (QUERY, 42.0758)],
                total: 41.9585,
            },
            Pin {
                regime: Regime::JohnsonBciks20,
                m: Some(3),
                groups: &[(ALI, 53.1922), (DEEP, 47.0233), (BATCH, 15.6481), (FOLDS, 41.1925), (QUERY, 61.0455)],
                total: 15.6481,
            },
            Pin {
                regime: Regime::JohnsonBchks25,
                m: Some(3),
                groups: &[(ALI, 53.1922), (DEEP, 47.0233), (BATCH, 31.2954), (FOLDS, 35.5105), (QUERY, 61.0455)],
                total: 31.2197,
            },
            Pin { regime: Regime::Conjectured, m: None, groups: &[(FLOOR, 46.9119), (QUERY, 110.0000)], total: 46.9119 },
        ],
    );
}

#[test]
fn c7_uniform_matches_the_independent_recomputation_term_by_term() {
    check(
        &c7(),
        Sampler::Uniform,
        &[
            Pin {
                regime: Regime::UniqueDecoding,
                m: None,
                groups: &[(ALI, 58.0000), (DEEP, 51.8279), (BATCH, 47.8460), (FOLDS, 51.0056), (QUERY, 42.0525)],
                total: 42.0222,
            },
            Pin {
                regime: Regime::UniqueDecodingBciks20,
                m: None,
                groups: &[(ALI, 58.0000), (DEEP, 51.8279), (BATCH, 46.7521), (FOLDS, 51.0056), (QUERY, 42.0758)],
                total: 42.0160,
            },
            Pin {
                regime: Regime::JohnsonBciks20,
                m: Some(3),
                groups: &[(ALI, 54.1955), (DEEP, 48.0233), (BATCH, 16.6481), (FOLDS, 42.1925), (QUERY, 61.0455)],
                total: 16.6481,
            },
            Pin {
                regime: Regime::JohnsonBchks25,
                m: Some(3),
                groups: &[(ALI, 54.1955), (DEEP, 48.0233), (BATCH, 32.2954), (FOLDS, 36.5105), (QUERY, 61.0455)],
                total: 32.2197,
            },
            Pin { regime: Regime::Conjectured, m: None, groups: &[(FLOOR, 47.9121), (QUERY, 110.0000)], total: 47.9121 },
        ],
    );
}

/// The D1 gate: Q misses the Johnson >= 100 exit, R meets it at m = 56,
/// R-128 reaches it at m = 7.
#[test]
fn the_d1_profiles_match_the_independent_recomputation_term_by_term() {
    check(
        &v2("Q", 2, 16384, 2, 36),
        Sampler::Uniform,
        &[
            Pin {
                regime: Regime::UniqueDecoding,
                m: None,
                groups: &[(ALI, 122.0000), (DEEP, 114.8290), (BATCH, 109.6673), (FOLDS, 114.0028), (QUERY, 48.8322)],
                total: 48.8322,
            },
            Pin {
                regime: Regime::UniqueDecodingBciks20,
                m: None,
                groups: &[(ALI, 122.0000), (DEEP, 114.8290), (BATCH, 108.5737), (FOLDS, 114.0028), (QUERY, 48.8513)],
                total: 48.8513,
            },
            Pin {
                regime: Regime::JohnsonBciks20,
                m: Some(3),
                groups: &[(ALI, 118.1941), (DEEP, 111.0230), (BATCH, 77.4905), (FOLDS, 105.0226), (QUERY, 79.9432)],
                total: 77.2485,
            },
            Pin {
                regime: Regime::JohnsonBchks25,
                m: Some(9),
                groups: &[(ALI, 116.7535), (DEEP, 109.5825), (BATCH, 86.9169), (FOLDS, 92.3246), (QUERY, 85.1412)],
                total: 84.7639,
            },
            Pin { regime: Regime::Conjectured, m: None, groups: &[(FLOOR, 110.7517), (QUERY, 160.0000)], total: 110.7517 },
        ],
    );
    check(
        &v2("R", 3, 32768, 1, 36),
        Sampler::Uniform,
        &[
            Pin {
                regime: Regime::UniqueDecoding,
                m: None,
                groups: &[(ALI, 186.0000), (DEEP, 178.8290), (BATCH, 172.6197), (FOLDS, 177.0014), (QUERY, 50.3923)],
                total: 50.3923,
            },
            Pin {
                regime: Regime::UniqueDecodingBciks20,
                m: None,
                groups: &[(ALI, 186.0000), (DEEP, 178.8290), (BATCH, 171.5737), (FOLDS, 177.0014), (QUERY, 50.4018)],
                total: 50.4018,
            },
            Pin {
                regime: Regime::JohnsonBciks20,
                m: Some(56),
                groups: &[(ALI, 177.6812), (DEEP, 170.5102), (BATCH, 109.9008), (FOLDS, 163.3578), (QUERY, 105.4877)],
                total: 105.4215,
            },
            Pin {
                regime: Regime::JohnsonBchks25,
                m: Some(492),
                groups: &[(ALI, 174.5574), (DEEP, 167.3864), (BATCH, 119.9367), (FOLDS, 113.4767), (QUERY, 105.8966)],
                total: 105.8890,
            },
            Pin { regime: Regime::Conjectured, m: None, groups: &[(FLOOR, 173.6423), (QUERY, 196.0000)], total: 173.6423 },
        ],
    );
    check(
        &v2("R-128", 3, 32768, 1, 47),
        Sampler::Uniform,
        &[
            Pin {
                regime: Regime::UniqueDecoding,
                m: None,
                groups: &[(ALI, 186.0000), (DEEP, 178.8290), (BATCH, 172.6197), (FOLDS, 177.0014), (QUERY, 60.9010)],
                total: 60.9010,
            },
            Pin {
                regime: Regime::UniqueDecodingBciks20,
                m: None,
                groups: &[(ALI, 186.0000), (DEEP, 178.8290), (BATCH, 171.5737), (FOLDS, 177.0014), (QUERY, 60.9135)],
                total: 60.9135,
            },
            Pin {
                regime: Regime::JohnsonBciks20,
                m: Some(7),
                groups: &[(ALI, 180.5945), (DEEP, 173.4235), (BATCH, 130.2938), (FOLDS, 166.2711), (QUERY, 128.7557)],
                total: 128.3288,
            },
            Pin {
                regime: Regime::JohnsonBchks25,
                m: Some(46),
                groups: &[(ALI, 177.9622), (DEEP, 170.7912), (BATCH, 136.9608), (FOLDS, 137.2682), (QUERY, 132.7008)],
                total: 132.5707,
            },
            Pin { regime: Regime::Conjectured, m: None, groups: &[(FLOOR, 173.6423), (QUERY, 251.0000)], total: 173.6423 },
        ],
    );
}

// ── the lines applied on top of the IOP figure ───────────────────────────────

/// (regime, IOP figure, classical figure with the SHA-256 cap, quantum line)
type Lines = &'static [(Regime, f64, f64, f64)];

fn check_lines(p: &StarkParams, sampler: Sampler, lines: Lines) {
    assert_eq!(p.merkle_hash_bits, 256, "{}: the Merkle and transcript hash is SHA-256", p.label);
    for &(regime, iop, capped, quantum) in lines {
        let what = format!("{} {regime:?} {sampler:?}", p.label);
        let r = calc::evaluate(p, regime, sampler);
        assert!((r.bits - iop).abs() < TOL, "{what}: IOP figure {:.4}, independent {iop:.4}", r.bits);
        let c = calc::with_hash_cap(r.bits, p.merkle_hash_bits);
        assert!((c - capped).abs() < TOL, "{what}: with the SHA-256 cap {c:.4}, independent min(iop, 256/2) = {capped:.4}");
        let q = calc::quantum_bits(r.bits, p.merkle_hash_bits);
        assert!((q - quantum).abs() < TOL, "{what}: quantum line {q:.4}, independent min(iop/2, 256/3) = {quantum:.4}");
    }
}

/// The quantum line (CMS19) and the classical SHA-256 cap, on C7 as shipped
/// and on the three D1 profiles. R's conjectured 173.64 and R-128's Johnson
/// 128.32 are where the classical cap binds (finding F-WP1-5); R and R-128's
/// conjectured quantum line is where the 256/3 cap binds.
#[test]
fn the_quantum_line_and_the_sha256_cap_match_the_independent_recomputation() {
    assert_eq!(params::SHA256_BITS, 256);
    check_lines(
        &c7(),
        Sampler::U64ModP,
        &[
            (Regime::UniqueDecoding, 41.9926, 41.9926, 20.9963),
            (Regime::JohnsonBciks20, 15.6481, 15.6481, 7.8240),
            (Regime::JohnsonBchks25, 31.2197, 31.2197, 15.6099),
            (Regime::Conjectured, 46.9119, 46.9119, 23.4559),
        ],
    );
    check_lines(
        &v2("Q", 2, 16384, 2, 36),
        Sampler::Uniform,
        &[
            (Regime::UniqueDecoding, 48.8322, 48.8322, 24.4161),
            (Regime::JohnsonBciks20, 77.2485, 77.2485, 38.6242),
            (Regime::JohnsonBchks25, 84.7639, 84.7639, 42.3820),
            (Regime::Conjectured, 110.7517, 110.7517, 55.3758),
        ],
    );
    check_lines(
        &v2("R", 3, 32768, 1, 36),
        Sampler::Uniform,
        &[
            (Regime::UniqueDecoding, 50.3923, 50.3923, 25.1961),
            (Regime::JohnsonBciks20, 105.4215, 105.4215, 52.7107),
            (Regime::JohnsonBchks25, 105.8890, 105.8890, 52.9445),
            (Regime::Conjectured, 173.6423, 128.0000, 85.3333),
        ],
    );
    check_lines(
        &v2("R-128", 3, 32768, 1, 47),
        Sampler::Uniform,
        &[
            (Regime::UniqueDecoding, 60.9010, 60.9010, 30.4505),
            (Regime::JohnsonBciks20, 128.3288, 128.0000, 64.1644),
            (Regime::JohnsonBchks25, 132.5707, 128.0000, 66.2853),
            (Regime::Conjectured, 173.6423, 128.0000, 85.3333),
        ],
    );
}

/// The generic collision lines: nominal output b, birthday b/2, BHT b/3.
#[test]
fn the_hash_collision_lines_match_the_independent_recomputation() {
    let want: [(&str, f64, f64, f64); 3] = [
        ("sha256", 256.0, 128.0000, 85.3333),
        ("v1-digest", 64.0, 32.0000, 21.3333),
        ("v2-digest", 256.0, 128.0000, 85.3333),
    ];
    let lines = calc::hash_lines();
    let slugs: Vec<&str> = lines.iter().map(|h| h.slug).collect();
    assert_eq!(slugs, want.iter().map(|w| w.0).collect::<Vec<_>>(), "the hash lines changed: re-derive the pins");
    for (h, &(slug, output, collision, quantum)) in lines.iter().zip(want.iter()) {
        assert_eq!(h.output_bits, output, "{slug}: nominal output");
        assert!((h.collision - collision).abs() < TOL, "{slug}: collision {:.4}, independent {collision:.4}", h.collision);
        assert!(
            (h.collision_quantum - quantum).abs() < TOL,
            "{slug}: quantum collision (BHT) {:.4}, independent {quantum:.4}",
            h.collision_quantum
        );
    }
}

/// The published block the prose test reads, and the cells a reader copies
/// from, carry those values: a formula changed in `render.rs` instead of
/// `calc.rs` goes red here too.
#[test]
fn the_published_block_and_the_rendered_cells_carry_the_independent_values() {
    let doc = render::document();
    let begin = doc.find("<!-- published-figures:begin -->").expect("published block begins");
    let end = doc.find("<!-- published-figures:end -->").expect("published block ends");
    let block: Vec<&str> = doc[begin..end].lines().collect();
    for line in [
        "C7 unique-decoding 41",
        "C7 quantum-unique-decoding 20",
        "C7 johnson-bciks20 15",
        "C7 quantum-johnson-bciks20 7",
        "C7 johnson-bchks25 31",
        "C7 quantum-johnson-bchks25 15",
        "C7 conjectured 46",
        "C7 quantum-conjectured 23",
        "sha256 collision 128",
        "sha256 collision-quantum 85",
        "v1-digest collision 32",
        "v1-digest collision-quantum 21",
    ] {
        assert!(block.contains(&line), "the published block does not carry {line:?}, the independent floor");
    }
    // (row prefix, row suffix): the v1 and v2 summary rows and the hash table
    for (prefix, suffix) in [
        ("| C7 | spend |", "| 41.99 | 15.64 (m=3) | 31.21 (m=3) | 46.91 | 20.99 / 7.82 / 23.45 |"),
        ("| Q | 2 |", "| 48.83 / 77.24 / 110.75 | 24.41 / 38.62 / 55.37 |"),
        ("| R | 3 |", "| 50.39 / 105.42 / 128.00 | 25.19 / 52.71 / 85.33 |"),
        ("| R-128 | 3 |", "| 60.90 / 128.00 / 128.00 | 30.45 / 64.16 / 85.33 |"),
        ("| SHA-256 |", "| 256 | 128.00 | 85.33 |"),
        ("| Poseidon t=3, one Goldilocks element (v1) |", "| 64 | 32.00 | 21.33 |"),
        ("| Poseidon2 width 12, four Goldilocks elements (v2 design) |", "| 256 | 128.00 | 85.33 |"),
    ] {
        let rows: Vec<&str> = doc.lines().filter(|l| l.starts_with(prefix)).collect();
        assert_eq!(rows.len(), 1, "one row starts with {prefix:?}, found {rows:?}");
        assert!(rows[0].ends_with(suffix), "{prefix}: the row is\n  {}\nthe independent values give\n  ...{suffix}", rows[0]);
    }
    // the per-term tables' last two rows, where the caps show
    for (heading, capped, quantum) in [
        ("### C7 spend (v1, as shipped)", "| 41.99 | 15.64 | 31.21 | 46.91 |", "| 20.99 | 7.82 | 15.60 | 23.45 |"),
        ("### R C6v2 / C7v2 shape (v2 candidate)", "| 50.39 | 105.42 | 105.88 | 128.00 |", "| 25.19 | 52.71 | 52.94 | 85.33 |"),
        ("### R-128 C6v2 / C7v2 shape (v2 candidate)", "| 60.90 | 128.00 | 128.00 | 128.00 |", "| 30.45 | 64.16 | 66.28 | 85.33 |"),
    ] {
        let start = doc.find(heading).unwrap_or_else(|| panic!("no section {heading:?}"));
        let rest = &doc[start + heading.len()..];
        let section = &rest[..rest.find("\n#").unwrap_or(rest.len())];
        let row = |label: &str| section.lines().find(|l| l.starts_with(label)).unwrap_or_else(|| panic!("{heading}: no row {label:?}"));
        let c = row("| With the SHA-256 cap (classical, random-oracle model) |");
        assert!(c.ends_with(capped), "{heading}: {c}\n  independent: ...{capped}");
        let q = row("| Quantum (CMS19, half, capped at 85.33) |");
        assert!(q.ends_with(quantum), "{heading}: {q}\n  independent: ...{quantum}");
    }
}
