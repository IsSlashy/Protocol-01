//! README claims checked against the code they describe (audit v1, round 1,
//! fix lane 3).
//!
//! * The "Configured FRI parameters" row of README.md must be the sentence
//!   this test builds from the deployed verifier's own constants
//!   (`compact_proof.rs`, compiled into this crate): the query count of every
//!   circuit, the blowup, the FRI rate the verifier enforces, and
//!   `GRINDING_BITS`. Until this round the row said "27 on the other four
//!   circuits", which put 27 queries on C0 and C4; both run 22 since
//!   2026-09-12.
//! * The README must not present the pre-B2 FRI rate of 1/2 as a reason no
//!   figure exists without also stating the rate the verifier enforces, and
//!   must not say that no figure is derived from the parameters:
//!   `docs/SECURITY-LEVELS.md` derives one per circuit and regime.
//! * The pool flow diagram must not say withdrawn funds land at an
//!   X25519 + ML-KEM-768 stealth address while the web withdrawal pays
//!   `derivePoolPayoutKeypair`, an HKDF of an Ed25519 wallet signature with no
//!   KEM (`apps/web/lib/privacy/shieldClient.ts`).
//!
//! No figure in "N bits" form is written by these checks; the prose test
//! (`tests/prose.rs`) keeps its own ledger of those.

use std::fs;

use p01_security_levels::compact_proof::GRINDING_BITS;
use p01_security_levels::params::{self, StarkParams};
use p01_security_levels::repo_root;

fn readme() -> String {
    fs::read_to_string(repo_root().join("README.md")).expect("README.md is readable")
}

/// "a", "a and b", "a, b and c".
fn join_and(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

fn circuit_ref(p: &StarkParams) -> String {
    format!("{} `{}`", p.label, p.name)
}

/// The FRI parameter sentence, built from the verifier's constants only.
fn expected_fri_row() -> String {
    let circuits = params::v1_circuits();
    assert_eq!(circuits.len(), 8, "the verifier accepts eight circuits");

    let mut counts: Vec<usize> = circuits.iter().map(|p| p.num_queries).collect();
    counts.sort_unstable();
    counts.dedup();
    let groups: Vec<String> = counts
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let names: Vec<String> = circuits.iter().filter(|p| p.num_queries == *q).map(circuit_ref).collect();
            let unit = if i == 0 { " queries" } else { "" };
            format!("{q}{unit} on {}", join_and(&names))
        })
        .collect();

    let blowups: Vec<usize> = circuits.iter().map(|p| p.blowup()).collect();
    assert!(blowups.windows(2).all(|w| w[0] == w[1]), "one blowup on every circuit: {blowups:?}");
    let rates: Vec<(usize, usize)> =
        circuits.iter().map(|p| (p.fri_final_poly_size, p.fri_final_poly_degree_bound)).collect();
    let inv: Vec<usize> = rates.iter().map(|(size, bound)| size / bound).collect();
    assert!(
        rates.iter().all(|(size, bound)| size % bound == 0) && inv.windows(2).all(|w| w[0] == w[1]),
        "one FRI rate 1/k on every circuit: {rates:?}"
    );

    format!(
        "{}; blowup {}; FRI rate 1/{} enforced by the verifier on every circuit \
         (final-polynomial degree bound over its size); grinding `GRINDING_BITS = {}`",
        groups.join("; "),
        blowups[0],
        inv[0],
        GRINDING_BITS
    )
}

fn fri_row(text: &str) -> String {
    text.lines()
        .find(|l| l.starts_with("| Configured FRI parameters |"))
        .expect("README.md has a `| Configured FRI parameters |` row")
        .to_string()
}

#[test]
fn the_fri_parameter_row_is_the_verifiers_configuration() {
    let row = fri_row(&readme());
    let expected = expected_fri_row();
    assert!(
        row.contains(&expected),
        "README.md's FRI parameter row does not state the deployed verifier's configuration.\n\
         expected it to contain:\n  {expected}\nrow is:\n  {row}"
    );
}

#[test]
fn every_circuit_is_named_once_in_the_fri_row_with_its_own_query_count() {
    // Independent of the exact wording above: split the row's query clause at
    // ';' and check each circuit sits in the clause that starts with its q.
    let row = fri_row(&readme());
    let circuits = params::v1_circuits();
    for p in &circuits {
        let needle = circuit_ref(p);
        let hits: Vec<&str> = row.split(';').filter(|clause| clause.contains(&needle)).collect();
        assert_eq!(hits.len(), 1, "{needle} should be named in exactly one clause of the FRI row: {row}");
        let lead: String = hits[0].trim_start_matches(|c: char| !c.is_ascii_digit()).chars().take_while(|c| c.is_ascii_digit()).collect();
        assert_eq!(
            lead.parse::<usize>().ok(),
            Some(p.num_queries),
            "{needle} runs {} queries in compact_proof.rs, but its clause reads: {}",
            p.num_queries,
            hits[0].trim()
        );
    }
    // The wording the audit found must not come back.
    assert!(!row.contains("the other four"), "the row still says `the other four`: {row}");
}

/// A paragraph is a run of non-empty lines.
fn paragraphs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push_str(line);
            cur.push(' ');
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[test]
fn the_pre_b2_rate_is_never_left_as_the_current_one() {
    let circuits = params::v1_circuits();
    let k = circuits[0].fri_final_poly_size / circuits[0].fri_final_poly_degree_bound;
    let enforced = format!("enforces rate 1/{k}");
    for para in paragraphs(&readme()) {
        let lower = para.to_lowercase();
        if lower.contains("rate") && lower.contains("1/2") {
            assert!(
                para.contains(&enforced) && lower.contains("docs/security-levels.md"),
                "a README paragraph cites an FRI rate of 1/2 without saying the verifier `{enforced}` \
                 and pointing at docs/SECURITY-LEVELS.md:\n{para}"
            );
        }
    }
    let text = readme();
    assert!(
        !text.contains("no security-bit figure is derived from them"),
        "README.md says no figure is derived from the FRI parameters; docs/SECURITY-LEVELS.md derives one per circuit"
    );
}

/// The body of `export function derivePoolPayoutKeypair(...)` in the web client.
fn payout_derivation_source() -> String {
    let path = repo_root().join("apps/web/lib/privacy/shieldClient.ts");
    let src = fs::read_to_string(&path).expect("shieldClient.ts is readable");
    let start = src.find("export function derivePoolPayoutKeypair(").expect("derivePoolPayoutKeypair is exported");
    let rest = &src[start..];
    let end = rest.find("\n}").expect("function ends with a closing brace at column 0");
    rest[..end].to_string()
}

#[test]
fn the_pool_flow_diagram_does_not_credit_a_kem_to_the_web_withdrawal() {
    let body = payout_derivation_source();
    let lower = body.to_lowercase();
    let uses_kem = ["ml_kem", "mlkem", "ml-kem", "x25519", "kyber"].iter().any(|k| lower.contains(k));
    assert!(body.contains("hkdf("), "derivePoolPayoutKeypair no longer uses HKDF; re-read it and update this test");
    if uses_kem {
        // The claim would be true again; nothing to check.
        return;
    }

    let text = readme();
    let start = text
        .find("User generates a STARK proof")
        .expect("README.md keeps its pool flow diagram (`User generates a STARK proof ...`)");
    let block = &text[start..];
    let block = &block[..block.find("```").expect("the diagram is a fenced block")];
    for line in block.lines() {
        let l = line.to_lowercase();
        assert!(
            !(l.contains("ml-kem") || l.contains("x25519")),
            "the pool flow diagram credits a KEM to the withdrawal, but derivePoolPayoutKeypair \
             (apps/web/lib/privacy/shieldClient.ts) is HKDF over an Ed25519 wallet signature with no KEM:\n  {}",
            line.trim()
        );
    }
    assert!(
        block.contains("HKDF") && block.contains("Ed25519"),
        "the pool flow diagram should say what the payout address is derived from (HKDF of an Ed25519 wallet signature):\n{block}"
    );
}
