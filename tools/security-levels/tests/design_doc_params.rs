//! Parameter rows and hash ratings in two public documents, checked against the
//! verifier's own numbers.
//!
//! `tests/prose.rs` checks every "N bits" figure, but not a parameter row: a
//! design document could say "27 queries" on a circuit the verifier runs at 22,
//! or "16 coefficients, degree bound 1" where the verifier uses 32 and 2, and the
//! prose gate stayed green. That is what `docs/_sections/06-proof-system.html`
//! said about C0, C4 and C7 until audit v1 round 2 (fix lane 3). The table
//! there is what a reviewer uses to recompute soundness, so it is read here
//! from the same `CircuitConfig` constants the calculator compiles
//! (`params::v1_circuits`), circuit by circuit.
//!
//! `docs/quantum-resistance.md` is a dated archive, but it is public, and its
//! scorecard rated the pool commitments and Merkle trees SAFE at "~85-bit
//! quantum collision resistance", a figure of the retired BN254 tree. The v1
//! digest is one Goldilocks element, and its collision line is whatever
//! `docs/SECURITY-LEVELS.md` publishes (finding F2). It also rated the WOTS+
//! stealth-claim signature SAFE while no program verifies WOTS+.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use p01_security_levels::{params, repo_root, DOC_PATH};

const PROOF_SYSTEM_SECTION: &str = "docs/_sections/06-proof-system.html";
const QUANTUM_DOC: &str = "docs/quantum-resistance.md";

fn read(rel: &str) -> String {
    let p = repo_root().join(rel);
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("{rel}: {e}")).replace("\r\n", "\n")
}

/// HTML to plain text: tags dropped, the entities the section files use
/// decoded, whitespace collapsed.
fn html_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&#8209;", "-")
        .replace("&nbsp;", " ")
        .replace("&middot;", "·")
        .replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The value cell of the parameter-table row labelled `label`.
fn table_row(html: &str, label: &str) -> String {
    let open = format!("<tr><td>{label}</td><td>");
    let start = html
        .find(&open)
        .unwrap_or_else(|| panic!("{PROOF_SYSTEM_SECTION}: no parameter row labelled {label:?}"))
        + open.len();
    let end = html[start..].find("</td>").map(|e| start + e).expect("the row's value cell closes");
    html_text(&html[start..end])
}

fn integers(s: &str) -> Vec<usize> {
    s.split(|c: char| !c.is_ascii_digit()).filter(|t| !t.is_empty()).map(|t| t.parse().unwrap()).collect()
}

/// The circuits a clause is about: the list after "on circuits", or every
/// circuit when the clause names none (a value stated once for all of them).
fn clause_circuits(clause: &str, all: &[u8]) -> Vec<u8> {
    match clause.find("on circuits ") {
        None => all.to_vec(),
        Some(i) => clause[i + "on circuits ".len()..]
            .replace(" and ", ", ")
            .split(',')
            .map(|t| t.trim())
            .map(|t| t.parse::<u8>().unwrap_or_else(|_| panic!("not a circuit number: {t:?} in {clause:?}")))
            .collect(),
    }
}

fn insert_once<V: std::fmt::Debug>(map: &mut BTreeMap<u8, V>, id: u8, v: V, row: &str) {
    if let Some(prev) = map.insert(id, v) {
        panic!("{PROOF_SYSTEM_SECTION}: the {row} row states circuit {id} twice (first {prev:?})");
    }
}

struct Verifier {
    ids: Vec<u8>,
    blowup: usize,
    arity: usize,
    grinding: u32,
    final_poly: BTreeMap<u8, (usize, usize)>,
    queries: BTreeMap<u8, usize>,
}

fn verifier() -> Verifier {
    let v1 = params::v1_circuits();
    let id = |p: &params::StarkParams| p.label.trim_start_matches('C').parse::<u8>().unwrap();
    let blowups: Vec<usize> = v1.iter().map(|p| p.lde_size / p.trace_length).collect();
    assert!(blowups.windows(2).all(|w| w[0] == w[1]), "the blowup differs across circuits; the table's one-value row no longer fits: {blowups:?}");
    Verifier {
        ids: v1.iter().map(id).collect(),
        blowup: blowups[0],
        arity: v1[0].fri_folding_arity,
        grinding: v1[0].grinding_bits,
        final_poly: v1.iter().map(|p| (id(p), (p.fri_final_poly_size, p.fri_final_poly_degree_bound))).collect(),
        queries: v1.iter().map(|p| (id(p), p.num_queries)).collect(),
    }
}

#[test]
fn the_proof_system_section_states_the_verifiers_fri_terminal_polynomial_per_circuit() {
    let v = verifier();
    let row = table_row(&read(PROOF_SYSTEM_SECTION), "FRI");

    assert!(row.contains(&format!("Blowup {}", v.blowup)), "FRI row {row:?}: the verifier's blowup is {}", v.blowup);
    assert!(row.contains(&format!("fold factor {}", v.arity)), "FRI row {row:?}: the verifier folds by {}", v.arity);

    let mut doc: BTreeMap<u8, (usize, usize)> = BTreeMap::new();
    for clause in row.split(|c| c == ';' || c == '.').filter(|c| c.contains("coefficients")) {
        let size = *integers(&clause[..clause.find("coefficients").unwrap()]).last().expect("a coefficient count");
        let after = clause.find("degree bound ").map(|i| &clause[i + "degree bound ".len()..]).expect("a degree bound");
        let bound = integers(after)[0];
        for id in clause_circuits(clause, &v.ids) {
            insert_once(&mut doc, id, (size, bound), "FRI");
        }
    }
    assert_eq!(
        doc, v.final_poly,
        "FRI row {row:?}: (terminal coefficients, degree bound) per circuit, document left, verifier (compact_proof.rs) right"
    );
}

#[test]
fn the_proof_system_section_states_the_verifiers_query_count_per_circuit_and_its_grinding() {
    let v = verifier();
    let row = table_row(&read(PROOF_SYSTEM_SECTION), "Queries");

    let mut doc: BTreeMap<u8, usize> = BTreeMap::new();
    let mut grinding = None;
    for clause in row.split(';').map(str::trim) {
        if clause.contains("bits of grinding") {
            grinding = Some(integers(clause)[0] as u32);
        } else if clause.contains("on circuits") {
            let q = integers(&clause[..clause.find("on circuits").unwrap()])[0];
            for id in clause_circuits(clause, &v.ids) {
                insert_once(&mut doc, id, q, "Queries");
            }
        }
    }
    assert_eq!(doc, v.queries, "Queries row {row:?}: queries per circuit, document left, verifier (compact_proof.rs) right");
    assert_eq!(grinding, Some(v.grinding), "Queries row {row:?}: GRINDING_BITS is {}", v.grinding);
}

#[test]
fn the_proof_system_section_does_not_deny_master_the_features_master_has() {
    // The section was written when the leaf/node tags, the terminal degree
    // bound and the coset shift lived only on `b7-drop-aligned-checks`. The
    // verifier source in this tree carries all three, and this tree is what
    // master holds, so "Master has no ..." is false.
    let root = repo_root();
    let merkle = fs::read_to_string(root.join("programs/p01_stark_verifier/src/merkle.rs")).unwrap();
    let verify = fs::read_to_string(root.join("programs/p01_stark_verifier/src/verify.rs")).unwrap();
    let text = html_text(&read(PROOF_SYSTEM_SECTION));

    assert!(merkle.contains("pub const MERKLE_LEAF_TAG: u8 = 0x00;") && merkle.contains("pub const MERKLE_NODE_TAG: u8 = 0x01;"));
    assert!(text.contains("leaf tag 0x00, node tag 0x01"), "the section must state the verifier's tags");
    assert!(verify.contains("pub const LDE_COSET_SHIFT: u64 = 7;"));
    assert!(text.contains("h = 7"), "the section must state the verifier's coset shift");
    assert!(
        !text.contains("Master has no") && !text.contains("not from master"),
        "{PROOF_SYSTEM_SECTION}: it says master lacks features the verifier source in this tree has"
    );
}

fn cells(line: &str) -> Vec<String> {
    line.trim().trim_matches('|').split('|').map(|c| c.trim().replace("**", "")).collect()
}

fn scorecard_row(doc: &str, component: &str) -> Vec<String> {
    doc.lines()
        .find(|l| l.starts_with('|') && cells(l).first().map(String::as_str) == Some(component))
        .map(cells)
        .unwrap_or_else(|| panic!("{QUANTUM_DOC}: no scorecard row {component:?}"))
}

/// Classical and quantum collision figures of the v1 digest, as the calculator
/// publishes them (`tests/generated_doc.rs` pins that file to the calculator).
fn v1_digest_collision() -> (String, String) {
    let levels = read(DOC_PATH);
    let line = levels
        .lines()
        .find(|l| l.starts_with("| Poseidon t=3, one Goldilocks element (v1) |"))
        .expect("SECURITY-LEVELS.md publishes the v1 digest line");
    let c = cells(line);
    (c[c.len() - 2].clone(), c[c.len() - 1].clone())
}

#[test]
fn the_quantum_scorecard_rates_the_v1_pool_digest_by_the_calculator_not_by_the_retired_bn254_tree() {
    let doc = read(QUANTUM_DOC);
    let (classical, quantum) = v1_digest_collision();
    for component in ["Commitments (shielded pool)", "Merkle trees"] {
        let row = scorecard_row(&doc, component);
        let status = &row[2];
        assert!(!status.starts_with("SAFE"), "{QUANTUM_DOC}: {component:?} is rated {status:?}; the v1 digest collides at {classical} bits classical, {quantum} quantum (finding F2)");
        let joined = row.join(" | ");
        assert!(
            joined.contains(&classical) && joined.contains(&quantum),
            "{QUANTUM_DOC}: {component:?} must quote the v1 digest line ({classical} classical, {quantum} quantum): {joined:?}"
        );
        assert!(!joined.contains("85-bit"), "{QUANTUM_DOC}: {component:?} still quotes the BN254 figure: {joined:?}");
    }
    for (n, line) in doc.lines().enumerate() {
        if line.contains("Poseidon") && line.contains("85-bit") {
            assert!(
                line.contains("BN254") && line.contains("retired"),
                "{QUANTUM_DOC}:{}: a Poseidon ~85-bit figure not marked as the retired BN254 tree: {line}",
                n + 1
            );
        }
    }
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

#[test]
fn the_quantum_scorecard_does_not_rate_an_unverified_wots_claim_safe() {
    let doc = read(QUANTUM_DOC);
    let row = scorecard_row(&doc, "Stealth claim signature (SDK)");
    if !any_rs_mentions(&repo_root().join("programs"), "wots") {
        assert!(
            !row[2].contains("SAFE"),
            "{QUANTUM_DOC}: the WOTS+ stealth claim is rated {:?}, but no program under programs/ verifies WOTS+, so a claim is authorised by Ed25519 alone",
            row[2]
        );
    }
}

// ── audit v1 close-out, lane L5 (2026-09-23): pages 07 and 18, and the
// assembled document. Findings F20, F21 and F26 fixed page 06 and left these:
// page 07 said every terminal polynomial is rejected "above 1 of 16
// coefficients" (circuits 0, 4 and 7 run 2 of 32), sent the reader to a branch
// for a test file master carries, and quoted the pre-mask 47.75 to 52.53 floor;
// page 18 still called blob 0ad6d7f1 the one on master; and
// `docs/protocol-01-design-document.html`, from which the served PDF is
// printed, no longer matched its section files.

const SOUNDNESS_SECTION: &str = "docs/_sections/07-soundness.html";
const VERIFY_SECTION: &str = "docs/_sections/18-verify.html";
const ASSEMBLED: &str = "docs/protocol-01-design-document.html";

#[test]
fn the_soundness_page_states_each_circuits_terminal_bound_and_no_single_one() {
    let v = verifier();
    let text = html_text(&read(SOUNDNESS_SECTION));
    // group circuits by (bound, size) as the verifier has them
    let mut groups: BTreeMap<(usize, usize), Vec<u8>> = BTreeMap::new();
    for (id, (size, bound)) in &v.final_poly {
        groups.entry((*bound, *size)).or_default().push(*id);
    }
    if groups.len() > 1 {
        assert!(
            !text.contains("any terminal polynomial above 1 of 16 coefficients"),
            "{SOUNDNESS_SECTION}: states one terminal bound for every circuit; the verifier has {groups:?}"
        );
    }
    for ((bound, size), ids) in &groups {
        let names: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
        let list = match names.as_slice() {
            [one] => one.clone(),
            [init @ .., last] => format!("{} and {last}", init.join(", ")),
            [] => unreachable!(),
        };
        let needle = format!("{bound} of {size} coefficients on circuits {list}");
        assert!(text.contains(&needle), "{SOUNDNESS_SECTION}: expected {needle:?} (compact_proof.rs), page reads:\n{text}");
    }
}

#[test]
fn the_soundness_page_does_not_send_the_reader_to_a_branch_for_a_file_master_has() {
    let text = html_text(&read(SOUNDNESS_SECTION));
    let on_master = repo_root().join("programs/p01_stark_verifier/tests/b1_deep_binding.rs").is_file();
    if on_master {
        assert!(
            !text.contains("not on master"),
            "{SOUNDNESS_SECTION}: says b1_deep_binding.rs is not on master; this tree carries it"
        );
    }
    for stale in ["47.75 to 52.53", "[52,50,50,47,48,47,47]", "[46,46,46,42,46,42,42]", "809,662"] {
        assert!(!text.contains(stale), "{SOUNDNESS_SECTION}: still quotes {stale:?}, a figure of a retired deployment");
    }
}

/// The digest prefix of the blob the repository ships, read from the record
/// the deployed-verifier gate holds (`accepts_client_blob_sha256`).
fn shipped_blob_prefix() -> String {
    let rec = read("packages/stark-prover/deployed-verifier.json");
    let key = "\"accepts_client_blob_sha256\"";
    let i = rec.find(key).expect("deployed-verifier.json records the accepted client blob");
    let rest = &rec[i + key.len()..];
    let q = rest.find('"').expect("a quoted digest") + 1;
    rest[q..q + 8].to_string()
}

#[test]
fn the_how_to_check_page_names_the_blob_master_ships() {
    let blob = shipped_blob_prefix();
    let text = html_text(&read(VERIFY_SECTION));
    assert!(text.contains(&blob), "{VERIFY_SECTION}: does not name the shipped blob {blob}");
    assert!(
        !text.contains("On master since 12 September 2026: 265,324 bytes"),
        "{VERIFY_SECTION}: still says blob 0ad6d7f1 is the one on master; master ships {blob}"
    );
}

#[test]
fn the_assembled_design_document_is_its_section_files() {
    let assembled = read(ASSEMBLED);
    let dir = repo_root().join("docs/_sections");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .expect("docs/_sections")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".html"))
        .collect();
    names.sort();
    let mut stale = Vec::new();
    let mut at = 0usize;
    for n in &names {
        let body = read(&format!("docs/_sections/{n}"));
        let body = body.trim();
        match assembled[at..].find(body) {
            Some(i) => at += i + body.len(),
            None => stale.push(n.clone()),
        }
    }
    assert!(
        stale.is_empty(),
        "{ASSEMBLED} does not carry these section files as they are (in order): {stale:?}; run \
         `node docs/_assemble-design-doc.mjs`, then `node scripts/render-docs-pdf.mjs design`"
    );
}
