//! Audit v1 close-out, lane L5 (2026-09-23): the public claims of README.md,
//! docs/HACKATHON.md and docs/zk-simulation-argument.md held against the code
//! and against what the audit measured.
//!
//! One test per finding, each written red on the tree the audit left:
//!
//! * HYGIENE-LICENSE: README.md linked `LICENSE-MIT-UNTIL-beaa87ba`, a file
//!   that does not exist (the MIT text is `LICENSE-MIT-BEFORE-POLYFORM`).
//! * F47: README.md counted WOTS+ (Winternitz) as shipped quantum protection,
//!   while no program under `programs/` verifies WOTS+ (the vault that did was
//!   closed on 2026-09-13).
//! * F46: README.md's zkSPL section announced hidden balances without saying
//!   that `prove_balance` never checks its threshold and `withdraw` binds no
//!   conservation (`programs/p01_zkspl/src/instructions/`).
//! * F60: README.md said a passphrase closes retroactive derivation, and no
//!   screen of the web app sets one.
//! * F15/F51: the README double-spend row must keep the F2 caveat.
//! * F69: the simulation argument treats the next-row trace values as values
//!   "nobody publishes"; every proof publishes them, Merkle-checked against
//!   the trace root (`programs/p01_stark_verifier/src/verify.rs`, the next-row
//!   pair check), and with them anyone evaluates the per-row quotient identity
//!   the simulator of §2 ignores. `stark/tests/next_row_openings_are_published.rs`
//!   measures that on real proofs; this file holds the prose to it.
//! * F22, F48, F49, F65: docs/HACKATHON.md credited a KEM to the web
//!   withdrawal, listed the relayer as on the product path without saying no
//!   node runs it, left out what Tx-Opacity C and E do not close, printed
//!   figures measured on blob 0ad6d7f1 next to blob d5583d41, and said
//!   "post-quantum" without the Ed25519-derived-key caveat.
//!
//! No "N bits" figure is written by these checks; `tests/prose.rs` keeps the
//! ledger of those.

use std::fs;
use std::path::Path;

use p01_security_levels::repo_root;

fn read(rel: &str) -> String {
    fs::read_to_string(repo_root().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}")).replace("\r\n", "\n")
}

/// A paragraph is a run of non-empty lines; a markdown table row stands alone.
fn paragraphs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        let row = line.trim_start().starts_with('|');
        if line.trim().is_empty() || row {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            if row {
                out.push(line.to_string());
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

fn any_rs_mentions(dir: &Path, needle: &str) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if name != "target" && name != "node_modules" && any_rs_mentions(&p, needle) {
                return true;
            }
        } else if name.ends_with(".rs")
            && fs::read_to_string(&p).map(|t| t.to_ascii_lowercase().contains(needle)).unwrap_or(false)
        {
            return true;
        }
    }
    false
}

/// Relative link targets in markdown (`](./x)`, `](x)`) and HTML (`href="./x"`),
/// anchors dropped; absolute URLs and pure anchors skipped.
fn relative_links(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |raw: &str| {
        let t = raw.split('#').next().unwrap_or("").trim();
        if t.is_empty() || t.contains("://") || t.starts_with("mailto:") || t.contains(' ') {
            return;
        }
        out.push(t.to_string());
    };
    let mut rest = text;
    while let Some(i) = rest.find("](") {
        let tail = &rest[i + 2..];
        if let Some(j) = tail.find(')') {
            push(&tail[..j]);
        }
        rest = tail;
    }
    let mut rest = text;
    while let Some(i) = rest.find("href=\"") {
        let tail = &rest[i + 6..];
        if let Some(j) = tail.find('"') {
            push(&tail[..j]);
        }
        rest = tail;
    }
    out
}

fn fenced_block_after(text: &str, marker: &str) -> String {
    let start = text.find(marker).unwrap_or_else(|| panic!("no block containing {marker:?}"));
    let block = &text[start..];
    block[..block.find("```").expect("the diagram is a fenced block")].to_string()
}

/// The web withdrawal's payout derivation, as `readme_claims.rs` reads it.
fn web_payout_uses_a_kem() -> bool {
    let src = read("apps/web/lib/privacy/shieldClient.ts");
    let start = src.find("export function derivePoolPayoutKeypair(").expect("derivePoolPayoutKeypair is exported");
    let rest = &src[start..];
    let body = &rest[..rest.find("\n}").expect("the function closes at column 0")];
    assert!(body.contains("hkdf("), "derivePoolPayoutKeypair no longer uses HKDF; re-read it and update this test");
    let lower = body.to_lowercase();
    ["ml_kem", "mlkem", "ml-kem", "x25519", "kyber"].iter().any(|k| lower.contains(k))
}

// ── README.md ────────────────────────────────────────────────────────────────

#[test]
fn every_relative_link_in_the_readme_and_the_evaluator_guide_resolves() {
    let root = repo_root();
    let mut missing = Vec::new();
    for (doc, base) in [("README.md", root.clone()), ("docs/HACKATHON.md", root.join("docs"))] {
        for link in relative_links(&read(doc)) {
            if !base.join(&link).exists() {
                missing.push(format!("{doc}: {link}"));
            }
        }
    }
    assert!(missing.is_empty(), "relative links to files that do not exist:\n  {}", missing.join("\n  "));
}

#[test]
fn the_readme_does_not_count_wots_as_shipped_quantum_protection() {
    if any_rs_mentions(&repo_root().join("programs"), "wots") {
        return; // a program verifies WOTS+ again: the claim may be true
    }
    for para in paragraphs(&read("README.md")) {
        let lower = para.to_lowercase();
        if lower.contains("wots") || lower.contains("winternitz") {
            assert!(
                ["closed", "removed", "no program verifies", "not verified"].iter().any(|w| lower.contains(w)),
                "README.md credits WOTS+ without saying that no program under programs/ verifies it \
                 (the vault that did was closed on 2026-09-13):\n{}",
                para.trim()
            );
        }
    }
}

#[test]
fn the_readme_zkspl_section_says_threshold_and_conservation_are_not_enforced() {
    let text = read("README.md");
    let start = text.find("### zkSPL").expect("README.md keeps its zkSPL section");
    let section = &text[start..];
    let section = &section[..section[4..].find("\n### ").map(|i| i + 4).unwrap_or(section.len())];
    let lower = section.to_lowercase();
    for needle in ["not deployed", "threshold", "conservation", "not enforced", "any amount"] {
        assert!(
            lower.contains(needle),
            "README.md zkSPL section must say {needle:?}: prove_balance.rs never checks its threshold and \
             withdraw.rs binds no conservation (finding F46):\n{section}"
        );
    }
}

#[test]
fn the_readme_passphrase_claim_says_no_screen_sets_one() {
    let ui_sets_passphrase = ["apps/web/components", "apps/web/app"].iter().any(|d| {
        fn walk(p: &Path) -> bool {
            let Ok(entries) = fs::read_dir(p) else { return false };
            entries.flatten().any(|e| {
                let p = e.path();
                if p.is_dir() {
                    return walk(&p);
                }
                let name = e.file_name().to_string_lossy().to_string();
                (name.ends_with(".tsx") || name.ends_with(".ts"))
                    && !name.contains(".test.")
                    && fs::read_to_string(&p)
                        .map(|t| {
                            ["setPassphrase", "assertPassphraseAcceptable", "MIN_PASSPHRASE_CHARS", "passphrase:"]
                                .iter()
                                .any(|k| t.contains(k))
                        })
                        .unwrap_or(false)
            })
        }
        walk(&repo_root().join(d))
    });
    if ui_sets_passphrase {
        return;
    }
    for para in paragraphs(&read("README.md")) {
        let lower = para.to_lowercase();
        if lower.contains("passphrase") {
            assert!(
                lower.contains("no screen") || lower.contains("no interface"),
                "README.md presents the pool passphrase as a protection, and no screen of the web app sets one \
                 (finding F60):\n{}",
                para.trim()
            );
        }
    }
}

#[test]
fn the_readme_double_spend_row_keeps_the_f2_caveat() {
    let text = read("README.md");
    let row = text.lines().find(|l| l.starts_with("| Double-spend |")).expect("README.md keeps its Double-spend row");
    assert!(
        row.contains("not guaranteed") && row.contains("F2") && row.contains("docs/SECURITY-LEVELS.md"),
        "the Double-spend row must say one deposit spent twice is not guaranteed against in v1 (F2):\n{row}"
    );
    for para in paragraphs(&text) {
        let lower = para.to_lowercase();
        if (lower.contains("double-spend") || lower.contains("double spend")) && lower.contains("impossible") {
            panic!("README.md calls a double spend impossible:\n{}", para.trim());
        }
    }
}

/// The hiding claim, wherever these documents make it, must carry F69: the
/// simulation argument does not hold as written, because the next-row
/// openings it treats as unpublished are published.
fn assert_simulation_claims_carry_f69(doc: &str) {
    for para in paragraphs(&read(doc)) {
        let lower = para.to_lowercase();
        let about_simulation = lower.contains("zk-simulation-argument") || lower.contains("simulator");
        if about_simulation {
            assert!(
                lower.contains("next-row"),
                "{doc}: a paragraph about the simulation argument does not say that the next-row openings are \
                 published (finding F69):\n{}",
                para.trim()
            );
        }
        assert!(
            !lower.contains("statistical hiding in the random-oracle model")
                && !lower.contains("hiding argument is statistical"),
            "{doc}: states statistical hiding as established; the simulation argument behind it does not hold as \
             written (finding F69):\n{}",
            para.trim()
        );
    }
}

#[test]
fn the_readme_hiding_claim_carries_the_next_row_finding() {
    assert_simulation_claims_carry_f69("README.md");
}

// ── docs/zk-simulation-argument.md ──────────────────────────────────────────

#[test]
fn the_simulation_argument_does_not_treat_published_next_row_values_as_hidden() {
    let doc = read("docs/zk-simulation-argument.md");
    let lower = doc.to_lowercase();
    assert!(
        !lower.contains("nobody publishes"),
        "docs/zk-simulation-argument.md still calls the next-row values unpublished; every proof carries them, \
         Merkle-checked against the trace root (finding F69)"
    );
    let para = paragraphs(&doc)
        .into_iter()
        .find(|p| {
            let l = p.to_lowercase();
            l.contains("next-row") && l.contains("published") && l.contains("merkle") && l.contains("distinguish")
        })
        .expect("docs/zk-simulation-argument.md must say that the next-row openings are published and Merkle-checked, and that they distinguish the simulator of section 2");
    assert!(para.contains("next_row_openings_are_published"), "that paragraph must name the test that measures it:\n{para}");
    for p in paragraphs(&doc) {
        let l = p.to_lowercase();
        if l.contains("zero-knowledge") || l.contains("zero knowledge") {
            assert!(
                ["not claimed", "does not hold", "withdrawn", "not used"].iter().any(|w| l.contains(w)),
                "docs/zk-simulation-argument.md claims zero-knowledge:\n{}",
                p.trim()
            );
        }
    }
}

// ── docs/HACKATHON.md ───────────────────────────────────────────────────────

#[test]
fn the_evaluator_guide_diagram_does_not_credit_a_kem_to_the_web_withdrawal() {
    if web_payout_uses_a_kem() {
        return;
    }
    let block = fenced_block_after(&read("docs/HACKATHON.md"), "User generates a STARK proof");
    for line in block.lines() {
        let l = line.to_lowercase();
        assert!(
            !(l.contains("ml-kem") || l.contains("x25519")),
            "docs/HACKATHON.md: the withdrawal leg credits a KEM, but derivePoolPayoutKeypair is HKDF over an Ed25519 \
             wallet signature (finding F22):\n  {}",
            line.trim()
        );
    }
    assert!(block.contains("HKDF") && block.contains("Ed25519"), "the diagram should say what the payout address derives from:\n{block}");
}

fn tldr(doc: &str) -> String {
    let start = doc.find("## TL;DR").expect("HACKATHON.md keeps its TL;DR");
    let rest = &doc[start..];
    rest[..rest.find("\n---").unwrap_or(rest.len())].to_string()
}

#[test]
fn the_evaluator_guide_post_quantum_lines_carry_the_ed25519_caveat() {
    for line in tldr(&read("docs/HACKATHON.md")).lines() {
        if line.to_lowercase().contains("post-quantum") {
            assert!(
                line.contains("Ed25519"),
                "docs/HACKATHON.md TL;DR says post-quantum without saying the ML-KEM keys are re-derived from the \
                 Ed25519 wallet key (finding F65):\n  {line}"
            );
        }
    }
}

/// F65, second pass: the TL;DR stealth line must name where the key-exchange
/// keys really come from on each path, and must not rest on a Shor
/// re-derivation. The SDK derives the stealth ML-KEM seed from the mnemonic
/// seed (`packages/specter-sdk/src/wallet/create.ts`, `deriveKemSeed`); only
/// the web note-encryption keys (`deriveNoteEncryptionKeys` over `walletSeed`)
/// come from one Ed25519 wallet signature. Shor on the public key yields the
/// scalar, not the RFC 8032 nonce prefix, so reproducing that signature is not
/// established: the claim that holds is "only as safe as that wallet secret".
#[test]
fn the_evaluator_guide_stealth_line_names_each_key_origin_without_a_shor_rederivation() {
    let mut checked = 0;
    for line in tldr(&read("docs/HACKATHON.md")).lines() {
        let low = line.to_lowercase();
        if !(low.contains("stealth") && low.contains("post-quantum")) {
            continue;
        }
        checked += 1;
        let shor_rederives = low.contains("shor") && (low.contains("re-derives") || low.contains("re-derive them"));
        assert!(
            !shor_rederives,
            "docs/HACKATHON.md TL;DR says a Shor adversary re-derives the ML-KEM keys; Shor gives the Ed25519 \
             scalar, not the RFC 8032 nonce prefix, so that is not established (finding F65):\n  {line}"
        );
        assert!(
            low.contains("mnemonic") && low.contains("signature") && low.contains("only as safe as"),
            "docs/HACKATHON.md TL;DR must say the stealth ML-KEM seed comes from the mnemonic seed (SDK), the web \
             note-encryption keys from one Ed25519 wallet signature, and that the keys are only as safe as that \
             wallet secret (finding F65):\n  {line}"
        );
    }
    assert!(checked > 0, "the check found no stealth post-quantum line in the TL;DR; the doc's wording moved");
}

#[test]
fn the_evaluator_guide_labels_figures_measured_on_the_previous_blob() {
    let doc = read("docs/HACKATHON.md");
    for (n, line) in doc.lines().enumerate() {
        for measured in ["18.6 s", "23.0 s", "20.8 s", "890,643 CU"] {
            if line.contains(measured) {
                assert!(
                    line.contains("0ad6d7f1"),
                    "docs/HACKATHON.md:{}: {measured} was measured on 2026-09-12 with blob 0ad6d7f1, not with the \
                     shipped d5583d41, and the line does not say so (finding F49):\n  {}",
                    n + 1,
                    line.trim()
                );
            }
        }
    }
}

#[test]
fn the_evaluator_guide_does_not_present_tx_opacity_closures_that_do_not_hold() {
    let doc = read("docs/HACKATHON.md");
    for line in tldr(&doc).lines() {
        if line.contains("relayer") {
            assert!(
                line.contains("no node"),
                "docs/HACKATHON.md TL;DR lists the relayer without saying no node operates it, so every spend is \
                 submitted by the spender (finding F48, Tx-Opacity A):\n  {line}"
            );
        }
    }
    let lower = doc.to_lowercase();
    assert!(
        lower.contains("does not pad") && lower.contains("proof length"),
        "docs/HACKATHON.md must say the web client does not pad proofs, so proof length and circuit are visible \
         (finding F48, Tx-Opacity C)"
    );
    assert!(
        lower.contains("lamport delta"),
        "docs/HACKATHON.md must say the payee's lamport delta shows the denomination (finding F48, Tx-Opacity E)"
    );
}

#[test]
fn the_evaluator_guide_hiding_claim_carries_the_next_row_finding() {
    assert_simulation_claims_carry_f69("docs/HACKATHON.md");
}

/// F65 in docs/quantum-resistance.md: a line that calls stealth payments
/// post-quantum (safe, or "hybrid post-quantum") must say that the stealth
/// keys are themselves re-derived from the Ed25519 wallet key. In the web app
/// and the extension, `deriveNoteEncryptionKeys` (noteCrypto.ts) takes the
/// X25519 and ML-KEM-768 keys by HKDF from a seed that is one Ed25519 wallet
/// signature (web) or the Ed25519 secret key (extension), and the SDK derives
/// its stealth ML-KEM seed from the mnemonic seed, so those keys are only as
/// safe as that wallet secret. (Whether a Shor adversary, who gets the scalar
/// but not the RFC 8032 nonce prefix, can reproduce the signature is not
/// established, so this check does not rest on it.) Naming Ed25519 as the key
/// that "authorizes" operations is not that caveat.
#[test]
fn the_quantum_resistance_stealth_claims_name_the_ed25519_derivation() {
    let doc = read("docs/quantum-resistance.md");
    let mut checked = 0;
    for line in doc.lines() {
        let low = line.to_lowercase();
        let claims_pq = low.contains("post-quantum safe")
            || low.contains("post-quantum-safe")
            || low.contains("hybrid post-quantum");
        if !(low.contains("stealth") && claims_pq) {
            continue;
        }
        checked += 1;
        let names_derivation = low.contains("ed25519")
            && (low.contains("re-derive") || low.contains("rederive") || low.contains("derived from"));
        assert!(
            names_derivation,
            "docs/quantum-resistance.md calls stealth payments post-quantum without saying their X25519 + ML-KEM-768 \
             keys are re-derived from the Ed25519 wallet key (finding F65; README.md says so):\n  {line}"
        );
    }
    assert!(checked > 0, "the check found no stealth post-quantum line to hold; the doc's wording moved");
}
