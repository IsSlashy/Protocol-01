//! `docs/SECURITY-LEVELS.md` is the calculator's output, byte for byte (line
//! endings aside), and it says nothing the standing rules forbid.

use std::fs;

use p01_security_levels::calc::Regime;
use p01_security_levels::{params, render, repo_root, DOC_PATH};

fn normalise(s: &str) -> String {
    s.replace("\r\n", "\n")
}

fn on_disk() -> String {
    let path = repo_root().join(DOC_PATH);
    normalise(&fs::read_to_string(&path).unwrap_or_default())
}

#[test]
fn the_generated_doc_is_current() {
    assert!(
        repo_root().join(DOC_PATH).is_file(),
        "{DOC_PATH} is missing; generate it with\n  cargo run --manifest-path tools/security-levels/Cargo.toml -- --write"
    );
    let want = normalise(&render::document());
    let got = on_disk();
    if got != want {
        let (i, (g, w)) = got
            .lines()
            .zip(want.lines())
            .enumerate()
            .find(|(_, (g, w))| g != w)
            .unwrap_or((got.lines().count().min(want.lines().count()), ("<end of file>", "<end of file>")));
        panic!(
            "{DOC_PATH} differs from the calculator output (first difference at line {}):\n  on disk: {g}\n  wanted:  {w}\n\
             Regenerate it with\n  cargo run --manifest-path tools/security-levels/Cargo.toml -- --write",
            i + 1
        );
    }
}

/// An empty or truncated document would pass a comparison against an equally
/// empty renderer; this pins what the document must contain.
#[test]
fn the_generated_doc_covers_every_circuit_profile_and_regime() {
    let doc = render::document();
    for p in params::v1_circuits().iter().chain(params::v2_profiles().iter()) {
        let row = format!("| {} |", p.label);
        assert!(doc.contains(&row), "no summary row {row:?}");
        let section = format!("### {} ", p.label);
        assert!(doc.contains(&section), "no term table {section:?}");
    }
    for regime in Regime::HEADLINE {
        assert!(!regime.title().is_empty() && doc.contains(regime.title()), "regime {regime:?} is not named");
    }
    for needle in ["Quantum", "SHA-256", "published-figures:begin", "published-figures:end", "union bound"] {
        assert!(doc.contains(needle), "the document does not mention {needle:?}");
    }
    assert!(render::published_figures().len() >= 8 * 4, "every v1 circuit publishes its figures");
}

/// The standing rules: never "zero-knowledge", "untraceable", "trustless",
/// "first", or "128 bits" as a property.
#[test]
fn the_generated_doc_carries_no_forbidden_wording() {
    let doc = render::document().to_lowercase();
    for phrase in ["zero-knowledge", "zero knowledge", "untraceable", "trustless", "128 bits", "128-bit", "128 bit"] {
        assert!(!doc.contains(phrase), "the document says {phrase:?}");
    }
    let words: Vec<&str> = doc.split(|c: char| !c.is_alphanumeric()).collect();
    assert!(!words.contains(&"first"), "the document uses the word \"first\"");
    assert!(!doc.is_empty());
}
