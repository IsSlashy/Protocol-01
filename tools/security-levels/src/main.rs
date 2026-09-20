//! `security-levels`: print, write or check `docs/SECURITY-LEVELS.md`.
//!
//! ```text
//! security-levels            print the document to stdout
//! security-levels --write    write docs/SECURITY-LEVELS.md
//! security-levels --check    exit 1 if docs/SECURITY-LEVELS.md differs from the output
//! security-levels --terms    print every error term of every circuit in every regime
//! security-levels --prose    print every security figure in the prose, and its verdict
//! ```

use std::process::ExitCode;

use p01_security_levels::{prose, render, repo_root, DOC_PATH};

fn normalise(s: &str) -> String {
    s.replace("\r\n", "\n")
}

fn main() -> ExitCode {
    let arg = std::env::args().nth(1).unwrap_or_default();
    let path = repo_root().join(DOC_PATH);
    match arg.as_str() {
        "" => {
            print!("{}", render::document());
            ExitCode::SUCCESS
        }
        "--terms" => {
            print!("{}", render::terms_report());
            ExitCode::SUCCESS
        }
        "--prose" => {
            let root = repo_root();
            let doc = std::fs::read_to_string(&path).unwrap_or_default();
            let published = prose::parse_published(&doc);
            let ledger_text = std::fs::read_to_string(root.join(prose::LEDGER_PATH)).unwrap_or_default();
            let ledger = match prose::parse_ledger(&ledger_text) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("{}: {e}", prose::LEDGER_PATH);
                    return ExitCode::from(2);
                }
            };
            let hits = prose::scan_repo(&root);
            for h in &hits {
                let verdict = if prose::hit_matches(h, &published) {
                    "matches".to_string()
                } else if let Some(e) = ledger.iter().find(|e| prose::entry_covers(e, h)) {
                    format!("ledger:{:?}", e.kind)
                } else {
                    "UNLISTED".to_string()
                };
                // A hint for whoever classifies a figure: a parameter, and
                // whether its line uses a security word. Neither decides
                // whether the figure is checked: every figure is.
                let flags = match (h.figure.parameter, prose::is_security_context(&h.line)) {
                    (true, true) => "parameter,security-word",
                    (true, false) => "parameter",
                    (false, true) => "security-word",
                    (false, false) => "-",
                };
                let circuits = if h.circuits.is_empty() { "all".to_string() } else { h.circuits.join(",") };
                // a figure wrapped across a line break prints both lines: "path:393-394"
                let lines =
                    if h.line_end == h.line_no { h.line_no.to_string() } else { format!("{}-{}", h.line_no, h.line_end) };
                println!("{}:{}\t{}\t{:?}\t{}\t{}\t{}", h.path, lines, h.figure.text, h.families, circuits, flags, verdict);
            }
            let v = prose::check(&hits, &published, &ledger);
            for e in &v.dead {
                println!("DEAD ledger row (covers nothing), line {}: {:?} {} {:?}", e.line_no, e.kind, e.path, e.snippet);
            }
            println!(
                "\n{} figures: {} match, {} listed in the ledger, {} unlisted; {} stale figures in {} stale ledger rows; {} dead rows",
                hits.len(),
                v.matched,
                v.covered,
                v.uncovered.len(),
                v.stale_figures,
                v.stale,
                v.dead.len()
            );
            ExitCode::SUCCESS
        }
        "--write" => {
            let doc = render::document();
            if let Err(e) = std::fs::write(&path, doc.as_bytes()) {
                eprintln!("cannot write {}: {e}", path.display());
                return ExitCode::from(2);
            }
            println!("wrote {DOC_PATH} ({} bytes)", doc.len());
            ExitCode::SUCCESS
        }
        "--check" => {
            let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
            if normalise(&on_disk) == normalise(&render::document()) {
                println!("{DOC_PATH} is current");
                ExitCode::SUCCESS
            } else {
                eprintln!(
                    "{DOC_PATH} differs from the calculator output; regenerate it with\n  \
                     cargo run --manifest-path tools/security-levels/Cargo.toml -- --write"
                );
                ExitCode::from(1)
            }
        }
        other => {
            eprintln!("unknown argument {other:?}; expected nothing, --write, --check, --terms or --prose");
            ExitCode::from(2)
        }
    }
}
