//! `docs/SECURITY-LEVELS.md` and the `--terms` report.

use std::fmt::Write as _;

use crate::calc::{self, Regime, RegimeResult};
use crate::params::{self, Sampler, StarkParams};

/// Two decimals, truncated: a printed figure never exceeds the value.
fn b(x: f64) -> String {
    format!("{:.2}", calc::trunc2(x))
}

fn rho_text(p: &StarkParams) -> String {
    format!("1/{}", (1.0 / p.rho()).round() as u64)
}

const GROUPS: [&str; 6] = ["ALI", "DEEP", "FRI batching", "FRI folds", "FRI queries + grinding", "Field floor"];

fn group_cell(r: &RegimeResult, group: &str) -> String {
    r.group_bits(group).map(b).unwrap_or_else(|| "n/a".to_string())
}

fn m_text(r: &RegimeResult) -> String {
    r.m.map(|m| format!(" (m={m})")).unwrap_or_default()
}

struct Row {
    p: StarkParams,
    results: Vec<RegimeResult>,
}

impl Row {
    fn new(p: &StarkParams, sampler: Sampler) -> Row {
        Row { p: p.clone(), results: Regime::HEADLINE.iter().map(|&r| calc::evaluate(p, r, sampler)).collect() }
    }
    fn get(&self, regime: Regime) -> &RegimeResult {
        self.results.iter().find(|r| r.regime == regime).expect("headline regime")
    }
    fn quantum(&self, regime: Regime) -> f64 {
        calc::quantum_bits(self.get(regime).bits, self.p.merkle_hash_bits)
    }
    fn capped(&self, regime: Regime) -> f64 {
        calc::with_hash_cap(self.get(regime).bits, self.p.merkle_hash_bits)
    }
}

const PREAMBLE: &str = "\
# Security levels (generated)

<!-- GENERATED FILE: do not edit by hand. Regenerate with
       cargo run --manifest-path tools/security-levels/Cargo.toml -- --write
     `cargo test --manifest-path tools/security-levels/Cargo.toml` fails while it is stale. -->

This file is written by `tools/security-levels` and is the one place a Protocol 01 soundness figure may be copied from. A figure is the base-2 logarithm of what a cheating prover has to spend: hash evaluations, or one over its probability of success. Each one below stands next to the regime it holds in and the assumptions it needs, and a figure quoted without them is not a figure from this file.

Figures are truncated to two decimals, never rounded up. The integer a document may quote is the floor of the figure.

## Where the parameters come from

- **v1, deployed.** The eight `CircuitConfig` constants and `GRINDING_BITS` of `programs/p01_stark_verifier/src/compact_proof.rs`, and `MODULUS` of `programs/p01_stark_verifier/src/goldilocks.rs`. The calculator compiles those two files (a `#[path]` module), so it reads the verifier's own numbers, not a copy of them.
- **v2, candidates behind decision D1.** Profiles Q, R and R-128 of the v2 design, defined in `tools/security-levels/src/params.rs`. Some of their inputs stay assumptions until the v2 AIR exists; they are marked [E] under Assumptions.

## Regimes

Every regime lists the error terms of the protocol the verifier runs (DEEP-ALI over a batched, arity-2 FRI; Fiat-Shamir over SHA-256; grinding before the queries) and adds them up: a union bound. Notation: n trace length, w columns, k quotient segments, |D0| LDE size, rho the FRI rate the verifier enforces (final-polynomial degree bound over its size), rho+ = (n + 2)/|D0|, L = w + k functions batched with the powers of one challenge gamma, r folds, q queries, g grinding bits, C constraints, |F| the challenge field.

1. **Unique decoding (theorem).** Proximity theta = (1 - rho)/2 - 3/((1 - rho)|D0|), just inside the unique-decoding radius. Batching: BCHKS25 (eprint 2025/2055) Thm 4.1, (L - 1)(theta |D0| + 1) bad values of gamma, plus gamma = 0. Folds: BCIKS20 (eprint 2020/654) Thm 4.1, |D(i+1)| bad values per fold. ALI and DEEP: Haböck (eprint 2022/1216, version of 2024-12-17) Thm 8 with list size 1. Queries: (1 - theta)^q 2^-g.
2. **Johnson, BCIKS20 (theorem, headline).** BCIKS20 Thm 8.3 in the batched form of Haböck Thm 2, eq. (7): (L - 1/2)(m + 1/2)^7 |D0|^2 / (3 rho^(3/2) |F|) + (2m + 1)(|D0| + 1) sum(a_i) / (sqrt(rho) |F|). ALI and DEEP: Haböck Thm 8 with list size L+ = (m + 1/2)/sqrt(rho+). Queries: (sqrt(rho+)(1 + 1/2m))^q 2^-g. The analysis parameter m >= 3 is chosen by exhaustive search over 3..65535 for the largest figure; the verifier never sees it. The public headline is this column.
3. **Johnson, BCHKS25 (theorem, 2025, informational).** BCHKS25 Thm 4.2, whose error grows with |D| instead of |D|^2, for the batching and for each fold, composed over the rounds as the Ethereum Foundation's `soundcalc` does (BCIKS20 Thm 5.1 on a fold whose code has dimension 1, where Thm 4.2 is void). Same ALI, DEEP and query terms as regime 2. Newer and tighter than regime 2, and not the headline.
4. **Conjectured (repository formula).** The formula of `programs/p01_stark_verifier/tests/b1_deep_binding.rs`: a field floor (8n + w + k + 1 + r|D0|)/|F| and a query term 2^-(q log2(1/rho) + g), here added as a union instead of taking their minimum. It assumes proximity gaps up to list-decoding capacity (BCIKS20 Conjecture 8.4, which the repository's comments cite as \"ethSTARK Conjecture 8.4\"). Counterexamples to strong forms of that conjecture were published in 2025 (Diamond and Gruen, eprint 2025/2010; Crites and Stewart, eprint 2025/2046; BCHKS25). This column is never quoted without the two theorem columns beside it.
5. **Quantum.** Chiesa, Manohar and Spooner (TCC 2019) prove the Fiat-Shamir (BCS) transform sound against t quantum oracle queries up to O(t^2 eps + t^3 / 2^256) for SHA-256. The quantum line is half the classical figure of its regime, capped at 256/3 = 85.33 by SHA-256. It is a floor the proof gives, not a known attack.
6. **Hash lines.** Generic collision bounds on the nominal output size: the birthday bound (classical, output/2) and Brassard-Høyer-Tapp (quantum, output/3, with about as much quantum memory as it makes queries). In the random-oracle model the classical non-interactive figure is also capped at 256/2 by the Merkle and transcript hash.

## Assumptions

- **A1. Challenges.** v2 draws every challenge uniformly from its extension field (rejection sampling). v1 draws each one as `u64 % p`; see the next section.
- **A2. DEEP degree.** The prover commits k segments of degree below n, so the DEEP identity has degree at most k(n + 1) + n - 1 in z.
- **A3. Constraints.** At most C = 64 constraints (transition and boundary) are combined with random powers. Not read from the AIRs; the largest v1 transition count is 29 (`TRANSFER_NUM_CONSTRAINTS`). Raising C to 1024 moves no figure by 0.01 (`tests/v1_reproduction.rs`).
- **A4. Rate.** The FRI rate is the one the verifier enforces, `fri_final_poly_degree_bound / fri_final_poly_size`: 1/16 on every v1 circuit, never assumed from the blowup.
- **A5. Queries.** `verify.rs` draws query positions uniformly in D0 (a u32 reduced modulo a power of two) and keeps them distinct, which can only lower the query term.
- **A6. Union bound.** soundcalc and the ethSTARK documentation report the minimum over rounds; the union bound here is lower by up to log2 of the number of terms.
- **A7. [E] v2 inputs.** n = 1024, w = 36, k = 8, C <= 64, a final polynomial of 32 coefficients with degree bound 32/blowup, arity-2 folds, a Poseidon2 digest of four elements. Taken from the v2 design, not from code.
- **A8. Hashes.** The hash lines count generic attacks only. The v1 Poseidon constants have no published provenance (finding F1); nothing here covers a structural attack on them.
";

fn sampler_section(out: &mut String, v1: &[StarkParams]) {
    let _ = writeln!(out, "## The v1 challenge sampler costs up to one bit\n");
    let _ = writeln!(
        out,
        "`verify.rs` turns a transcript hash into a challenge as `u64 % p`. It maps 0 to 1 for the constraint-combination \
         (RLC), DEEP-combination and FRI-fold challenges, and re-draws the DEEP point z instead. \
         Since 2^64 = p + 2^32 - 1, every residue below 2^32 - 1 has two preimages, and the value 1 has four (0, 1, p and p + 1). \
         A set of s bad challenge values can therefore carry (2s + 2)/2^64 instead of s/p, so every field-bound term can double. \
         The figures pinned in `b1_deep_binding.rs` use the uniform model; the deployed verifier's figures are the as-shipped ones, \
         and those are the ones published at the end of this file.\n"
    );
    let _ = writeln!(
        out,
        "| Circuit | Pinned in b1: UD / conj. | Repository formula, uniform: UD / conj. | Union bound, uniform: UD / UD with BCIKS20 bounds only / conj. | Union bound, as shipped: UD / conj. |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|");
    for p in v1 {
        let repo = calc::repo_convention(p);
        let u = |r| calc::evaluate(p, r, Sampler::Uniform).bits;
        let s = |r| calc::evaluate(p, r, Sampler::U64ModP).bits;
        let _ = writeln!(
            out,
            "| {} | {} / {} | {} / {} | {} / {} / {} | {} / {} |",
            p.label,
            calc::floor_bits(repo.unconditional),
            calc::floor_bits(repo.conjectured),
            b(repo.unconditional),
            b(repo.conjectured),
            b(u(Regime::UniqueDecoding)),
            b(u(Regime::UniqueDecodingBciks20)),
            b(u(Regime::Conjectured)),
            b(s(Regime::UniqueDecoding)),
            b(s(Regime::Conjectured)),
        );
    }
    let _ = writeln!(
        out,
        "\nThe column \"Pinned in b1\" is the floor of the repository formula, which is what `b1_deep_binding.rs` asserts. \
         The union bound over every term reproduces it under uniform challenges. Two things move it: the shipped sampler, \
         and, for unique decoding, which theorem bounds the batching step (BCHKS25 or the older BCIKS20).\n"
    );
}

fn v1_summary(out: &mut String, rows: &[Row]) {
    let _ = writeln!(out, "## v1, as shipped (the deployed verifier)\n");
    let _ = writeln!(
        out,
        "| Circuit | Name | n | w | k | LDE | rho | r | q | g | Unique decoding | Johnson, BCIKS20 (m) | Johnson, BCHKS25 (m) | Conjectured | Quantum: UD / Johnson BCIKS20 / conj. |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for row in rows {
        let p = &row.p;
        let jb = row.get(Regime::JohnsonBciks20);
        let j25 = row.get(Regime::JohnsonBchks25);
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {}{} | {}{} | {} | {} / {} / {} |",
            p.label,
            p.name,
            p.trace_length,
            p.trace_width,
            p.quotient_segments,
            p.lde_size,
            rho_text(p),
            p.folds(),
            p.num_queries,
            p.grinding_bits,
            b(row.get(Regime::UniqueDecoding).bits),
            b(jb.bits),
            m_text(jb),
            b(j25.bits),
            m_text(j25),
            b(row.get(Regime::Conjectured).bits),
            b(row.quantum(Regime::UniqueDecoding)),
            b(row.quantum(Regime::JohnsonBciks20)),
            b(row.quantum(Regime::Conjectured)),
        );
    }
    let batching_bound = rows.iter().all(|r| {
        let j = r.get(Regime::JohnsonBciks20);
        j.group_bits("FRI batching").is_some_and(|x| x - j.bits < 0.01)
    });
    if batching_bound {
        let _ = writeln!(
            out,
            "\nOn every v1 circuit the BCIKS20 Johnson figure is set by its batching term, which grows with |D0|^2/|F| on a \
             64-bit challenge field: that is why it sits below unique decoding."
        );
    }
    let (best, best_label, best_regime) = rows
        .iter()
        .flat_map(|r| {
            [Regime::UniqueDecoding, Regime::JohnsonBciks20, Regime::JohnsonBchks25]
                .map(|reg| (r.get(reg).bits, r.p.label.clone(), reg))
        })
        .fold((f64::MIN, String::new(), Regime::UniqueDecoding), |a, b| if b.0 > a.0 { b } else { a });
    let _ = writeln!(
        out,
        "The largest v1 figure in a theorem regime is {} ({}, {}).\n",
        b(best),
        best_label,
        best_regime.title()
    );
}

fn v2_summary(out: &mut String, rows: &[Row]) {
    let _ = writeln!(out, "## v2 candidates (C6v2 and C7v2 share one shape)\n");
    let _ = writeln!(
        out,
        "| Profile | e | n | w | LDE | rho | r | q | g | Unique decoding | Johnson, BCIKS20 (m) | Johnson, BCHKS25 (m) | Conjectured | With the SHA-256 cap: UD / Johnson BCIKS20 / conj. | Quantum: UD / Johnson BCIKS20 / conj. |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for row in rows {
        let p = &row.p;
        let jb = row.get(Regime::JohnsonBciks20);
        let j25 = row.get(Regime::JohnsonBchks25);
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {}{} | {}{} | {} | {} / {} / {} | {} / {} / {} |",
            p.label,
            p.ext_degree,
            p.trace_length,
            p.trace_width,
            p.lde_size,
            rho_text(p),
            p.folds(),
            p.num_queries,
            p.grinding_bits,
            b(row.get(Regime::UniqueDecoding).bits),
            b(jb.bits),
            m_text(jb),
            b(j25.bits),
            m_text(j25),
            b(row.get(Regime::Conjectured).bits),
            b(row.capped(Regime::UniqueDecoding)),
            b(row.capped(Regime::JohnsonBciks20)),
            b(row.capped(Regime::Conjectured)),
            b(row.quantum(Regime::UniqueDecoding)),
            b(row.quantum(Regime::JohnsonBciks20)),
            b(row.quantum(Regime::Conjectured)),
        );
    }
    let meets: Vec<&str> = rows
        .iter()
        .filter(|r| r.get(Regime::JohnsonBciks20).bits >= 100.0)
        .map(|r| r.p.label.as_str())
        .collect();
    let misses: Vec<&str> = rows
        .iter()
        .filter(|r| r.get(Regime::JohnsonBciks20).bits < 100.0)
        .map(|r| r.p.label.as_str())
        .collect();
    let none = |v: &Vec<&str>| if v.is_empty() { "none".to_string() } else { v.join(" and ") };
    let _ = writeln!(
        out,
        "\nThe master plan's Phase 3 exit asks for at least 100 in the Johnson (theorem) regime for C6v2 and C7v2. \
         Under BCIKS20 it is met by {} and not by {} (`tests/v2_profiles.rs`).",
        none(&meets),
        none(&misses)
    );
    let capped: Vec<&str> = rows
        .iter()
        .filter(|r| r.capped(Regime::Conjectured) < r.get(Regime::Conjectured).bits)
        .map(|r| r.p.label.as_str())
        .collect();
    if !capped.is_empty() {
        let _ = writeln!(
            out,
            "For {} the conjectured column is above what SHA-256 allows a non-interactive proof: its collision bound caps \
             the classical figure, and its quantum bound caps the quantum line at 85.33.",
            capped.join(" and ")
        );
    }
    let _ = writeln!(out);
}

fn hash_section(out: &mut String) {
    let _ = writeln!(out, "## Hash-collision lines\n");
    let _ = writeln!(
        out,
        "| Hash | Used for | Output, nominal | Classical collision (birthday) | Quantum collision (BHT) |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|");
    for h in calc::hash_lines() {
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} |",
            h.name,
            h.role,
            h.output_bits,
            b(h.collision),
            b(h.collision_quantum)
        );
    }
    let _ = writeln!(
        out,
        "\nThe v1 digest line is not a proof-system term: it is the cost of two openings with one commitment, which lets a \
         depositor spend twice (finding F2). It bounds every v1 pool circuit, whatever its soundness column says.\n"
    );
}

fn term_table(out: &mut String, title: &str, row: &Row) {
    let p = &row.p;
    let sampler = row.results[0].sampler;
    let _ = writeln!(out, "### {title}\n");
    let _ = writeln!(
        out,
        "n = {}, w = {}, k = {}, L = {}, LDE = {}, rho = {}, rho+ = {}/{}, r = {}, q = {}, g = {}, e = {}, C <= {}, challenges: {}.\n",
        p.trace_length,
        p.trace_width,
        p.quotient_segments,
        p.batched_functions(),
        p.lde_size,
        rho_text(p),
        p.trace_length + 2,
        p.lde_size,
        p.folds(),
        p.num_queries,
        p.grinding_bits,
        p.ext_degree,
        p.constraint_bound,
        sampler.slug()
    );
    let heads: Vec<String> =
        Regime::HEADLINE.iter().map(|&r| format!("{}{}", r.title(), m_text(row.get(r)))).collect();
    let _ = writeln!(out, "| Term | {} |", heads.join(" | "));
    let _ = writeln!(out, "|---|---|---|---|---|");
    for group in GROUPS {
        let label = if group == "FRI folds" { format!("FRI folds ({} rounds, summed)", p.folds()) } else { group.to_string() };
        let cells: Vec<String> = Regime::HEADLINE.iter().map(|&r| group_cell(row.get(r), group)).collect();
        let _ = writeln!(out, "| {label} | {} |", cells.join(" | "));
    }
    let union: Vec<String> = Regime::HEADLINE.iter().map(|&r| format!("**{}**", b(row.get(r).bits))).collect();
    let _ = writeln!(out, "| **All terms, union bound** | {} |", union.join(" | "));
    let capped: Vec<String> = Regime::HEADLINE.iter().map(|&r| b(row.capped(r))).collect();
    let _ = writeln!(out, "| With the SHA-256 cap (classical, random-oracle model) | {} |", capped.join(" | "));
    let quantum: Vec<String> = Regime::HEADLINE.iter().map(|&r| b(row.quantum(r))).collect();
    let _ = writeln!(out, "| Quantum (CMS19, half, capped at 85.33) | {} |\n", quantum.join(" | "));
}

/// (circuit or hash label, regime slug, floor of the value): the v1 figures
/// as shipped, and the hash lines v1 relies on.
pub fn published_figures() -> Vec<(String, String, u32)> {
    let mut out = Vec::new();
    for p in params::v1_circuits() {
        for regime in Regime::HEADLINE {
            let r = calc::evaluate(&p, regime, p.sampler);
            out.push((p.label.clone(), regime.slug().to_string(), calc::floor_bits(r.bits)));
            let q = calc::quantum_bits(r.bits, p.merkle_hash_bits);
            out.push((p.label.clone(), format!("quantum-{}", regime.slug()), calc::floor_bits(q)));
        }
    }
    for h in calc::hash_lines() {
        if h.slug == "v2-digest" {
            continue;
        }
        out.push((h.slug.to_string(), "collision".to_string(), calc::floor_bits(h.collision)));
        out.push((h.slug.to_string(), "collision-quantum".to_string(), calc::floor_bits(h.collision_quantum)));
    }
    out
}

fn published_section(out: &mut String) {
    let _ = writeln!(out, "## Published v1 figures\n");
    let _ = writeln!(
        out,
        "`tools/security-levels/tests/prose.rs` reads the block below. A figure in README.md, docs/, apps/web/i18n/ or \
         apps/web/app/ must be one of these for the regime its sentence names and for every circuit it is about (the \
         circuits it names, or every v1 circuit when it names none), or be listed with a reason in \
         `tools/security-levels/prose-ledger.tsv`. What is read, exactly: every file under those four roots whose \
         extension is one of md, mdx, html, htm, ts, tsx, js, jsx, mjs, txt, except this file, the directories \
         node_modules, .next, .turbo, dist and build, and the local-only files listed in `prose::LOCAL_ONLY_FILES` \
         (gitignored or untracked, so a clean checkout does not have them). A file under those roots that is not read \
         because of its extension, or because it sits in a dist or build directory, is checked by \
         `prose::unread_files_with_figures`, and the test fails if it states a figure. A local-only file is neither \
         read nor checked: a figure in one fails nothing, nothing in it ships, and the test re-checks with git \
         (where git can read the tree) that none of them is tracked. A PDF or PPTX is not read at all and must have a \
         text source of the same name that is. The figures below are the floors of the \
         as-shipped v1 figures above. The v2 figures are candidates and are not published.\n"
    );
    let _ = writeln!(out, "<!-- published-figures:begin -->");
    let _ = writeln!(out, "```text");
    for (label, slug, v) in published_figures() {
        let _ = writeln!(out, "{label} {slug} {v}");
    }
    let _ = writeln!(out, "```");
    let _ = writeln!(out, "<!-- published-figures:end -->");
}

pub fn document() -> String {
    let v1 = params::v1_circuits();
    let v2 = params::v2_profiles();
    let v1_rows: Vec<Row> = v1.iter().map(|p| Row::new(p, p.sampler)).collect();
    let v2_rows: Vec<Row> = v2.iter().map(|p| Row::new(p, p.sampler)).collect();

    let mut out = String::from(PREAMBLE);
    out.push('\n');
    sampler_section(&mut out, &v1);
    v1_summary(&mut out, &v1_rows);
    v2_summary(&mut out, &v2_rows);
    hash_section(&mut out);
    let _ = writeln!(out, "## Every error term\n");
    let _ = writeln!(
        out,
        "Each cell is the term's own figure, -log2 of its probability. Folds are summed over their rounds (`--terms` prints \
         each round). n/a: the regime has no such term.\n"
    );
    for row in &v1_rows {
        term_table(&mut out, &format!("{} {} (v1, as shipped)", row.p.label, row.p.name), row);
    }
    for row in &v2_rows {
        term_table(&mut out, &format!("{} {} (v2 candidate)", row.p.label, row.p.name), row);
    }
    published_section(&mut out);
    out
}

fn header(p: &StarkParams) -> String {
    format!(
        "{} {} (n={} w={} k={} |D0|={} rho={} r={} q={} g={} e={} C<={})",
        p.label,
        p.name,
        p.trace_length,
        p.trace_width,
        p.quotient_segments,
        p.lde_size,
        rho_text(p),
        p.folds(),
        p.num_queries,
        p.grinding_bits,
        p.ext_degree,
        p.constraint_bound
    )
}

/// Every term of every circuit in every regime (both samplers for v1), for logs.
pub fn terms_report() -> String {
    let mut out = String::new();
    let all: Vec<StarkParams> = params::v1_circuits().into_iter().chain(params::v2_profiles()).collect();
    for p in &all {
        let _ = writeln!(out, "== {} ==", header(p));
        let samplers: &[Sampler] =
            if p.sampler == Sampler::Uniform { &[Sampler::Uniform] } else { &[p.sampler, Sampler::Uniform] };
        for &sampler in samplers {
            for regime in Regime::ALL {
                let r = calc::evaluate(p, regime, sampler);
                let m = r.m.map(|m| format!(" m={m}")).unwrap_or_default();
                let _ = writeln!(
                    out,
                    "  [{} | {}{}] union {:.4}  quantum {:.4}  with SHA-256 cap {:.4}",
                    regime.slug(),
                    sampler.slug(),
                    m,
                    r.bits,
                    calc::quantum_bits(r.bits, p.merkle_hash_bits),
                    calc::with_hash_cap(r.bits, p.merkle_hash_bits)
                );
                for t in &r.terms {
                    let _ = writeln!(out, "      {:<40} {:>9.4}   {}", t.label, t.bits(), t.source);
                }
            }
        }
        let repo = calc::repo_convention(p);
        let _ = writeln!(
            out,
            "  [repo formula, uniform, min] unconditional {:.4}  conjectured {:.4}\n",
            repo.unconditional, repo.conjectured
        );
    }
    for h in calc::hash_lines() {
        let _ = writeln!(
            out,
            "hash {:<10} output {:>5.1}  collision {:>7.3}  quantum (BHT) {:>7.3}   {} ({})",
            h.slug, h.output_bits, h.collision, h.collision_quantum, h.name, h.role
        );
    }
    out
}
