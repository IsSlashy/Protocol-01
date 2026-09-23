//! Finding F66 (audit v1, round 3), closed in lane L5 on 2026-09-23.
//!
//! The web withdrawal on circuit 7 publishes the note's nullifier and no
//! commitment, and what keeps that nullifier from being matched to its
//! deposit is the note's 63-bit PRF blinding
//! (`apps/web/lib/privacy/pool/noteBlinding.ts`, `MASK_63`). `/pay` quotes the
//! cost of trying blindings (about 2^62 hash pairs classically, about 2^31.5
//! Grover queries) and that about four in ten other deposits would fit even a
//! complete search. None of those numbers was published in
//! `docs/SECURITY-LEVELS.md`, so the prose gate could only list "63-bit" in its
//! ledger instead of holding it to a computed line.
//!
//! The calculator now computes the line from the blinding width and the field,
//! the document prints it, and the prose gate matches a "blinding" figure
//! against it. These tests are red until all three hold.

use std::fs;

use p01_security_levels::prose::{self, Family};
use p01_security_levels::{calc, params, render, repo_root};

#[test]
fn the_blinding_width_is_the_mask_the_web_client_applies() {
    let src = fs::read_to_string(repo_root().join("apps/web/lib/privacy/pool/noteBlinding.ts")).expect("noteBlinding.ts");
    let decl = src.lines().find(|l| l.trim_start().starts_with("const MASK_63")).expect("noteBlinding.ts declares MASK_63");
    let want = format!("(1n << {}n) - 1n", params::NOTE_BLINDING_BITS);
    assert!(decl.contains(&want), "noteBlinding.ts: {decl:?} is not a {}-bit mask ({want})", params::NOTE_BLINDING_BITS);
    assert!(src.contains("return n & MASK_63;"), "deriveNoteBlinding no longer masks its output with MASK_63");
}

#[test]
fn the_calculator_computes_the_blinding_search_costs() {
    let b = calc::note_blinding_line();
    assert_eq!(b.width_bits, 63);
    // a complete search tries every blinding, an expected search half of them
    assert_eq!(calc::trunc2(b.complete_search), 63.00);
    assert_eq!(calc::trunc2(b.expected_search), 62.00);
    // Grover: sqrt of the search space, constant factors dropped as in the BHT lines
    assert_eq!(calc::trunc2(b.grover), 31.50);
    // a wrong deposit fits some blinding with probability 1 - exp(-2^63 / p)
    assert!((b.false_fit - 0.3934).abs() < 1e-3, "false-fit fraction {}", b.false_fit);
}

#[test]
fn the_generated_document_publishes_the_blinding_line() {
    let doc = render::document();
    assert!(doc.contains("## The note blinding (circuit 7 withdrawal)"), "no blinding section");
    for needle in ["| 63 |", "62.00", "31.50", "0.39"] {
        assert!(doc.contains(needle), "the blinding section does not print {needle:?}");
    }
    let published = render::published_figures();
    for (slug, v) in [("width", 63), ("search", 62), ("search-quantum", 31)] {
        assert!(
            published.iter().any(|(l, s, x)| l == "blinding" && s == slug && *x == v),
            "published figures lack `blinding {slug} {v}`"
        );
    }
}

#[test]
fn the_prose_gate_holds_a_blinding_figure_to_the_computed_line() {
    let published = prose::parse_published(&render::document());
    let ok = [
        "only the note's 63-bit blinding keeps the two apart",
        "behind a 63-bit blinding per note that a quantum search would need",
        "l'aveuglement de 63 bits de la note",
        "the blinding costs 62 bits of classical search",
        "the blinding holds 31 bits against a quantum search",
    ];
    for line in ok {
        let hits = prose::scan_text("x.md", line);
        assert_eq!(hits.len(), 1, "{line:?}");
        assert!(hits[0].families.contains(&Family::Blinding), "{line:?}: {:?}", hits[0].families);
        assert!(prose::hit_matches(&hits[0], &published), "{line:?} should match the blinding line");
    }
    let wrong = [
        "only the note's 64-bit blinding keeps the two apart",
        "the blinding holds 62 bits against a quantum search",
        "the blinding costs 31 bits of classical search",
    ];
    for line in wrong {
        let hits = prose::scan_text("x.md", line);
        assert!(!prose::hit_matches(&hits[0], &published), "{line:?} must not match");
    }
    // the blinding word must be near the figure, not merely on its line
    let far = "the note blinding is derived from the seed, and separately each unopened leaf carries 2 x width x 63 bits of min-entropy";
    let hits = prose::scan_text("x.md", far);
    assert_eq!(hits.len(), 1);
    assert!(!hits[0].families.contains(&Family::Blinding), "{far:?}: {:?}", hits[0].families);
    assert!(!prose::hit_matches(&hits[0], &published), "{far:?} must not borrow the blinding line");
}
