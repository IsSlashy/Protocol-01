//! The prose test: every "N bit(s)" figure in README.md, docs/**,
//! apps/web/i18n/** and apps/web/app/**, whatever its context, must be a
//! figure the generated document publishes FOR THE REGIME THE SENTENCE NAMES
//! AND FOR EVERY CIRCUIT IT IS ABOUT, or be listed in
//! `tools/security-levels/prose-ledger.tsv` with its kind and reason, by a row
//! whose snippet contains the figure. Binary exports (PDF, PPTX) are not read;
//! each must have a scanned text source of the same stem, or be listed in
//! `prose::UNSCANNED_EXPORTS`.
//!
//! The ledger's `stale` rows are findings: figures that are wrong today and
//! are left for Phase 1 (this run does not edit README, docs or i18n). A row
//! that no longer covers a figure fails, and both the number of figures
//! `stale` rows cover and the set of `stale` rows are pinned exactly, so a
//! finding cannot move or disappear without an edit of this file.

use std::fs;

use p01_security_levels::prose::{self, Family, LedgerKind};
use p01_security_levels::{repo_root, DOC_PATH};

/// The number of stale figures: exact, not a cap (fix round 2; with a `<=`
/// cap, fixing one stale figure while adding another stayed green).
///
/// Lower it, and delete the row, when Phase 1 fixes a stale figure. Raising it,
/// or accepting a new stale row, needs the founder. History:
/// * 50 figures in 41 rows on 2026-09-18 (fix round 1, once every figure was
///   scanned);
/// * 55 in 42 rows after fix round 2, whose scanner reads five pre-existing
///   stale figures the old one could not see (a figure wrapped across a line
///   break, and the first figure of "124 / 104 bits" and "124 ou 104 bits",
///   twice each). That RAISE still awaits the founder's ratification
///   (V2-RUN.md, G-WP1-d); it is left in place here;
/// * 53 in 41 rows after fix round 3. Nothing was fixed and nothing was
///   hidden: `docs/stark-migration-assessment.md` is gitignored, a clean
///   checkout does not have it, and it left the scan with the other
///   `prose::LOCAL_ONLY_FILES` (G-WP1-b) taking its one stale row and its two
///   "127-bit conjectured" figures with it. They stay a finding in
///   `scratchpad/v2-run/WP1-REPORT.md` and in that file's entry;
/// * 50 in 38 rows after audit v1 round 1 (fix lane 2), which LOWERED it:
///   the three stale figures of `apps/web/app/parcours/page.tsx` (the field
///   floor "48 à 52", "47 à 52 bits sous conjecture", "42 à 46 bits
///   inconditionnellement") now quote the as-shipped floors, and their rows
///   are gone;
/// * 41 in 31 rows after audit v1 round 2 (fix lane 3), which LOWERED it by
///   nine: `docs/quantum-resistance.md` no longer rates the v1 pool's Poseidon
///   digest at the retired BN254 tree's "~85-bit" (six rows, seven figures,
///   gone; the digest line of the generated file is quoted instead), the
///   SHA-256 quantum collision claim above its 85.33 line is gone, and the
///   BN254 row of its Grover table is labelled retired on its line (one row,
///   two figures, relabelled historical). `tests/design_doc_params.rs` holds
///   those lines.
/// * 29 in 20 rows after the audit v1 close-out (lane L5, 2026-09-23), which
///   LOWERED it by twelve, all by fixing the prose, none by relabelling: the
///   design document's soundness and quantum ranges ("the measured 42 to 46
///   bit", "to about 21 to 26 bits", "Soundness is 42 to 46 bits
///   unconditional", pages 16 and 18 and the assembled HTML: six rows, six
///   figures) now quote the as-shipped floors; `docs/zk-simulation-argument.md`
///   no longer states "42 to 52 bits" as current (one row, one figure);
///   `/parcours` (`data.ts`) quotes the calculator per regime (two rows, three
///   figures); and the grinding parameter ("16 bits of grinding", two rows,
///   two figures), fixed in en.ts by the audit's own round and in fr.ts by
///   the close-out's i18n lane, now reads 22 and is listed as verified. `tests/design_doc_params.rs` and
///   `apps/web/__tests__/lib/closeV1L5DocsPdf.test.ts` hold those lines. The
///   same round added 24 non-stale rows for the audit-era en.ts / fr.ts
///   figures (digest widths, the v1-digest collision line, the grinding
///   parameter) and dropped two not-a-level rows whose 63-bit blinding figures
///   now match the generated file's note-blinding line (finding F66).
const STALE_FIGURES: usize = 29;

/// FNV-1a (64-bit) of the ledger's stale rows as sorted "path<TAB>snippet"
/// lines joined by "\n": relabelling a stale row, or swapping it for another,
/// changes it even when the count does not move. Re-pinned by the audit v1
/// close-out (lane L5, 2026-09-23): eleven stale rows removed because their
/// lines were fixed (see `STALE_FIGURES`), none added, none relabelled; the
/// twenty left are all in dated or archived notes under `docs/`.
const STALE_ROWS_FNV1A: u64 = 0xce98_f5e0_6cb2_6253;

fn published() -> prose::Published {
    let doc = fs::read_to_string(repo_root().join(DOC_PATH)).unwrap_or_default();
    prose::parse_published(&doc)
}

fn ledger() -> Vec<prose::LedgerEntry> {
    let text = fs::read_to_string(repo_root().join(prose::LEDGER_PATH)).unwrap_or_default();
    prose::parse_ledger(&text).unwrap_or_else(|e| panic!("{}: {e}", prose::LEDGER_PATH))
}

// ── positive and negative controls for the scanner itself ────────────────────

fn lows(line: &str) -> Vec<(f64, f64)> {
    prose::figures_in_line(line).iter().map(|f| (f.low, f.high)).collect()
}

#[test]
fn the_scanner_reads_figures_ranges_and_their_context() {
    assert_eq!(lows("The spend proof has 47 bits conjectured."), [(47.0, 47.0)]);
    assert_eq!(lows("Soundness is 42 to 46 bits unconditional"), [(42.0, 46.0)]);
    assert_eq!(lows("47 à 52 bits sous conjecture"), [(47.0, 52.0)]);
    assert_eq!(lows("about 21 to 26 bits"), [(21.0, 26.0)]);
    assert_eq!(lows("| SHA-256 | 128-bit collision | ~85-bit collision (BHT) |"), [(128.0, 128.0), (85.0, 85.0)]);
    assert_eq!(lows("the floor is ~47.8 bits"), [(47.8, 47.8)]);
    assert_eq!(lows("log2(11) ≈ 3,5 bits"), [(3.5, 3.5)]);
    // not a figure at all
    assert!(lows("the bitmap has bitsets and a 3-bitten word").is_empty());

    assert!(prose::is_security_context("124-bit soundness, sha256-syscall hashing"));
    assert!(prose::is_security_context("Under Grover a forgery is a search"));
    assert!(!prose::is_security_context("a 64-bit field element and a 32-bit lane"));

    let fams = prose::families_in("47 bits conjectured, 42 unconditional, Johnson, Grover, collision");
    for f in [Family::Conjectured, Family::UniqueDecoding, Family::Johnson, Family::Quantum, Family::Collision] {
        assert!(fams.contains(&f), "missing {f:?} in {fams:?}");
    }
    assert!(prose::families_in("n\\u00e9 inconditionnellement").contains(&Family::UniqueDecoding));
}

#[test]
fn the_matcher_accepts_published_figures_and_nothing_else() {
    let doc = "<!-- published-figures:begin -->\n```text\nC7 unique-decoding 42\nC7 conjectured 46\nC1 unique-decoding 45\n```\n<!-- published-figures:end -->\n";
    let published = prose::parse_published(doc);
    assert!(published.0.contains(&(Family::UniqueDecoding, 42)));
    assert!(published.0.contains(&(Family::Conjectured, 46)));

    // `check` is what the repository test runs, on the whole hit
    let ok = |line: &str| {
        let hits = prose::scan_text("x.md", line);
        assert!(!hits.is_empty(), "no hit in {line:?}");
        prose::check(&hits, &published, &[]).matched == hits.len()
    };
    assert!(ok("C7 has 42 bits unconditional soundness."));
    assert!(
        !ok("Soundness is 42 bits unconditional."),
        "C1 publishes 45: a figure whose sentence names no circuit must hold for every circuit"
    );
    assert!(ok("Soundness is 42 to 45 bits unconditional."));
    assert!(!ok("Soundness is 42 to 46 bits unconditional."), "46 is not published");
    assert!(!ok("Soundness is 47 bits conjectured."), "47 is not published");
    assert!(!ok("Soundness is 46 bits unconditional."), "46 is published for the conjecture, not for unique decoding");
    assert!(!ok("We claim 124-bit soundness."), "no regime named, so nothing can match");

    // collision figures are keyed on the hash the sentence names
    let doc = "<!-- published-figures:begin -->\nsha256 collision 128\nsha256 collision-quantum 85\nv1-digest collision 32\nv1-digest collision-quantum 21\n<!-- published-figures:end -->";
    let published = prose::parse_published(doc);
    let ok = |line: &str| {
        let hits = prose::scan_text("x.md", line);
        assert!(!hits.is_empty(), "no hit in {line:?}");
        prose::check(&hits, &published, &[]).matched == hits.len()
    };
    assert!(ok("SHA-256 has 128-bit collision resistance"));
    assert!(ok("SHA-256 quantum collision resistance (BHT) is 85 bits"));
    assert!(ok("the v1 Poseidon leaf has 32-bit collision resistance"));
    assert!(!ok("Poseidon Merkle trees: ~85-bit quantum collision resistance"), "85 is SHA-256's, not Poseidon's");
    assert!(!ok("SHA-256 gives 128-bit security"), "a hash figure needs the word collision");
    assert!(!ok("SHA-256: higher post-quantum collision resistance at ~128 bits"), "128 is SHA-256's classical figure");
    // the hash must be named on the figure's own line, not borrowed from a neighbouring row
    let table = "| SHA-256 | 128-bit collision | 85-bit collision |\n| Poseidon (BN254) | ~127-bit collision | ~85-bit collision |";
    let rows = prose::scan_text("x.md", table);
    let row2: Vec<_> = rows.iter().filter(|h| h.line_no == 2).collect();
    assert_eq!(row2.len(), 2);
    assert!(row2.iter().all(|h| !prose::figure_matches(&h.figure, &h.families, &published)));
}

/// Round 1b (R2 of `verify-WP1-r1b-mutations.log`): "The spend circuit (C7)
/// has 42 bits unconditional soundness." passed, because C0, C3 and C4 publish
/// 42 and the matcher never looked at which circuit a sentence names. A figure
/// must now hold for EVERY circuit its sentence is about: the circuits it
/// names, or every v1 circuit when it names none. A range of figures must
/// cover each of those circuits' figures, and both ends must be published by
/// one of them.
#[test]
fn a_figure_must_hold_for_every_circuit_its_sentence_is_about() {
    let doc = "<!-- published-figures:begin -->\n```text\n\
               C0 unique-decoding 42\nC0 quantum-unique-decoding 21\n\
               C5 unique-decoding 41\nC5 quantum-unique-decoding 20\n\
               C6 unique-decoding 41\nC6 quantum-unique-decoding 20\n\
               C7 unique-decoding 41\nC7 quantum-unique-decoding 20\nC7 conjectured 46\n\
               ```\n<!-- published-figures:end -->\n";
    let published = prose::parse_published(doc);
    let matched = |text: &str| {
        let hits = prose::scan_text("x.md", text);
        assert!(!hits.is_empty(), "no hit in {text:?}");
        prose::check(&hits, &published, &[]).matched
    };
    // R2, the negative control: C0 publishes 42, C7 does not
    assert_eq!(matched("The spend circuit (C7) has 42 bits unconditional soundness."), 0, "C7 is at 41");
    assert_eq!(matched("The spend circuit (C7) has 41 bits unconditional soundness."), 1);
    assert_eq!(matched("C0 has 42 bits unconditional soundness."), 1);
    // the circuit's name from `params::v1_name`, followed by "circuit"
    assert_eq!(matched("The merkle_update circuit has 42 bits unconditional soundness."), 0, "C6 is at 41");
    assert_eq!(matched("The merkle_update circuit has 41 bits unconditional soundness."), 1);
    // an identifier with an underscore names its circuit on its own
    assert_eq!(matched("merkle_update: 42 bits unconditional soundness."), 0, "C6 is at 41");
    assert_eq!(matched("merkle_update: 41 bits unconditional soundness."), 1);
    // every circuit named, not any
    assert_eq!(matched("C0 and C7 have 42 bits unconditional soundness."), 0, "true of C0, false of C7");
    assert_eq!(matched("C6 and C7 have 41 bits unconditional soundness."), 1);
    assert_eq!(matched("C0 and C7 have 41 to 42 bits unconditional soundness."), 1);
    // a range of circuits names every circuit inside it
    assert_eq!(matched("C5–C7 have 41 bits unconditional soundness."), 1);
    assert_eq!(matched("C0-C7 have 41 to 42 bits unconditional soundness."), 0, "C1..C4 publish nothing here");
    // no circuit named: every circuit
    assert_eq!(matched("Soundness is 42 bits unconditional."), 0, "C5, C6 and C7 are at 41");
    assert_eq!(matched("Soundness is 41 to 42 bits unconditional."), 1);
    assert_eq!(matched("Soundness is 41 to 46 bits unconditional."), 0, "46 is nobody's unique-decoding figure");
    // a circuit named on the figure's own line wins over its neighbours'
    assert_eq!(matched("| C0 | 42 bits unconditional |\n| C7 | 42 bits unconditional |"), 1, "only C0's row is true");
    // and a table row never borrows its neighbour's circuit
    assert_eq!(matched("| C7 | 41 bits unconditional |\n| all | 41 bits unconditional |"), 1, "C0 is at 42: the second row is false");
    // a sentence wrapped onto the next line keeps its circuit
    assert_eq!(matched("The spend circuit (C7)\nhas 41 bits unconditional soundness."), 1);
    // the quantum line, per circuit (R7 of verify-WP1-r1b stays a match)
    assert_eq!(matched("Under the quantum line the spend circuit keeps 20 bits unique decoding."), 1);
    assert_eq!(matched("Under the quantum line C0 keeps 20 bits unique decoding."), 0, "C0's is 21");
    // "a Merkle path", "spend twice", "C7v2" and "#c0c0c0" name no v1 circuit:
    // "41 to 42" holds for every circuit, and for no single one of C3, C7 or C0
    for text in [
        "A Merkle path has 41 to 42 bits unconditional soundness.",
        "Deposit once, spend twice: 41 to 42 bits unconditional soundness.",
        "C7v2 has 41 to 42 bits unconditional soundness.",
        "color #c0c0c0; 41 to 42 bits unconditional soundness.",
    ] {
        assert_eq!(matched(text), 1, "{text:?} names no circuit, and 41 to 42 holds for every circuit");
    }
}

/// Round 1b: the scan reads text files only, and a PDF or PPTX under docs/
/// carries figures of its own (`protocol-01-design-document.pdf` has the
/// stale "42 to 46 bits"). Each binary export must have a scanned text source
/// of the same stem, the file it is regenerated from, or be listed in
/// `UNSCANNED_EXPORTS` with its reason.
#[test]
fn every_binary_export_has_a_scanned_source_or_is_listed() {
    let exports = prose::binary_exports(&repo_root());
    assert!(!exports.is_empty(), "no PDF or PPTX found under the scan roots; is it reading the tree?");
    let unlisted: Vec<&prose::BinaryExport> = exports
        .iter()
        .filter(|e| e.source.is_none() && !prose::UNSCANNED_EXPORTS.iter().any(|(p, _)| *p == e.path))
        .collect();
    assert!(
        unlisted.is_empty(),
        "binary exports with no scanned source of the same stem, and not in UNSCANNED_EXPORTS: {unlisted:?}"
    );
    for (path, reason) in prose::UNSCANNED_EXPORTS {
        let e = exports.iter().find(|e| e.path == *path);
        assert!(e.is_some(), "UNSCANNED_EXPORTS lists {path}, which is not there any more");
        assert!(e.unwrap().source.is_none(), "{path} has a scanned source now: remove it from UNSCANNED_EXPORTS");
        assert!(!reason.trim().is_empty(), "{path}: a reason");
    }
}

/// An export named "deck.PDF" is an export too: an extension compared by case
/// would let it past the test above.
#[test]
fn binary_exports_are_found_whatever_the_case_of_their_extension() {
    let root = std::env::temp_dir().join(format!("p01-security-levels-exports-{}", std::process::id()));
    let docs = root.join("docs");
    fs::create_dir_all(&docs).expect("temporary docs/");
    for (name, body) in [("deck.PDF", "x"), ("paper.pdf", "x"), ("paper.html", "<p>x</p>")] {
        fs::write(docs.join(name), body).expect("temporary file");
    }
    let mut exports = prose::binary_exports(&root);
    let _ = fs::remove_dir_all(&root);
    exports.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(
        exports,
        vec![
            prose::BinaryExport { path: "docs/deck.PDF".to_string(), source: None },
            prose::BinaryExport { path: "docs/paper.pdf".to_string(), source: Some("docs/paper.html".to_string()) },
        ]
    );
}

/// Round 3 (Y5, Y6 of `verify-WP1-r3-mutations.log`): the scan reads ten
/// extensions and skips `dist` and `build`, and the header called that "text
/// files are read". A stale "N bits unconditional" put in
/// `docs/soundness-diagram.mmd` or `docs/build/notes.md` was invisible with
/// the suite green. Every file the scan does not read is now checked for
/// figures instead, so a blind spot with something in it fails.
#[test]
fn a_file_the_scan_does_not_read_is_checked_for_figures() {
    let root = std::env::temp_dir().join(format!("p01-security-levels-blind-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("docs/build")).expect("temporary docs/build");
    fs::create_dir_all(root.join("docs/deck")).expect("temporary docs/deck");
    // read: its figure is a normal hit, not a blind spot
    fs::write(root.join("docs/levels.md"), "Soundness is 41 bits unconditional.\n").expect("md");
    // an extension the scan does not read
    fs::write(root.join("docs/soundness-diagram.mmd"), "graph TD\n  A[41 bits unconditional]\n").expect("mmd");
    // a directory the scan does not enter
    fs::write(root.join("docs/build/notes.md"), "Soundness is 99 bits unconditional.\n").expect("built md");
    // an unread file that states no figure at all is not a blind spot
    fs::write(root.join("docs/deck/plates.py"), "WIDTH = 1280  # px\n").expect("py");
    // a parameter is not a level, and does not make a file a blind spot
    fs::write(root.join("docs/deck/lancer-deck.bat"), "rem 22 bits of grinding\n").expect("bat");
    // a binary file is not prose, whatever bytes it happens to spell
    fs::write(root.join("docs/logo.png"), b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR 41 bits\xff\xfe".as_slice())
        .expect("png");
    let mut spots = prose::unread_files_with_figures(&root);
    let _ = fs::remove_dir_all(&root);
    spots.sort_by(|a, b| a.path.cmp(&b.path));
    let found: Vec<(&str, &[String])> = spots.iter().map(|s| (s.path.as_str(), s.figures.as_slice())).collect();
    assert_eq!(
        found,
        vec![
            ("docs/build/notes.md", ["99 bits".to_string()].as_slice()),
            ("docs/soundness-diagram.mmd", ["41 bits".to_string()].as_slice()),
        ]
    );
    assert!(spots.iter().all(|s| !s.reason.trim().is_empty()), "every blind spot says why it is one");
}

/// The repository has no blind spot with a figure in it, apart from the
/// local-only files, which are listed with a reason.
#[test]
fn no_unread_file_in_the_repository_states_an_unlisted_figure() {
    let spots = prose::unread_files_with_figures(&repo_root());
    let unexpected: Vec<String> = spots
        .iter()
        .filter(|s| !prose::LOCAL_ONLY_FILES.iter().any(|(p, _)| *p == s.path))
        .map(|s| format!("  {} ({}): {:?}", s.path, s.reason, s.figures))
        .collect();
    assert!(
        unexpected.is_empty(),
        "file(s) the scan does not read that state a figure: read them, or list them with a reason:\n{}",
        unexpected.join("\n")
    );
}

/// Round 3, G-WP1-b: seven ledger rows sat on four files a clean checkout does
/// not have, so `every_ledger_entry_still_covers_a_figure` was red in CI and
/// the stale pin could not hold both here and there. Those files are out of
/// the scan now, and this test re-measures with git that each is really
/// gitignored or untracked, so the list cannot hide a committed document.
#[test]
fn every_local_only_file_is_really_absent_from_a_clean_checkout() {
    for (path, reason) in prose::LOCAL_ONLY_FILES {
        assert!(!reason.trim().is_empty(), "{path}: a reason");
    }
    // A clean checkout simply does not have them, which is the whole point, so
    // their absence is not a failure. What must never happen is the opposite:
    // a file git TRACKS listed here would be excluded from the scan although
    // it ships.
    let mut cmd = std::process::Command::new("git");
    cmd.arg("ls-files").arg("--").current_dir(repo_root());
    for (path, _) in prose::LOCAL_ONLY_FILES {
        cmd.arg(path);
    }
    let Ok(out) = cmd.output() else {
        eprintln!("git is not on PATH: the tracked-file half of this test did not run");
        return;
    };
    if !out.status.success() {
        eprintln!("git could not read this tree: the tracked-file half of this test did not run");
        return;
    }
    let tracked = String::from_utf8_lossy(&out.stdout);
    let tracked: Vec<&str> = tracked.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    assert!(
        tracked.is_empty(),
        "git tracks {tracked:?}: a clean checkout has {} now, so drop it from LOCAL_ONLY_FILES and list its figures \
         in the ledger",
        tracked.join(", ")
    );
}

/// Gate v2 r1, R3 (wp1-break must-fix 1): `prose.rs`'s header and the
/// generated, PUBLIC `docs/SECURITY-LEVELS.md` both said a local-only file "is
/// checked by `unread_files_with_figures` instead, which fails the test if it
/// states a figure". It is not: `no_unread_file_in_the_repository_states_an_
/// unlisted_figure` filters `LOCAL_ONLY_FILES` out, on purpose (the stale
/// "127-bit conjectured" of `docs/stark-migration-assessment.md` is a founder
/// finding, and the file does not ship). The gate's probe: `docs/FACTS-2026-09-
/// 14.md` holding "Soundness is 999 bits unconditional." leaves the suite
/// green. The behaviour stays; the two documents now say what it is.
///
/// First half: the behaviour, measured, so the sentence below is about
/// something. Second half: the words, in both places.
#[test]
fn the_documents_do_not_promise_a_check_that_local_only_files_do_not_get() {
    let (local_only, _) = prose::LOCAL_ONLY_FILES.last().expect("a local-only file");
    let root = std::env::temp_dir().join(format!("p01-security-levels-localonly-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("docs")).expect("temporary docs");
    fs::write(root.join(local_only), "Soundness is 999 bits unconditional.\n").expect("local-only file");
    let scanned: Vec<String> = prose::scan_repo(&root).into_iter().map(|h| h.path).collect();
    let spots = prose::unread_files_with_figures(&root);
    let _ = fs::remove_dir_all(&root);
    assert!(!scanned.iter().any(|p| p == local_only), "a local-only file is not read by the scan");
    // The library still SEES it (that is how `--prose` can report it) ...
    assert!(
        spots.iter().any(|s| s.path == *local_only && s.figures == ["999 bits"]),
        "unread_files_with_figures reports the figure of a local-only file: {spots:?}"
    );
    // ... and the repository test drops exactly those paths, so nothing fails.
    let failing: Vec<_> =
        spots.iter().filter(|s| !prose::LOCAL_ONLY_FILES.iter().any(|(p, _)| *p == s.path)).collect();
    assert!(failing.is_empty(), "the only blind spot in this tree is the local-only file: {failing:?}");

    let normal = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let generated = normal(&p01_security_levels::render::document());
    let header: String = include_str!("../src/prose.rs")
        .lines()
        .take_while(|l| l.starts_with("//!"))
        .map(|l| l.trim_start_matches("//!").trim())
        .collect::<Vec<_>>()
        .join(" ");
    for (name, text) in [("docs/SECURITY-LEVELS.md as generated", &generated), ("the header of src/prose.rs", &normal(&header))]
    {
        assert!(
            text.contains("A local-only file is neither read nor checked"),
            "{name} must say plainly that a local-only file is neither read nor checked: a figure in it fails nothing"
        );
        // the old promise, in either wording
        assert!(
            !text.contains("Every other file under those roots is checked")
                && !text.contains("a local-only file — is checked"),
            "{name} still promises that EVERY file the scan does not read is checked for figures; the local-only \
             files are not"
        );
    }
}

/// Gate v2 r1, R3 (wp1-break missed 6): the reasons cited `.gitignore:275` and
/// `:270`; `git check-ignore -v` says 286 and 281, because WP1's own
/// `.gitignore` edit added 11 lines above them. A line number in a string rots
/// silently, so it is re-measured here, without git: `.gitignore` is tracked,
/// so a clean checkout has it.
#[test]
fn the_gitignore_lines_the_local_only_reasons_cite_are_the_lines_that_ignore_them() {
    let gitignore = fs::read_to_string(repo_root().join(".gitignore")).expect(".gitignore at the repository root");
    let lines: Vec<&str> = gitignore.lines().collect();
    let mut cited = 0;
    for (path, reason) in prose::LOCAL_ONLY_FILES {
        let Some(at) = reason.find(".gitignore:") else {
            assert!(!reason.starts_with("gitignored"), "{path}: says it is gitignored and cites no .gitignore line");
            continue;
        };
        let digits: String = reason[at + ".gitignore:".len()..].chars().take_while(char::is_ascii_digit).collect();
        let n: usize = digits.parse().unwrap_or_else(|_| panic!("{path}: no line number after \".gitignore:\""));
        cited += 1;
        assert_eq!(
            lines.get(n - 1).map(|l| l.trim()),
            Some(*path),
            "{path}: its reason cites .gitignore:{n}, and that line does not ignore it; it is on line {:?}",
            lines.iter().position(|l| l.trim() == *path).map(|i| i + 1)
        );
    }
    assert_eq!(cited, 2, "two of the local-only files are gitignored and cite their line");
}

/// Gate v2 r1, R3 (wp1-break must-fix 2): round 3 made a markdown table row
/// and a new list item a wrap barrier, and left the HTML spellings of the same
/// thing open. Two table rows, two cells, or a text line and a `<hr>` joined
/// into one line, and the list marker of the second became the "-" of a range:
/// "... sits at 41</td></tr>" / "<tr><td>- 45 bits unconditional" read as "41 -
/// 45 bits", which MATCHES (41 and 45 are both published). The roots hold
/// scanned `.html` files. A block-level tag at the start of the second line, or
/// at the end of the first, is now a barrier; an inline tag is not, and a
/// figure wrapped INSIDE one cell still joins (Z3 above).
#[test]
fn an_html_row_cell_or_block_boundary_is_not_a_wrap() {
    let doc = "<!-- published-figures:begin -->\n```text\n\
               C0 unique-decoding 42\nC1 unique-decoding 45\nC7 unique-decoding 41\n\
               ```\n<!-- published-figures:end -->\n";
    let published = prose::parse_published(doc);
    let figures = |text: &str| -> Vec<(usize, f64, f64)> {
        prose::scan_text("x.html", text).iter().map(|h| (h.line_no, h.figure.low, h.figure.high)).collect()
    };
    let uncovered = |text: &str| prose::check(&prose::scan_text("x.html", text), &published, &[]).uncovered.len();

    // The gate's three probes (`gate2/06b-open-mustfix-probes.log`). On the old
    // behaviour each reads (1, 41, 45) and is covered; the second line alone
    // says "45 bits" of every circuit, which no regime publishes.
    for (name, text) in [
        (
            "two table rows",
            "<tr><td>The unconditional floor sits at 41</td></tr>\n<tr><td>- 45 bits unconditional soundness</td></tr>",
        ),
        ("two cells", "<td>41</td>\n<td>- 45 bits unconditional</td>"),
        ("a rule", "The unconditional floor sits at 41\n<hr>- 45 bits unconditional soundness"),
        ("a line break at the end of the first line", "The unconditional floor sits at 41<br>\n- 45 bits unconditional"),
        ("a self-closed break", "The unconditional floor sits at 41<br/>\n– 45 bits unconditional soundness"),
        ("a paragraph", "<p>The unconditional floor sits at 41</p>\n<p>- 45 bits unconditional soundness</p>"),
        ("a closing cell first", "The unconditional floor sits at 41\n</td><td>- 45 bits unconditional soundness</td>"),
        ("a heading", "The unconditional floor sits at 41\n<h3>- 45 bits unconditional</h3>"),
        ("upper case", "<TD>41</TD>\n<TD>- 45 bits unconditional</TD>"),
    ] {
        assert_eq!(figures(text), [(2, 45.0, 45.0)], "{name}: the second line is a figure of its own");
        assert_eq!(uncovered(text), 1, "{name}: and it is not a published one");
    }

    // What must still join: an INLINE tag is not a boundary, and neither is a
    // block tag that is not at the break.
    assert_eq!(
        figures("The floor is 41 to\n<strong>45 bits</strong> unconditional."),
        [(1, 41.0, 45.0)],
        "an inline tag at the start of the second line"
    );
    assert_eq!(
        figures("The floor is <em>41 to</em>\n45 bits unconditional."),
        [(1, 41.0, 45.0)],
        "an inline tag at the end of the first line"
    );
    assert_eq!(
        figures("<p>The floor is 41 to\n45 bits unconditional.</p>"),
        [(1, 41.0, 45.0)],
        "a paragraph wrapped in its source"
    );
    assert_eq!(figures("<td>C1 has 45\nbits unconditional soundness.</td>"), [(1, 45.0, 45.0)], "Z3: inside one cell");
    // `<path>`, `<pre-x>`, `<param>` are not `<p>`: the tag NAME is compared.
    assert_eq!(
        figures("The floor is 41 to\n<param-x>45 bits</param-x> unconditional."),
        [(1, 41.0, 45.0)],
        "a tag whose name only starts like a block tag"
    );
}

/// Gate v2 r1, R3 (wp1-break missed 5): the preimage tag was set only when the
/// word FOLLOWS "bit(s)". "preimage resistance is 128 bits; collision ..." and
/// "~128-bit (preimage), collision" were read as collision figures, and 128 is
/// SHA-256's published classical collision figure, so they matched.
#[test]
fn a_preimage_figure_is_read_in_either_word_order() {
    let published = prose::parse_published(
        "<!-- published-figures:begin -->\nsha256 collision 128\nsha256 collision-quantum 85\n<!-- published-figures:end -->",
    );
    for line in [
        "SHA-256 preimage resistance is 128 bits; collision in the other column",
        "SHA-256: ~128-bit (preimage), collision",
        "SHA-256 collision figures aside, the pre-image bound is 128 bits",
        "SHA-256 : la résistance à la préimage est de 128 bits (collision à côté)",
    ] {
        let hits = prose::scan_text("x.md", line);
        assert_eq!(hits.len(), 1, "{line:?}: {hits:?}");
        assert!(hits[0].figure.preimage, "{line:?}: a preimage figure");
        assert!(!prose::figure_matches(&hits[0].figure, &hits[0].families, &published), "{line:?}: must not match");
    }
    // The word belongs to ONE figure: the clause it sits in. A collision figure
    // next to a preimage one keeps matching, in both orders.
    let hits = prose::scan_text("x.md", "SHA-256: preimage 128 bits, collision 128 bits");
    assert_eq!(hits.iter().map(|h| h.figure.preimage).collect::<Vec<_>>(), [true, false]);
    assert!(prose::figure_matches(&hits[1].figure, &hits[1].families, &published), "the collision figure matches");
    let hits = prose::scan_text("x.md", "SHA-256: collision 128 bits, preimage 128 bits");
    assert_eq!(hits.iter().map(|h| h.figure.preimage).collect::<Vec<_>>(), [false, true]);
    let hits = prose::scan_text("x.md", "| SHA-256 | 128-bit collision resistance |");
    assert!(!hits[0].figure.preimage && prose::figure_matches(&hits[0].figure, &hits[0].families, &published));
    // The clause ends at the previous figure, so the word tags one figure only.
    let hits = prose::scan_text("x.md", "SHA-256 preimage resistance is 128 bits and the tag keeps 32 bits of it");
    assert_eq!(hits.iter().map(|h| h.figure.preimage).collect::<Vec<_>>(), [true, false]);
    // Both words in ONE clause before the number: the order does not say which
    // bound it is, so the figure stays what it was always read as. Pinned so
    // that the rule is a choice and not an accident.
    let hits = prose::scan_text("x.md", "SHA-256 collision and preimage resistance both sit at 128 bits");
    assert!(!hits[0].figure.preimage, "an ambiguous clause is not tagged");
}

/// Round 1: the scanner skipped any figure without a security word on its
/// line or a neighbouring one, and every "bits per query" / "bits of grinding"
/// figure. A stale level or parameter written plainly walked past it.
#[test]
fn the_scanner_reads_every_figure_whatever_its_context() {
    for line in [
        "The spend circuit reaches 60 bits with 22 queries.",
        "| Paramètres | 32 requêtes, blowup 16, pas de grinding → 128 bits |",
        "one of very few people alive who solo-built a 124-bit on-chain STARK verifier",
        "a 64-bit field element",
    ] {
        let hits = prose::scan_text("x.md", line);
        assert_eq!(hits.len(), 1, "{line:?} carries one figure, and it must be scanned: {hits:?}");
        assert!(!hits[0].figure.parameter, "{line:?}");
    }
    // parameters are figures too, flagged so that they never match a regime
    for line in [
        "rho = 1/16, that is 4.000 bits per query",
        "22 bits of grinding",
        "facteur de blowup 16 et 16 bits de grinding",
        "16x blowup and 16 bits of grinding",
    ] {
        let figs = prose::figures_in_line(line);
        assert_eq!(figs.len(), 1, "{line:?} carries one figure: {figs:?}");
        assert!(figs[0].parameter, "{line:?} is a parameter");
    }
    let doc = "<!-- published-figures:begin -->\nC7 unique-decoding 22\n<!-- published-figures:end -->";
    let published = prose::parse_published(doc);
    let hit = &prose::scan_text("x.md", "22 bits of grinding, unconditional")[0];
    assert!(hit.families.contains(&Family::UniqueDecoding));
    assert!(!prose::figure_matches(&hit.figure, &hit.families, &published), "a parameter never matches a level");
    // "N+ bits" and a thin space
    assert_eq!(lows("lift it from ~64 to ~128+ bits"), [(128.0, 128.0)]);
    assert_eq!(lows("a 42\u{2009}bit floor"), [(42.0, 42.0)]);
}

/// Round 2 (W1 and W1b of `verify-WP1-r2-mutations.log`): the docs are
/// hard-wrapped at about 80 columns, and a figure whose number ended one line
/// and whose "bits" began the next was invisible:
/// `docs/zk-simulation-argument.md:393-394` ("... 42 to 52" / "bits,
/// floor-bound by the field") had no hit and no ledger row. A range whose low
/// end ended the previous line was read as its high end ("110 to" / "130
/// bits" as 130). A figure is now read across one line break, as if the two
/// lines were one; a blank line, a table row or a new list item is not a wrap.
#[test]
fn a_figure_split_across_a_line_break_is_read_whole() {
    let doc = "<!-- published-figures:begin -->\n```text\n\
               C0 unique-decoding 42\nC1 unique-decoding 45\nC7 unique-decoding 41\n\
               ```\n<!-- published-figures:end -->\n";
    let published = prose::parse_published(doc);
    let figures = |text: &str| -> Vec<(usize, f64, f64)> {
        prose::scan_text("x.md", text).iter().map(|h| (h.line_no, h.figure.low, h.figure.high)).collect()
    };
    let uncovered = |text: &str| prose::check(&prose::scan_text("x.md", text), &published, &[]).uncovered.len();
    // the verifier's controls: a new claim wrapped as a range, or as one number
    assert_eq!(uncovered("Soundness is 99 to 99\nbits unconditional."), 1, "W1: a range wrapped before \"bits\"");
    assert_eq!(uncovered("Soundness is 99\nbits unconditional."), 1, "W1b: a number wrapped before \"bits\"");
    assert_eq!(figures("Soundness is 99 to 99\nbits unconditional."), [(1, 99.0, 99.0)]);
    // the real case, zk-simulation-argument.md:393-394
    assert_eq!(
        figures(
            "- \u{2714} **Soundness is unchanged and is not what this document is about.** 42 to 52\n  \
             bits, floor-bound by the field, and no ZK result moves it."
        ),
        [(1, 42.0, 52.0)]
    );
    // the low end of a range on the previous line (protocol-01-design-document.html:852-853)
    assert_eq!(figures("The conjectured query term is 110 to\n130 bits and is cut down to it."), [(1, 110.0, 130.0)]);
    // ...which decides a verdict: C1 publishes 45, not 44
    assert_eq!(uncovered("C1 has 44 to\n45 bits unconditional soundness."), 1, "read as 45 alone, it matched");
    assert_eq!(uncovered("C1 has 45\nbits unconditional soundness."), 0, "a true wrapped figure matches");
    // a hyphen at the break, indentation, a comment continuation
    assert_eq!(figures("a 64-\nbit field"), [(1, 64.0, 64.0)]);
    assert_eq!(figures("        landing at 42 to\n        46 bits unconditional"), [(1, 42.0, 46.0)]);
    assert_eq!(figures("// soundness is 42 to\n// 46 bits unconditional"), [(1, 42.0, 46.0)]);
    assert_eq!(figures("> Soundness is 42 to\n> 46 bits unconditional"), [(1, 42.0, 46.0)], "a quoted paragraph");
    // not a wrap: a blank line, a table row
    assert!(figures("Soundness is 99\n\nbits unconditional.").is_empty(), "a paragraph break");
    assert!(figures("| C7 | 42\n| bits | x |").is_empty(), "table rows");
    assert!(figures("| C7 | 42\nbits unconditional").is_empty(), "a line after a table row is not its continuation");
    // This one passes on the two-joiner limit in `figures_in_view`, not on any
    // list rule: it is kept as a guard, and the rule itself is tested below.
    assert!(figures("- the floor is 42\n- bits are cheap").is_empty(), "a new list item");
    // a figure wholly on one line is read once, on its own line
    assert_eq!(figures("Soundness is 41\nbits here, and 45 bits there."), [(1, 41.0, 41.0), (2, 45.0, 45.0)]);

    // Round 3 (Y1, Y2 of `verify-WP1-r3-mutations.log`): the header's rule "a
    // new list item is not a wrap" was documented but never implemented, and
    // round 2's join made a list marker read as the "-" or the blank of a
    // range. A false claim written as the first item of a list under a line
    // that ends in a number was then swallowed whole.
    //
    // C0 publishes 42, C1 45, C7 41, so "45 bits unconditional" with no
    // circuit named is false and must be uncovered; joined, "41 - 45" and
    // "41 to 45" cover every circuit and matched.
    assert_eq!(
        uncovered("The v1 unique-decoding floor sits at 41\n- 45 bits unconditional soundness, for every circuit."),
        1,
        "Y1: a dash list item is a new item, not the low end of a range"
    );
    assert_eq!(
        uncovered("The v1 unique-decoding floor sits at 41 to\n* 45 bits unconditional soundness, for every circuit."),
        1,
        "an asterisk list item, blanked by the view, is still a new item"
    );
    assert_eq!(
        uncovered("The floor sits at 41 to\n<li>45 bits unconditional soundness, for every circuit.</li>"),
        1,
        "Y2: an HTML list item is a new item"
    );
    // The same rule for the markers that do not open a false range on the old
    // behaviour, so these do not go red on it; they pin the rule as written.
    assert_eq!(uncovered("The floor sits at 41 to\n+ 45 bits unconditional soundness."), 1, "a plus list item");
    assert_eq!(uncovered("The floor sits at 41 to\n2. 45 bits unconditional soundness."), 1, "an ordered list item");
    assert_eq!(uncovered("The floor sits at 41 to\n3) 45 bits unconditional soundness."), 1, "an ordered list item");
    // ...and the real wrapped hit of round 2 still joins, because its list
    // marker is on the FIRST line: only a new item breaks the wrap.
    assert_eq!(
        figures("- the conjectured term is 42 to\n  52 bits, floor-bound by the field"),
        [(1, 42.0, 52.0)],
        "the continuation of a list item is not a new item"
    );
    // a list marker inside a comment or a quote is a list marker too
    assert_eq!(uncovered("// The floor sits at 41 to\n// - 45 bits unconditional soundness."), 1, "a quoted list item");

    // Round 3 (Z3, Z4 of `verify-WP1-r3-mutations.log`): a wrapped hit takes
    // its circuits and its hash tags from the two joined lines. Neither branch
    // had a test: reading them off the second line alone changed no verdict.
    // Here the circuit is named on the FIRST line only, and the previous line
    // is an HTML table row, so the neighbour window cannot supply it.
    assert_eq!(
        uncovered("<td>C1 has 45\nbits unconditional soundness.</td>"),
        0,
        "Z3: a wrapped hit's circuit comes from both lines; read off the second alone it is \"every circuit\""
    );
    let hashes = prose::parse_published(
        "<!-- published-figures:begin -->\nsha256 collision 128\nsha256 collision-quantum 85\n<!-- published-figures:end -->",
    );
    let hash_uncovered =
        |text: &str| prose::check(&prose::scan_text("x.md", text), &hashes, &[]).uncovered.len();
    assert_eq!(
        hash_uncovered("SHA-256 collision resistance is 128\nbits."),
        0,
        "Z4: a wrapped hit's hash tags come from both lines; read off the second alone it has none"
    );

    // Round 3 (Z9): the header claims `\uXXXX` escapes are decoded in the
    // view. The only test of it passed undecoded, because the family word
    // survived. An i18n string with an escaped space inside the figure does not.
    assert_eq!(figures("Soundness is 42\\u00a0bits unconditional."), [(1, 42.0, 42.0)], "Z9: \\u00a0 is a space");
    assert_eq!(figures("La soundness est de 42\\u2009bits."), [(1, 42.0, 42.0)], "Z9: \\u2009 is a thin space");
}

/// Round 2 (W2 to W7 of `verify-WP1-r2-mutations.log`): markup, an entity or a
/// slash between the number and "bit" hid the figure completely. The scanner's
/// view of a line now blanks inline markup, decodes numeric entities and the
/// named spacing ones, and reads "a/b bits" and "a or b bits" as two figures.
#[test]
fn markup_entities_and_alternatives_do_not_hide_a_figure() {
    for line in [
        "Soundness is **99** bits unconditional.",
        "Soundness is `99` bits unconditional.",
        "Soundness is *99* bits unconditional.",
        "Soundness is _99_ bits unconditional.",
        "Soundness is ~~99~~ bits unconditional.",
        "<p>Soundness is 99&#160;bits unconditional.</p>",
        "<p>Soundness is 99&#xA0;bits unconditional.</p>",
        "<p>Soundness is 99&#8239;bits unconditional.</p>",
        "<p>Soundness is 99&#x202F;bits unconditional.</p>",
        "<p>Soundness is 99&#8201;bits unconditional.</p>",
        "soundness: 99&thinsp;bits unconditional",
        "<strong>99</strong> bits unconditional soundness",
        "<span class=\"mono\">99</span>&nbsp;<em>bits</em> unconditional",
        "<strong>99</strong>{' '}bits unconditional soundness",
        "<p>{99} bits unconditional soundness</p>",
    ] {
        assert_eq!(lows(line), [(99.0, 99.0)], "{line:?} states 99 bits");
    }
    // alternatives: each is a figure the generated file or the ledger must account for
    let sorted = |line: &str| {
        let mut v = lows(line);
        v.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
        v
    };
    for line in [
        "Soundness is 99/98 bits unconditional.",
        "Soundness is 99 / 98 bits unconditional.",
        "Soundness is 99 or 98 bits unconditional.",
        "La soundness est de 99 ou 98 bits.",
    ] {
        assert_eq!(sorted(line), [(98.0, 98.0), (99.0, 99.0)], "{line:?} states 99 and 98");
    }
    let published = prose::parse_published("<!-- published-figures:begin -->\nC1 unique-decoding 45\n<!-- published-figures:end -->");
    let hits = prose::scan_text("x.md", "C1 has 99 / 45 bits unconditional soundness.");
    assert_eq!(prose::check(&hits, &published, &[]).uncovered.len(), 1, "45 is C1's, 99 is nobody's");
    // not figures: an exponent in markup, a subscript, identifiers
    assert!(lows("2<sup>64</sup> bits of work").is_empty(), "2^64 is an exponent");
    assert!(lows("worth log<sub>2</sub>(k) bits").is_empty());
    assert!(lows("see min_64_bits and b2_bits_measured").is_empty(), "identifiers");

    // Round 3 (Y3, Y4, Y7 of `verify-WP1-r3-mutations.log`): a markdown link
    // around the number — the way the generated document invites people to
    // cite it — a footnote reference between the number and its "bits", and an
    // en dash instead of a hyphen, each hid the figure completely.
    for line in [
        "Soundness is [99](docs/SECURITY-LEVELS.md) bits unconditional.",
        "Soundness is [99][levels] bits unconditional.",
        "Soundness is 99[^1] bits unconditional.",
        "Soundness is 99[^levels] bits unconditional.",
        "Soundness is 99\u{2013}bit unconditional.",
        "Soundness is 99\u{2014}bit unconditional.",
        "Soundness is [99](docs/SECURITY-LEVELS.md)[^1] bits unconditional.",
    ] {
        assert_eq!(lows(line), [(99.0, 99.0)], "{line:?} states 99 bits");
    }
    // brackets that open no link are text: "[1] see" keeps its number
    assert_eq!(lows("see [1] for the 99 bits"), [(99.0, 99.0)]);
    assert!(lows("the array is bits[99] wide").is_empty(), "an index is not a figure");
}

/// Round 3: `docs/quantum-resistance.md:295` reads
/// "| SHA-256 | ... | ~85-bit collision, ~128-bit preimage |". The 128 was
/// counted as SHA-256's CLASSICAL COLLISION figure, because "collision"
/// appears on the same line for the other column and the birthday bound of
/// SHA-256 is also 128. It is a Grover preimage figure, and the calculator
/// publishes no preimage line: a preimage/collision mix-up passed the same way.
#[test]
fn a_preimage_figure_is_not_read_as_a_collision_figure() {
    let published = prose::parse_published(
        "<!-- published-figures:begin -->\nsha256 collision 128\nsha256 collision-quantum 85\n<!-- published-figures:end -->",
    );
    let hits = prose::scan_text("x.md", "| SHA-256 | View tag generation | ~85-bit collision, ~128-bit preimage |");
    assert_eq!(hits.len(), 2, "two figures on the row: {hits:?}");
    assert!(hits.iter().all(|h| h.families.contains(&Family::Sha256) && h.families.contains(&Family::Collision)));
    assert!(
        !prose::figure_matches(&hits[1].figure, &hits[1].families, &published),
        "128 is a preimage figure, and the document publishes no preimage line"
    );
    // the classical collision figure on the same row still matches
    let hits = prose::scan_text("x.md", "| SHA-256 | 128-bit collision resistance |");
    assert!(prose::figure_matches(&hits[0].figure, &hits[0].families, &published), "128-bit collision is published");
    // French, and "preimage resistance"
    for line in ["SHA-256 collision: ~128-bit preimage resistance", "SHA-256 collision : ~128-bit pr\u{e9}image"] {
        let hits = prose::scan_text("x.md", line);
        assert!(!prose::figure_matches(&hits[0].figure, &hits[0].families, &published), "{line:?}");
    }
}

/// Round 1: a row covered its whole line, so a figure added to a listed line
/// ("... 42 to 46 bits unconditional and 99 bits conjectured") was absorbed.
/// A row now covers only the figures inside its snippet, and counts them.
#[test]
fn the_ledger_covers_only_the_figures_its_snippet_names() {
    let row = prose::parse_ledger("stale\tdocs/a.md\tSoundness is 42 to 46 bits unconditional\t\tsee finding\n").expect("parses");
    let hits = prose::scan_text("docs/a.md", "Soundness is 42 to 46 bits unconditional and 99 bits conjectured.");
    assert_eq!(hits.len(), 2);
    assert!(prose::entry_covers(&row[0], &hits[0]), "the row names 42 to 46");
    assert!(!prose::entry_covers(&row[0], &hits[1]), "the row does not name 99");
    // the same figure twice on a line: only the occurrence inside the snippet
    let hits = prose::scan_text("docs/a.md", "42 bits unconditional today, 42 bits unconditional tomorrow");
    let row = prose::parse_ledger("stale\tdocs/a.md\t42 bits unconditional tomorrow\t\tr\n").expect("parses");
    assert!(!prose::entry_covers(&row[0], &hits[0]) && prose::entry_covers(&row[0], &hits[1]));
    // a snippet that names no figure covers nothing, and is refused
    assert!(prose::parse_ledger("stale\tdocs/a.md\tSoundness is\t\tr\n").is_err(), "a snippet must contain its figure");
    // stale findings are counted per figure, not per row
    let hits = prose::scan_text("docs/a.md", "Soundness is 42 to 46 bits unconditional and 47 bits conjectured.");
    let rows = prose::parse_ledger("stale\tdocs/a.md\t42 to 46 bits unconditional and 47 bits conjectured\t\tr\n").expect("parses");
    let v = prose::check(&hits, &prose::Published::default(), &rows);
    assert_eq!((v.stale, v.stale_figures, v.uncovered.len()), (1, 2, 0));
}

#[test]
fn the_ledger_parses_and_covers_by_path_and_snippet() {
    let text = "# comment\nstale\tdocs/a.md\tabout 21 to 26 bits\t\tsee finding\nhistorical\tdocs/b.md\t*\t3\twhole file\n";
    let entries = prose::parse_ledger(text).expect("parses");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].kind, LedgerKind::Stale);
    assert_eq!(entries[1].count, Some(3));
    let hit = &prose::scan_text("docs/a.md", "Under Grover, about 21 to 26 bits remain.")[0];
    assert!(prose::entry_covers(&entries[0], hit));
    assert!(!prose::entry_covers(&entries[1], hit));
    assert!(prose::parse_ledger("stale\tdocs/a.md\t*\t\tno count").is_err(), "a whole-file row needs a count");
    assert!(prose::parse_ledger("bogus\tdocs/a.md\tx\t\tr").is_err(), "unknown kind");
    assert!(prose::parse_ledger("stale\tdocs/a.md\tx\t\t").is_err(), "a row needs a reason");
}

// ── the repository ───────────────────────────────────────────────────────────

#[test]
fn every_security_figure_in_the_prose_matches_the_generated_file_or_the_ledger() {
    let published = published();
    assert!(published.0.len() >= 8, "{DOC_PATH} publishes no figures; regenerate it");
    let hits = prose::scan_repo(&repo_root());
    assert!(hits.len() >= 20, "the scan found only {} figures; is it reading the tree?", hits.len());
    let verdict = prose::check(&hits, &published, &ledger());
    if !verdict.uncovered.is_empty() {
        let list: Vec<String> = verdict
            .uncovered
            .iter()
            .map(|h| format!("  {}:{}  [{}]  {:?}  {}", h.path, h.line_no, h.figure.text, h.families, h.line.trim()))
            .collect();
        panic!(
            "{} security figure(s) match neither {DOC_PATH} (for the regime the line names) nor {}:\n{}",
            verdict.uncovered.len(),
            prose::LEDGER_PATH,
            list.join("\n")
        );
    }
    assert!(verdict.count_mismatch.is_empty(), "whole-file rows whose count moved: {:?}", verdict.count_mismatch);
}

#[test]
fn every_ledger_entry_still_covers_a_figure() {
    let verdict = prose::check(&prose::scan_repo(&repo_root()), &published(), &ledger());
    let dead: Vec<String> =
        verdict.dead.iter().map(|e| format!("  line {}: {:?} {} {:?}", e.line_no, e.kind, e.path, e.snippet)).collect();
    assert!(dead.is_empty(), "ledger rows that cover nothing any more (remove them):\n{}", dead.join("\n"));
}

#[test]
fn the_stale_findings_are_pinned_exactly() {
    let entries = ledger();
    assert!(!entries.is_empty(), "the ledger is empty or missing");
    let v = prose::check(&prose::scan_repo(&repo_root()), &published(), &entries);
    assert_eq!(
        v.stale_figures,
        STALE_FIGURES,
        "{} stale figures in {} stale rows: STALE_FIGURES pins {STALE_FIGURES} (lower it when a stale figure is fixed; \
         raising it needs the founder)",
        v.stale_figures,
        v.stale
    );
    let mut rows: Vec<String> =
        entries.iter().filter(|e| e.kind == LedgerKind::Stale).map(|e| format!("{}\t{}", e.path, e.snippet)).collect();
    rows.sort();
    let digest =
        rows.join("\n").bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3));
    assert_eq!(
        digest,
        STALE_ROWS_FNV1A,
        "the set of stale rows changed ({} rows); once the change is accepted, pin {digest:#018x}:\n{}",
        rows.len(),
        rows.join("\n")
    );
}
