//! The prose check: find every "N bits" figure a document states as a security
//! level, and hold it against the figures `docs/SECURITY-LEVELS.md` publishes
//! for the regime the sentence names.
//!
//! A heuristic, stated plainly:
//! * a figure is a number written next to "bit" or "bits" ("47 bits",
//!   "42-bit", "42 to 46 bits", "47 à 52 bits"). Every one this reading finds
//!   is scanned, whatever its context, "a 64-bit field" and "22 bits of
//!   grinding" too. (Round 1 of WP1 found a filter on security words hiding 59
//!   lines, three of them stale security levels, and a parameter exclusion
//!   hiding a stale "16 bits of grinding" on the live site.)
//! * the scanner reads a line through a view (`view`): inline markup blanked
//!   (`**`, `*`, `` ` ``, `~~`, `_` around a number, HTML/JSX tags, `{' '}`,
//!   braces; `<sup>` read as `^`, so "2<sup>64</sup> bits" is an exponent),
//!   numeric entities and the named spacing ones decoded, `\uXXXX` escapes
//!   decoded, lowercased, whitespace runs collapsed. "a/b bits" and "a or b
//!   bits" are two figures. (Round 2 found "**99** bits", "`99` bits",
//!   "99/98 bits", "99&#160;bits", "<strong>99</strong> bits" and
//!   "99&thinsp;bits" invisible.)
//! * a figure wrapped across one line break is read as if the two lines were
//!   one: "... 42 to 52" / "bits, ..." is one figure, 42 to 52, and "110 to" /
//!   "130 bits" is 110 to 130, not 130 (`soft_wrap`; the hit's `line` then
//!   holds both lines). A blank line, a markdown table row or a new list item
//!   is not a wrap. (Round 2 found `docs/zk-simulation-argument.md:393-394`,
//!   a stale "42 to 52 bits" split over the break, with no hit at all.)
//! * a parameter ("bits per query", "bits of grinding") is flagged and never
//!   matches a regime: it must be listed;
//! * a figure's regime is whatever regime words ("unconditional",
//!   "conjectured", "Johnson", "quantum", "collision", ...) its line and the
//!   lines on either side use;
//! * a figure is about the v1 circuits its line names (`circuits_in`: "C7",
//!   "C0–C4", "merkle_update", "spend circuit"), or, when its line names none
//!   and is not a table row, the circuits a neighbouring line names; when no
//!   circuit is named, it is about every v1 circuit. (Round 1b found "The spend
//!   circuit (C7) has 42 bits unconditional" matching because C0 publishes 42.)
//! * it matches when, for one of those regimes, every circuit it is about
//!   publishes a figure inside its range (after flooring), and both ends of
//!   the range are published by one of those circuits. A hash figure matches
//!   on its hash instead (see `figure_matches_in`).
//!
//! Everything else must be listed in `tools/security-levels/prose-ledger.tsv`,
//! by a row whose snippet contains the figure itself: a row covers the figures
//! inside its snippet, not the whole line.
//!
//! What it reads, stated exactly (round 3 found the list below incomplete):
//! under `SCAN_ROOTS` — `README.md`, `docs/`, `apps/web/i18n/`,
//! `apps/web/app/` — every file whose extension is one of the ten in
//! `TEXT_EXTENSIONS` (md, mdx, html, htm, ts, tsx, js, jsx, mjs, txt), except
//! the generated document itself, anything under the five directories of
//! `SKIPPED_DIRECTORIES` (node_modules, .next, .turbo, dist, build) and the
//! local-only files of `LOCAL_ONLY_FILES`. A file under those roots that the
//! scan does not read because of its extension (.css, .py, .mmd, .bat on
//! 2026-09-20) or because it sits in a `dist` or `build` directory is checked
//! by `unread_files_with_figures` instead, and `tests/prose.rs` fails if it
//! states a figure. A local-only file is neither read nor checked:
//! `unread_files_with_figures` does return its figures, with the file's
//! reason, and the test drops exactly the `LOCAL_ONLY_FILES` paths, so a figure
//! in one fails nothing (gate v2 r1 measured it: "999 bits unconditional" in
//! `docs/FACTS-2026-09-14.md`, suite green; until then this header promised
//! the opposite). Nothing in such a file ships, and `tests/prose.rs` re-checks
//! with git that none of them is tracked (it says so and passes where git
//! cannot read the tree, as in an export with no `.git`). Dependency trees
//! (`DEPENDENCY_DIRECTORIES`), binary exports, the generated document itself
//! and files that are not valid UTF-8 escape both as well.
//!
//! What it does not read, stated as plainly:
//! * binary exports (`BINARY_EXPORT_EXTENSIONS`: PDF, PPTX, ...). This crate
//!   has no parser for them. Each must have a scanned text source of the same
//!   stem next to it, the file it is regenerated from, or be listed in
//!   `UNSCANNED_EXPORTS` with its reason; `tests/prose.rs` holds both. On
//!   2026-09-19 every PDF had its .html source and carried no figure that
//!   source lacks (`scratchpad/v2-run/logs/WP1-fix1b-binary-exports.log`);
//! * a figure written without "bit" or "bits" ("47/42" in a table), or with
//!   its number in words ("five conjectured bits");
//! * a figure split over two or more line breaks, or across a blank line;
//! * a list: in "42 and 46 bits", "42, 46 bits" or "42 et 46 bits" only 46 is
//!   read (a list separator is also how parameters are written: on 2026-09-19
//!   the one such line under the scan roots, `apps/web/i18n/fr.ts` "blowup 16
//!   et 16 bits de grinding", is not a list of figures;
//!   `scratchpad/v2-run/logs/WP1-fix2-survey.log`);
//! * markup this view does not blank: an HTML comment, an escaped tag
//!   ("&lt;b&gt;"), `_` inside an identifier ("min_64_bits" stays an
//!   identifier). A markdown link around the number ("[99](docs/x.md) bits"),
//!   a footnote reference between it and its "bits" (`99[^1] bits`) and an en
//!   or em dash instead of a hyphen ("99–bit") ARE read, since round 3;
//! * a circuit named in words other than its label or its `v1_name`
//!   identifier ("the spend proof", "la dépense").

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use crate::params;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Family {
    UniqueDecoding,
    Johnson,
    Conjectured,
    Quantum,
    Collision,
    /// Hash tags. A collision figure matches only for the hash its sentence
    /// names: "~85-bit collision" is SHA-256's quantum bound, and false of
    /// the v1 Poseidon, whose figures are 32 and 21.
    Sha256,
    Poseidon,
}

/// A figure as written: one value (`low == high`) or a range.
#[derive(Clone, Debug, PartialEq)]
pub struct Figure {
    pub low: f64,
    pub high: f64,
    pub text: String,
    /// `[start, end)`, in chars of the scanner's view of the line (`view`:
    /// markup blanked, entities and `\uXXXX` escapes decoded, lowercased,
    /// whitespace collapsed): from the leading digit to the end of "bit" or
    /// "bits".
    pub start: usize,
    pub end: usize,
    /// "N bits per query", "N bits of grinding": a parameter, never a level.
    pub parameter: bool,
    /// "N-bit preimage", "N-bit (preimage)" or, since gate v2 r1, "preimage
    /// ... N bits" (`preimage_clause_before`): a preimage bound, never a
    /// collision bound. The
    /// document publishes no preimage line, and `docs/quantum-resistance.md`
    /// writes both bounds of a hash on one row, so without this flag the
    /// "~128-bit preimage" of `quantum-resistance.md:295` matched SHA-256's
    /// classical COLLISION figure, which is 128 as well (round 3).
    pub preimage: bool,
}

#[derive(Clone, Debug)]
pub struct Hit {
    /// Repository-relative, forward slashes.
    pub path: String,
    /// 1-based: the line the figure starts on.
    pub line_no: usize,
    /// 1-based: the line its "bit" is on. It is `line_no + 1` for a figure
    /// wrapped across a line break, and `line` then holds both lines joined by
    /// one space (`soft_wrap`); otherwise it is `line_no`.
    pub line_end: usize,
    pub line: String,
    pub figure: Figure,
    pub families: Vec<Family>,
    /// The v1 circuits (labels, "C7") the figure is about; empty when its
    /// sentence names none, which means every circuit.
    pub circuits: Vec<String>,
}

/// What the check scans, relative to the repository root.
pub const SCAN_ROOTS: &[&str] = &["README.md", "docs", "apps/web/i18n", "apps/web/app"];

/// The ledger file, relative to the repository root.
pub const LEDGER_PATH: &str = "tools/security-levels/prose-ledger.tsv";

/// The ten extensions the scan reads. Everything else under `SCAN_ROOTS` is a
/// blind spot, and `unread_files_with_figures` fails the test when one of them
/// states a figure.
pub const TEXT_EXTENSIONS: &[&str] = &["md", "mdx", "html", "htm", "ts", "tsx", "js", "jsx", "mjs", "txt"];

/// Directories the scan does not enter. `node_modules`, `.next` and `.turbo`
/// are dependency and cache trees and are not ours; `dist` and `build` are
/// generated from sources the scan already reads. The blind-spot check below
/// still enters `dist` and `build`.
pub const SKIPPED_DIRECTORIES: &[&str] = &["node_modules", ".next", ".turbo", "dist", "build"];

/// Dependency and cache trees: neither the scan nor the blind-spot check
/// enters them.
pub const DEPENDENCY_DIRECTORIES: &[&str] = &["node_modules", ".next", ".turbo"];

/// Files under `SCAN_ROOTS` the scan does not read because a clean checkout
/// does not have them: each is gitignored or untracked on 2026-09-20, so
/// nothing it says ships, and a ledger row on one of them would be dead in CI
/// (V2-RUN.md, G-WP1-b). `tests/prose.rs` re-measures that with git, so a file
/// listed here cannot quietly become a committed one.
pub const LOCAL_ONLY_FILES: &[(&str, &str)] = &[
    (
        "docs/stark-migration-assessment.md",
        "gitignored under \"Internal project planning docs (keep local only)\" (.gitignore:286). It carries a stale \
         \"127-bit conjectured\" twice (lines 69 and 205); as shipped the conjectured figures are 45.60 to 46.91. \
         Un-ignoring it is a founder decision, and the stale figure is reported as a finding instead",
    ),
    (
        "docs/full-technical-inventory.md",
        "gitignored under the same block (.gitignore:281); its one figure is an amount width, not a level",
    ),
    (
        "docs/HANDOFF-2026-09-14.md",
        "untracked on 2026-09-20: a handoff note for the docs commit that has not been made yet (task A of \
         docs/HANDOFF-2026-09-14.md itself). Drop this row once it is committed",
    ),
    ("docs/FACTS-2026-09-14.md", "untracked on 2026-09-20, same commit as the handoff note above"),
];

const SECURITY_WORDS: &[&str] = &[
    "secur", "sécur", "sound", "forg", "attack", "attaque", "margin", "marge", "quantum", "quantique", "grover",
    "conjectur", "unconditional", "inconditionnel", "unique decoding", "unique-decoding", "johnson", "collision",
    "preimage", "préimage", "provable", "prouv", "safe", "resist", "résist",
];

const FAMILY_WORDS: &[(Family, &[&str])] = &[
    (
        Family::UniqueDecoding,
        &[
            "unique decoding",
            "unique-decoding",
            "unconditional",
            "inconditionnel",
            "provable",
            "proven",
            "prouvé",
            "théorème",
            "theorem",
        ],
    ),
    (Family::Johnson, &["johnson"]),
    (Family::Conjectured, &["conjectur"]),
    (Family::Quantum, &["quantum", "quantique", "grover", "qrom", "bht", "brassard"]),
    (Family::Collision, &["collision"]),
    (Family::Sha256, &["sha-256", "sha256", "sha 256"]),
    (Family::Poseidon, &["poseidon"]),
];

/// Named entities decoded (the ones the docs use, and every named space).
/// `&amp;`, `&lt;` and `&gt;` are left as they are: an escaped tag is text.
const NAMED_ENTITIES: &[(&str, char)] = &[
    ("eacute", 'é'),
    ("egrave", 'è'),
    ("agrave", 'à'),
    ("nbsp", '\u{a0}'),
    ("thinsp", '\u{2009}'),
    ("ensp", '\u{2002}'),
    ("emsp", '\u{2003}'),
    ("hairsp", '\u{200a}'),
    ("numsp", '\u{2007}'),
    ("puncsp", '\u{2008}'),
    ("ndash", '–'),
    ("mdash", '—'),
    ("apos", '\''),
];

/// The entity or `\uXXXX` escape starting at `i`: the char it stands for and
/// its length. `&#8209;` (a non-breaking hyphen) reads as `-`, as it always has.
fn entity_at(s: &[(char, usize)], i: usize) -> Option<(char, usize)> {
    let at = |k: usize| s.get(k).map(|&(c, _)| c);
    if at(i) == Some('\\') && at(i + 1) == Some('u') {
        let hex: String = (i + 2..i + 6).filter_map(at).collect();
        if hex.chars().count() == 4 {
            if let Some(c) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                return Some((c, 6));
            }
        }
        return None;
    }
    if at(i) != Some('&') {
        return None;
    }
    let semi = (i + 2..(i + 12).min(s.len())).find(|&k| at(k) == Some(';'))?;
    let name: String = (i + 1..semi).filter_map(at).collect();
    let len = semi + 1 - i;
    let code = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
        u32::from_str_radix(hex, 16).ok()
    } else if let Some(dec) = name.strip_prefix('#') {
        dec.parse::<u32>().ok()
    } else {
        return NAMED_ENTITIES.iter().find(|(n, _)| *n == name).map(|&(_, c)| (c, len));
    };
    match code? {
        8209 => Some(('-', len)),
        n => char::from_u32(n).map(|c| (c, len)),
    }
}

/// Decode entities and escapes in (char, source index) pairs.
fn decode_pairs(s: &[(char, usize)]) -> Vec<(char, usize)> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if matches!(s[i].0, '&' | '\\') {
            if let Some((c, len)) = entity_at(s, i) {
                out.push((c, s[i].1));
                i += len;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// Decode `\uXXXX` escapes (i18n sources) and HTML entities: the text the
/// regime and circuit words are looked for in.
fn decode(text: &str) -> String {
    let pairs: Vec<(char, usize)> = text.chars().enumerate().map(|(i, c)| (c, i)).collect();
    decode_pairs(&pairs).into_iter().map(|(c, _)| c).collect()
}

/// An HTML or JSX tag starting at `i` (`<name ...>`, `</name>`, `<name/>`):
/// the index just past it, and whether it opens a `<sup>`. A `<` that does
/// not start a tag ("a < b", "i<bits.len()") is text.
fn tag_at(src: &[char], i: usize) -> Option<(usize, bool)> {
    let mut j = i + 1;
    let closing = src.get(j) == Some(&'/');
    if closing {
        j += 1;
    }
    let name_start = j;
    while j < src.len() && (src[j].is_ascii_alphanumeric() || src[j] == '-') {
        j += 1;
    }
    if j == name_start || !src[name_start].is_ascii_alphabetic() {
        return None;
    }
    let name: String = src[name_start..j].iter().collect::<String>().to_ascii_lowercase();
    match src.get(j) {
        Some('>') => {}
        Some('/') if src.get(j + 1) == Some(&'>') => j += 1,
        Some(c) if c.is_whitespace() => {
            while j < src.len() && src[j] != '>' && src[j] != '<' {
                j += 1;
            }
            if src.get(j) != Some(&'>') {
                return None;
            }
        }
        _ => return None,
    }
    Some((j + 1, !closing && name == "sup"))
}

/// A markdown footnote reference starting at `i` (`[^1]`, `[^levels]`): the
/// index just past it. It sits between a number and its "bits" (`99[^1] bits`)
/// and must not separate them.
fn footnote_at(src: &[char], i: usize) -> Option<usize> {
    if src.get(i) != Some(&'[') || src.get(i + 1) != Some(&'^') {
        return None;
    }
    let close = (i + 2..(i + 34).min(src.len())).find(|&k| src[k] == ']' || src[k] == '[')?;
    (src[close] == ']' && close > i + 2).then_some(close + 1)
}

/// A markdown link starting at `i` (`[label](target)` or `[label][ref]`): the
/// index of its `]`, and the index just past its target. The label is text —
/// the generated document invites people to cite a figure as
/// "[99](docs/SECURITY-LEVELS.md) bits" — so only the markup is blanked.
/// A bracket that opens no link ("[1] see", "bits[99]") is left as text.
fn link_at(src: &[char], i: usize) -> Option<(usize, usize)> {
    if src.get(i) != Some(&'[') {
        return None;
    }
    let close = (i + 1..src.len()).find(|&k| src[k] == ']' || src[k] == '[')?;
    if src[close] != ']' || close == i + 1 {
        return None;
    }
    let shut = match src.get(close + 1) {
        Some('(') => ')',
        Some('[') => ']',
        _ => return None,
    };
    let end = (close + 2..src.len()).find(|&k| src[k] == shut)?;
    Some((close, end + 1))
}

/// Markdown emphasis by underscores around a number ("_99_"), not an
/// underscore inside an identifier ("min_64_bits").
fn is_emphasis_underscore(src: &[char], i: usize) -> bool {
    let before = if i == 0 { None } else { Some(src[i - 1]) };
    let after = src.get(i + 1).copied();
    let opens = after.is_some_and(|c| c.is_ascii_digit()) && !before.is_some_and(|c| c.is_alphanumeric());
    let closes = before.is_some_and(|c| c.is_ascii_digit()) && !after.is_some_and(|c| c.is_alphanumeric());
    opens || closes
}

/// Inline markup blanked, in (char, source index) pairs: a tag, `**`, `*`,
/// `` ` ``, `~~`, `_` around a number, braces and JSX's `{' '}` become one
/// space, and `<sup>` becomes `^` so that "2<sup>64</sup>" stays an exponent.
fn blank_markup(src: &[char]) -> Vec<(char, usize)> {
    let mut s1 = Vec::with_capacity(src.len());
    let mut i = 0;
    // the `]` and target of the markdown link whose `[` was blanked
    let mut link_tail: Option<(usize, usize)> = None;
    while i < src.len() {
        let c = src[i];
        if let Some((close, end)) = link_tail {
            if i == close {
                s1.push((' ', i));
                i = end;
                link_tail = None;
                continue;
            }
        }
        if c == '[' {
            if let Some(end) = footnote_at(src, i) {
                s1.push((' ', i));
                i = end;
                continue;
            }
            if link_tail.is_none() {
                if let Some((close, end)) = link_at(src, i) {
                    link_tail = Some((close, end));
                    s1.push((' ', i));
                    i += 1;
                    continue;
                }
            }
        }
        if c == '<' {
            if let Some((end, sup)) = tag_at(src, i) {
                s1.push((if sup { '^' } else { ' ' }, i));
                i = end;
                continue;
            }
        }
        let jsx_space = c == '{'
            && i + 4 < src.len()
            && matches!(src[i + 1], '\'' | '"')
            && src[i + 2] == ' '
            && src[i + 3] == src[i + 1]
            && src[i + 4] == '}';
        if jsx_space {
            s1.push((' ', i));
            i += 5;
            continue;
        }
        if matches!(c, '*' | '`' | '{' | '}') {
            s1.push((' ', i));
            i += 1;
            continue;
        }
        if c == '~' && src.get(i + 1) == Some(&'~') {
            s1.push((' ', i));
            i += 2;
            continue;
        }
        if c == '_' && is_emphasis_underscore(src, i) {
            s1.push((' ', i));
            i += 1;
            continue;
        }
        s1.push((c, i));
        i += 1;
    }
    s1
}

/// The scanner's view of a text, and where each of its chars comes from.
struct View {
    chars: Vec<char>,
    /// `raw[k]`: the index, in chars of the source text, of the char view
    /// char `k` comes from. Non-decreasing.
    raw: Vec<usize>,
}

/// Markup blanked, entities and escapes decoded, lowercased, and every run of
/// whitespace (a no-break or thin space too) collapsed to one space. Figures,
/// their positions and ledger snippets are all read in this view.
fn view(text: &str) -> View {
    let src: Vec<char> = text.chars().collect();
    let decoded = decode_pairs(&blank_markup(&src));
    let mut chars = Vec::with_capacity(decoded.len());
    let mut raw = Vec::with_capacity(decoded.len());
    for (c, r) in decoded {
        for lc in c.to_lowercase() {
            let lc = if lc.is_whitespace() { ' ' } else { lc };
            if lc == ' ' && chars.last() == Some(&' ') {
                continue;
            }
            chars.push(lc);
            raw.push(r);
        }
    }
    View { chars, raw }
}

pub fn is_security_context(text: &str) -> bool {
    let t = decode(text).to_lowercase();
    SECURITY_WORDS.iter().any(|w| t.contains(w))
}

pub fn families_in(text: &str) -> Vec<Family> {
    let t = decode(text).to_lowercase();
    let mut out: Vec<Family> =
        FAMILY_WORDS.iter().filter(|(_, words)| words.iter().any(|w| t.contains(w))).map(|(f, _)| *f).collect();
    let is_pq = t.split(|c: char| !c.is_alphanumeric()).any(|tok| tok == "pq");
    if is_pq && !out.contains(&Family::Quantum) {
        out.push(Family::Quantum);
    }
    out.sort();
    out
}

fn is_joiner(c: char) -> bool {
    // "128+ bits" (at least 128) is a figure too; U+2009 is a thin space, and
    // U+2012..U+2014 are the figure, en and em dashes a typeset "99–bit" uses
    matches!(
        c,
        ' ' | '\u{a0}' | '\u{202f}' | '\u{2009}' | '-' | '\u{2010}' | '\u{2011}' | '\u{2012}' | '–' | '—' | '+'
    )
}

/// Parse the number that ends just before `end`; returns (start, value).
fn number_before(chars: &[char], end: usize) -> Option<(usize, f64)> {
    let mut k = end;
    while k > 0 {
        let c = chars[k - 1];
        let sep_ok = (c == '.' || c == ',') && k >= 2 && chars[k - 2].is_ascii_digit() && k < end;
        if c.is_ascii_digit() || sep_ok {
            k -= 1;
        } else {
            break;
        }
    }
    if k == end {
        return None;
    }
    // A figure is not an exponent ("2^32 bits"). A number after "/" is read
    // by `figures_in_view`: "a/b bits" is two figures, "(1/rho)/4 bits" none.
    if k > 0 && matches!(chars[k - 1], '^' | '.' | ',') {
        return None;
    }
    if k > 0 && chars[k - 1].is_alphabetic() {
        return None;
    }
    let raw: String = chars[k..end].iter().collect();
    let text = match raw.split_once(',') {
        // "79,405" is a thousands separator, "3,5" a French decimal
        Some((a, b)) if b.len() == 3 && !b.contains(',') => format!("{a}{b}"),
        Some((a, b)) => format!("{a}.{b}"),
        None => raw.clone(),
    };
    text.parse::<f64>().ok().map(|v| (k, v))
}

/// The number an alternative puts before the figure starting at `from`:
/// "<a>/<b> bits", "<a> / <b> bits", "<a> or <b> bits", "<a> ou <b> bits".
fn alternative_before(chars: &[char], from: usize) -> Option<(usize, f64)> {
    let mut back = from;
    while back > 0 && chars[back - 1] == ' ' {
        back -= 1;
    }
    let connector_len = if back >= 1 && chars[back - 1] == '/' {
        1
    } else if back >= 3 && chars[back - 3] == ' ' && matches!((chars[back - 2], chars[back - 1]), ('o', 'r') | ('o', 'u')) {
        2
    } else {
        0
    };
    if connector_len == 0 {
        return None;
    }
    let mut lb = back - connector_len;
    while lb > 0 && chars[lb - 1] == ' ' {
        lb -= 1;
    }
    number_before(chars, lb)
}

const PREIMAGE_WORDS: [&str; 4] = ["preimage", "pre-image", "préimage", "pré-image"];

/// "preimage resistance is 128 bits": the preimage word BEFORE the figure, in
/// the clause the figure closes. The clause runs back from the figure to the
/// nearest `,` `;` `:` `|`, or to the previous figure's "bit", and it must not
/// say "collision" as well: then the word order does not tell which of the two
/// the number is, and the figure stays what it was read as before. (Gate v2
/// r1: only the word order "128-bit preimage" was read, so "SHA-256 preimage
/// resistance is 128 bits; collision ..." matched SHA-256's collision figure.)
fn preimage_clause_before(chars: &[char], begin: usize) -> bool {
    let mut from = begin;
    while from > 0 && !matches!(chars[from - 1], ',' | ';' | ':' | '|') {
        from -= 1;
    }
    let clause: String = chars[from..begin].iter().collect();
    let clause = clause.rfind("bit").map_or(clause.as_str(), |at| &clause[at..]);
    PREIMAGE_WORDS.iter().any(|p| clause.contains(p)) && !clause.contains("collision")
}

/// Every figure of one line, read through `view`.
pub fn figures_in_line(line: &str) -> Vec<Figure> {
    figures_in_view(&view(line).chars)
}

fn figures_in_view(chars: &[char]) -> Vec<Figure> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 <= chars.len() {
        if chars[i..i + 3] != ['b', 'i', 't'] || (i > 0 && chars[i - 1].is_alphabetic()) {
            i += 1;
            continue;
        }
        let mut j = i + 3;
        if chars.get(j) == Some(&'s') {
            j += 1;
        }
        if chars.get(j).is_some_and(|c| c.is_alphanumeric()) {
            i += 1;
            continue;
        }
        let after: String = chars[j..].iter().collect::<String>().trim_start().to_string();
        let is_parameter = ["per ", "par requ", "of grinding", "de grinding", "per-query"]
            .iter()
            .any(|p| after.starts_with(p));
        // "128-bit preimage", "128-bit (preimage)"; the other word order is read
        // below, once the start of the figure is known
        let after_words = after.trim_start_matches(['(', '[', ' ']);
        let preimage_after = PREIMAGE_WORDS.iter().any(|p| after_words.starts_with(p));
        // number, then up to two joiners, then "bit"
        let mut k = i;
        let mut joiners = 0;
        while k > 0 && joiners < 2 && is_joiner(chars[k - 1]) {
            k -= 1;
            joiners += 1;
        }
        let Some((start, high)) = number_before(chars, k) else {
            i = j;
            continue;
        };
        // a denominator ("(1/rho)/4 bits") is not a figure; "a/b bits" is two (below)
        if start > 0 && chars[start - 1] == '/' && alternative_before(chars, start).is_none() {
            i = j;
            continue;
        }
        // a range: "<low> to <high>", "<low> à <high>", "<low>-<high>", "<low>–<high>"
        let mut low = high;
        let mut begin = start;
        let mut back = start;
        while back > 0 && chars[back - 1] == ' ' {
            back -= 1;
        }
        let connector_len = if back >= 2 && chars[back - 2..back] == ['t', 'o'] && (back == 2 || chars[back - 3] == ' ') {
            2
        } else if back >= 1 && matches!(chars[back - 1], 'à' | '-' | '–' | '—' | '\u{2010}' | '\u{2011}' | '\u{2012}') {
            1
        } else {
            0
        };
        if connector_len > 0 {
            let mut lb = back - connector_len;
            while lb > 0 && chars[lb - 1] == ' ' {
                lb -= 1;
            }
            if let Some((s2, v2)) = number_before(chars, lb) {
                if v2 <= high {
                    low = v2;
                    begin = s2;
                }
            }
        }
        let is_preimage = preimage_after || preimage_clause_before(chars, begin);
        // alternatives before it, "a/b bits" and "a or b bits": each is a figure
        let mut alternatives = Vec::new();
        let mut from = begin;
        while let Some((s, v)) = alternative_before(chars, from) {
            let text: String = chars[s..j].iter().collect::<String>().trim().to_string();
            alternatives
                .push(Figure { low: v, high: v, text, start: s, end: j, parameter: is_parameter, preimage: is_preimage });
            from = s;
        }
        out.extend(alternatives.into_iter().rev());
        let text: String = chars[begin..j].iter().collect::<String>().trim().to_string();
        out.push(Figure { low, high, text, start: begin, end: j, parameter: is_parameter, preimage: is_preimage });
        i = j;
    }
    out
}

/// The regimes a figure on line `i` can be matched under. Regime words may sit
/// on a neighbouring line of the same sentence; a hash name and "collision"
/// must be on the figure's own text `own` (its line, or the two lines a
/// wrapped figure spans), or a table row would borrow its neighbour's hash.
fn window_families(lines: &[&str], i: usize, own: &str) -> Vec<Family> {
    let window = lines[i.saturating_sub(1)..(i + 2).min(lines.len())].join("\n");
    let is_hash_tag = |f: &Family| matches!(f, Family::Collision | Family::Sha256 | Family::Poseidon);
    let mut families: Vec<Family> = families_in(&window).into_iter().filter(|f| !is_hash_tag(f)).collect();
    families.extend(families_in(own).into_iter().filter(|f| is_hash_tag(f)));
    families.sort();
    families
}

/// A circuit label ("c7", lowercased) starting at `i` as a whole word: its
/// number and the index just past it.
fn label_at(chars: &[char], i: usize) -> Option<(u32, usize)> {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    if chars.get(i) != Some(&'c') || (i > 0 && is_word(chars[i - 1])) {
        return None;
    }
    let mut j = i + 1;
    while j < chars.len() && chars[j].is_ascii_digit() {
        j += 1;
    }
    if j == i + 1 || (j < chars.len() && is_word(chars[j])) {
        return None;
    }
    chars[i + 1..j].iter().collect::<String>().parse().ok().map(|n| (n, j))
}

/// Ranges of labels, "c0–c4", "c0-c4", "c0 to c4", "c0 à c4", "c0..c4", as
/// (low, high) label numbers.
fn label_ranges(chars: &[char]) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for i in 0..chars.len() {
        let Some((a, mut j)) = label_at(chars, i) else { continue };
        while chars.get(j) == Some(&' ') {
            j += 1;
        }
        let connector = match (chars.get(j), chars.get(j + 1), chars.get(j + 2)) {
            (Some('.'), Some('.'), _) => 2,
            (Some('t'), Some('o'), Some(' ')) => 2,
            (Some('-' | '–' | '—' | 'à'), _, _) => 1,
            _ => continue,
        };
        j += connector;
        while chars.get(j) == Some(&' ') {
            j += 1;
        }
        if let Some((b, _)) = label_at(chars, j) {
            if a < b {
                out.push((a, b));
            }
        }
    }
    out
}

/// The v1 circuits a text names, as labels ("C7"), from the circuits
/// `compact_proof.rs` defines: a label as a word ("C7", "(C7)", "C6/C7"), a
/// range of labels ("C0–C4") naming every label inside it, a circuit's
/// identifier from `params::v1_name` when it has an underscore
/// ("merkle_update"), or any circuit's name followed by "circuit" ("spend
/// circuit", "merkle update circuit"). A bare "spend", "transfer" or "Merkle
/// path" names nothing: those words are everywhere in the prose.
pub fn circuits_in(text: &str) -> Vec<String> {
    let t = decode(text).to_lowercase();
    let chars: Vec<char> = t.chars().collect();
    let words: Vec<&str> = t.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).collect();
    let spaced = format!(" {} ", t.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" "));
    let ranges = label_ranges(&chars);
    let mut out = BTreeSet::new();
    for p in params::v1_circuits() {
        let label = p.label.to_lowercase();
        let number: Option<u32> = label[1..].parse().ok();
        let named = words.contains(&label.as_str())
            || (p.name.contains('_') && words.contains(&p.name.as_str()))
            || spaced.contains(&format!(" {} circuit", p.name.replace('_', " ")))
            || number.is_some_and(|n| ranges.iter().any(|&(a, b)| (a..=b).contains(&n)));
        if named {
            out.insert(p.label);
        }
    }
    out.into_iter().collect()
}

/// A markdown or HTML table row: its neighbours are other rows, whose
/// circuits it must not borrow.
fn is_table_row(line: &str) -> bool {
    let l = line.trim_start().to_lowercase();
    l.starts_with('|') || l.contains("<td") || l.contains("<th") || l.contains("<tr")
}

/// The circuits a figure on line `i` is about: those its own text `own` names
/// (its line, or the two lines a wrapped figure spans), or, outside a table,
/// those a neighbouring line of the same sentence names.
fn line_circuits(lines: &[&str], i: usize, own: &str, table: bool) -> Vec<String> {
    let own = circuits_in(own);
    if !own.is_empty() || table {
        return own;
    }
    circuits_in(&lines[i.saturating_sub(1)..(i + 2).min(lines.len())].join("\n"))
}

/// Whether `rest` — a line with its indentation and any `//` or `>` marker
/// already dropped — opens a NEW list item: `- `, `* `, `+ `, `• `, `1. `,
/// `2) ` or an HTML `<li>`. The CONTINUATION of a list item is not one: only a
/// new item breaks a wrap, which is why `docs/zk-simulation-argument.md:393`
/// (the marker on the first line, "bits," on the second) still joins.
fn starts_a_list_item(rest: &str) -> bool {
    let chars: Vec<char> = rest.chars().collect();
    let is_end = |k: usize| matches!(chars.get(k), Some(' ') | Some('\t') | None);
    if chars.len() >= 3 && chars[0] == '<' && chars[1].eq_ignore_ascii_case(&'l') && chars[2].eq_ignore_ascii_case(&'i') {
        return true;
    }
    match chars.first() {
        Some('-' | '*' | '+' | '\u{2022}') => is_end(1),
        Some(d) if d.is_ascii_digit() => {
            let mut k = 0;
            while chars.get(k).is_some_and(char::is_ascii_digit) {
                k += 1;
            }
            matches!(chars.get(k), Some('.' | ')')) && is_end(k + 1)
        }
        _ => false,
    }
}

/// HTML elements that end a sentence the way a table row or a list item does:
/// what sits on either side of one is not one run of text.
const HTML_BLOCK_TAGS: &[&str] = &[
    "tr", "td", "th", "table", "thead", "tbody", "tfoot", "caption", "p", "div", "hr", "br", "h1", "h2", "h3", "h4",
    "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "section", "article", "header", "footer", "blockquote", "pre",
    "figure", "figcaption", "details", "summary",
];

/// Whether the tag that starts at `chars[0] == '<'` (opening, closing or
/// self-closed) is a block-level one. The NAME is compared, whole and without
/// case, so `<path>` and `<param-x>` are not `<p>`.
fn is_block_tag(chars: &[char]) -> bool {
    if chars.first() != Some(&'<') {
        return false;
    }
    let from = if chars.get(1) == Some(&'/') { 2 } else { 1 };
    let name: String = chars[from..]
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || **c == '-')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    HTML_BLOCK_TAGS.contains(&name.as_str())
}

/// Whether the break between `head` (the previous line, trimmed at its end)
/// and `rest` (this line's text) is an HTML row, cell or block boundary: a
/// block-level tag starts `rest`, or ends `head`. An inline tag (`<strong>`,
/// `<code>`) is not one, and neither is a block tag away from the break, so a
/// figure wrapped inside one `<td>` or one `<p>` still joins.
///
/// Gate v2 r1 found the hole: "... sits at 41</td></tr>" / "<tr><td>- 45 bits"
/// read as the range 41 to 45, which matches. Same false channel as the
/// markdown table row and the list item round 3 closed.
fn html_block_boundary(head: &str, rest: &str) -> bool {
    let rest: Vec<char> = rest.chars().collect();
    if is_block_tag(&rest) {
        return true;
    }
    let head: Vec<char> = head.chars().collect();
    if head.last() != Some(&'>') {
        return false;
    }
    match head.iter().rposition(|c| *c == '<') {
        Some(open) => is_block_tag(&head[open..]),
        None => false,
    }
}

/// Line `i` joined to the line before it, for a figure wrapped across the
/// break: (the previous line's text, one space, line `i`'s continuation; the
/// char index where the continuation starts; how many chars of line `i` the
/// continuation drops: its indentation and a `//` or `>` marker). None when
/// either line is a markdown table row, none when line `i` opens a new list
/// item, and none across an HTML row, cell or block boundary
/// (`html_block_boundary`): each of those is a sentence of its own, and
/// joining it read its marker as the "-" of a range ("... at 41" / "- 45 bits"
/// as 41 to 45, round 3, Y1; the HTML spellings, gate v2 r1). A blank line
/// needs no rule: only adjacent lines are joined, and no figure can start or
/// end on a blank one.
fn soft_wrap(lines: &[&str], i: usize) -> Option<(String, usize, usize)> {
    if i == 0 {
        return None;
    }
    let (prev, cur) = (lines[i - 1], lines[i]);
    if prev.trim_start().starts_with('|') || cur.trim_start().starts_with('|') {
        return None;
    }
    let head = prev.trim_end();
    let t = cur.trim_start();
    let rest = if let Some(r) = t.strip_prefix("//") {
        r.trim_start_matches('/')
    } else if let Some(r) = t.strip_prefix('>') {
        r
    } else {
        t
    };
    let rest = rest.trim_start();
    if starts_a_list_item(rest) || html_block_boundary(head, rest) {
        return None;
    }
    let skip = cur.chars().count() - rest.chars().count();
    Some((format!("{head} {rest}"), head.chars().count() + 1, skip))
}

/// Every figure of `text`, whatever its context: the context only decides
/// which regimes and circuits a figure can match (`window_families`,
/// `line_circuits`), never whether it is looked at. A figure wrapped across a
/// line break is read on the two lines joined (`soft_wrap`), and replaces what
/// the second line alone reads for the same "bit" ("130 bits" becomes "110 to
/// 130 bits").
pub fn scan_text(path: &str, text: &str) -> Vec<Hit> {
    let lines: Vec<&str> = text.lines().collect();
    let mut hits = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let own = view(line);
        let mut figures = figures_in_view(&own.chars);
        let mut wrapped: Vec<Figure> = Vec::new();
        let mut joined = String::new();
        if let Some((j, boundary, skip)) = soft_wrap(&lines, i) {
            let v = view(&j);
            // the first view char of line i's part
            let b = v.raw.partition_point(|&r| r < boundary);
            let joined_figs = figures_in_view(&v.chars);
            // where, in line i, the "bit" of a figure that starts on the previous line ends
            let in_line = |f: &Figure| v.raw[f.end - 1] - boundary + skip;
            let ends: Vec<usize> = joined_figs.iter().filter(|f| f.start < b && f.end > b).map(in_line).collect();
            if !ends.is_empty() {
                figures.retain(|g| !ends.contains(&own.raw[g.end - 1]));
                wrapped = joined_figs.into_iter().filter(|f| f.end > b && ends.contains(&in_line(f))).collect();
                joined = j;
            }
        }
        let table = is_table_row(line);
        if !wrapped.is_empty() {
            let families = window_families(&lines, i, &joined);
            let circuits = line_circuits(&lines, i, &joined, table || is_table_row(lines[i - 1]));
            for figure in wrapped {
                hits.push(Hit {
                    path: path.to_string(),
                    line_no: i,
                    line_end: i + 1,
                    line: joined.clone(),
                    figure,
                    families: families.clone(),
                    circuits: circuits.clone(),
                });
            }
        }
        if figures.is_empty() {
            continue;
        }
        let families_window = window_families(&lines, i, line);
        let circuits = line_circuits(&lines, i, line, table);
        for figure in figures {
            hits.push(Hit {
                path: path.to_string(),
                line_no: i + 1,
                line_end: i + 1,
                line: line.to_string(),
                figure,
                families: families_window.clone(),
                circuits: circuits.clone(),
            });
        }
    }
    hits
}

fn extension_of(name: &str) -> &str {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("")
}

/// Whether `name`'s extension is one of `exts`, whatever its case ("deck.PDF").
fn has_extension(name: &str, exts: &[&str]) -> bool {
    exts.contains(&extension_of(name).to_ascii_lowercase().as_str())
}

fn walk(root: &Path, rel: &str, exts: &[&str], out: &mut Vec<String>) {
    let abs = root.join(rel);
    if abs.is_file() {
        if has_extension(rel, exts) {
            out.push(rel.to_string());
        }
        return;
    }
    let Ok(entries) = fs::read_dir(&abs) else { return };
    let mut names: Vec<String> = entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for name in names {
        if SKIPPED_DIRECTORIES.contains(&name.as_str()) {
            continue;
        }
        let child = format!("{rel}/{name}");
        let child_abs = root.join(&child);
        if child_abs.is_dir() {
            walk(root, &child, exts, out);
        } else if has_extension(&name, exts) {
            out.push(child);
        }
    }
}

/// Binary exports under `SCAN_ROOTS`: the scanner cannot read them (this crate
/// has no dependency, so no PDF or PPTX parser).
pub const BINARY_EXPORT_EXTENSIONS: &[&str] = &["pdf", "pptx", "docx", "odt", "odp", "key"];

/// Binary exports with no scanned text source of the same stem, and why.
/// Nothing re-checks what they say: a figure added to one is invisible here.
pub const UNSCANNED_EXPORTS: &[(&str, &str)] = &[(
    "docs/pitch-x-quantum-2026-05-24-v2.pptx",
    "10-slide deck with no .md or .html source; on 2026-09-19 none of its 31 XML parts contained \"bit\" \
     (scratchpad/v2-run/logs/WP1-fix1b-binary-exports.log). The other deck, pitch-x-quantum-2026-05-24.pptx, \
     is covered by its .md and .html sources",
)];

/// A binary export and the scanned text file of the same stem next to it, if any.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryExport {
    pub path: String,
    pub source: Option<String>,
}

/// Every binary export under `SCAN_ROOTS`, with its scanned source.
pub fn binary_exports(root: &Path) -> Vec<BinaryExport> {
    let mut files = Vec::new();
    for r in SCAN_ROOTS {
        walk(root, r, BINARY_EXPORT_EXTENSIONS, &mut files);
    }
    files
        .into_iter()
        .map(|path| {
            let stem = &path[..path.len() - extension_of(&path).len() - 1];
            let source = TEXT_EXTENSIONS
                .iter()
                .map(|ext| format!("{stem}.{ext}"))
                .find(|twin| twin != crate::DOC_PATH && root.join(twin).is_file());
            BinaryExport { path, source }
        })
        .collect()
}

/// Whether the scan reads `rel`: a read extension, outside a skipped
/// directory, not the generated document and not a local-only file.
pub fn is_scanned(rel: &str) -> bool {
    has_extension(rel, TEXT_EXTENSIONS)
        && !rel.split('/').any(|p| SKIPPED_DIRECTORIES.contains(&p))
        && rel != crate::DOC_PATH
        && !LOCAL_ONLY_FILES.iter().any(|(p, _)| *p == rel)
}

/// A file under `SCAN_ROOTS` the scan does not read, that nevertheless states
/// a figure: a blind spot with something in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlindSpot {
    pub path: String,
    /// Why it is not read, in the words of the lists above.
    pub reason: &'static str,
    /// The figures it states, as written.
    pub figures: Vec<String>,
}

/// Every file under `SCAN_ROOTS` the scan does not read — another extension,
/// or a `dist`/`build` directory — that states a figure. Binary exports have
/// their own check (`binary_exports`), dependency trees are not ours, and a
/// file that is not valid UTF-8, or that holds a NUL byte, is binary, not
/// prose. The generated document is excluded, as it is from the scan.
///
/// Round 3 found this hole: `docs/soundness-diagram.mmd` or `docs/build/
/// notes.md` could carry a stale "N bits unconditional" with the suite green
/// (Y5, Y6 of `verify-WP1-r3-mutations.log`).
pub fn unread_files_with_figures(root: &Path) -> Vec<BlindSpot> {
    let mut files = Vec::new();
    for r in SCAN_ROOTS {
        walk_all(root, r, &mut files);
    }
    let mut out = Vec::new();
    for rel in files {
        if is_scanned(&rel) || has_extension(&rel, BINARY_EXPORT_EXTENSIONS) || rel == crate::DOC_PATH {
            continue;
        }
        let reason = if let Some((_, why)) = LOCAL_ONLY_FILES.iter().find(|(p, _)| *p == rel) {
            why
        } else if rel.split('/').any(|p| SKIPPED_DIRECTORIES.contains(&p)) {
            "under a directory the scan does not enter (SKIPPED_DIRECTORIES)"
        } else {
            "its extension is not one the scan reads (TEXT_EXTENSIONS)"
        };
        let Ok(bytes) = fs::read(root.join(&rel)) else { continue };
        // an image or another binary is not prose, whatever its extension
        let Ok(text) = String::from_utf8(bytes) else { continue };
        if text.bytes().any(|b| b == 0) {
            continue;
        }
        let figures: Vec<String> =
            scan_text(&rel, &text).into_iter().filter(|h| !h.figure.parameter).map(|h| h.figure.text).collect();
        if !figures.is_empty() {
            out.push(BlindSpot { path: rel, reason, figures });
        }
    }
    out
}

/// Every file under `rel`, whatever its extension, dependency trees excepted.
fn walk_all(root: &Path, rel: &str, out: &mut Vec<String>) {
    let abs = root.join(rel);
    if abs.is_file() {
        out.push(rel.to_string());
        return;
    }
    let Ok(entries) = fs::read_dir(&abs) else { return };
    let mut names: Vec<String> =
        entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for name in names {
        if DEPENDENCY_DIRECTORIES.contains(&name.as_str()) {
            continue;
        }
        let child = format!("{rel}/{name}");
        if root.join(&child).is_dir() {
            walk_all(root, &child, out);
        } else {
            out.push(child);
        }
    }
}

/// Every figure under `SCAN_ROOTS`, the generated document and the local-only
/// files excepted.
pub fn scan_repo(root: &Path) -> Vec<Hit> {
    let mut files = Vec::new();
    for r in SCAN_ROOTS {
        walk(root, r, TEXT_EXTENSIONS, &mut files);
    }
    let mut hits = Vec::new();
    for rel in files {
        if !is_scanned(&rel) {
            continue;
        }
        let Ok(bytes) = fs::read(root.join(&rel)) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        hits.extend(scan_text(&rel, &text));
    }
    hits
}

/// What `docs/SECURITY-LEVELS.md` publishes: (regime or hash, integer) pairs;
/// apart from them the quantum (BHT) collision figures of each hash; and the
/// regime figures of each circuit, by label.
#[derive(Clone, Debug, Default)]
pub struct Published(
    pub BTreeSet<(Family, u32)>,
    pub BTreeSet<(Family, u32)>,
    pub BTreeMap<String, BTreeSet<(Family, u32)>>,
);

/// Regime figures key on their regime; collision figures on their hash.
fn family_of(label: &str, slug: &str) -> Option<Family> {
    Some(match slug {
        "unique-decoding" => Family::UniqueDecoding,
        "johnson-bciks20" | "johnson-bchks25" => Family::Johnson,
        "conjectured" => Family::Conjectured,
        s if s.starts_with("quantum-") => Family::Quantum,
        "collision" => match label {
            "sha256" => Family::Sha256,
            "v1-digest" => Family::Poseidon,
            _ => return None,
        },
        _ => return None,
    })
}

pub fn parse_published(doc: &str) -> Published {
    let mut set = BTreeSet::new();
    let mut quantum = BTreeSet::new();
    let mut per_circuit: BTreeMap<String, BTreeSet<(Family, u32)>> = BTreeMap::new();
    let doc = doc.replace("\r\n", "\n");
    let (Some(a), Some(b)) = (doc.find("<!-- published-figures:begin -->"), doc.find("<!-- published-figures:end -->")) else {
        return Published(set, quantum, per_circuit);
    };
    for line in doc[a..b].lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() != 3 {
            continue;
        }
        let Ok(v) = parts[2].parse::<u32>() else { continue };
        if parts[1] == "collision-quantum" {
            if let Some(f) = family_of(parts[0], "collision") {
                quantum.insert((f, v));
            }
        } else if let Some(f) = family_of(parts[0], parts[1]) {
            set.insert((f, v));
            if !matches!(f, Family::Sha256 | Family::Poseidon) {
                per_circuit.entry(parts[0].to_string()).or_default().insert((f, v));
            }
        }
    }
    Published(set, quantum, per_circuit)
}

/// `figure_matches_in` for a sentence that names no circuit: the figure must
/// hold for every circuit.
pub fn figure_matches(fig: &Figure, families: &[Family], published: &Published) -> bool {
    figure_matches_in(fig, families, &[], published)
}

/// What the check runs: the hit's figure, regimes and circuits.
pub fn hit_matches(hit: &Hit, published: &Published) -> bool {
    figure_matches_in(&hit.figure, &hit.families, &hit.circuits, published)
}

/// Whether `fig` is published for one of `families`, for the circuits
/// `circuits` (labels; empty = every circuit the block publishes). A regime
/// figure matches when every one of those circuits publishes a value for that
/// regime inside [low, high] (floors), and low and high are each published by
/// one of them: "C0 and C7 have 42" fails because C7 publishes 41, and so does
/// an unnamed "42 to 45" while C5 publishes 41. A circuit the block does not
/// publish matches nothing. A hash figure matches on its hash, whatever the
/// circuits.
pub fn figure_matches_in(fig: &Figure, families: &[Family], circuits: &[String], published: &Published) -> bool {
    if fig.parameter {
        return false;
    }
    let lo = fig.low.floor() as u32;
    let hi = fig.high.floor() as u32;
    let says_collision = families.contains(&Family::Collision);
    let says_quantum = families.contains(&Family::Quantum);
    let scope: Option<Vec<&BTreeSet<(Family, u32)>>> = if circuits.is_empty() {
        Some(published.2.values().collect())
    } else {
        circuits.iter().map(|c| published.2.get(c)).collect()
    };
    families.iter().any(|&f| match f {
        // a hash figure needs "collision" and its hash on the line; a quantum
        // word selects the quantum (BHT) figures of that hash
        Family::Sha256 | Family::Poseidon => {
            let set = if says_quantum { &published.1 } else { &published.0 };
            says_collision && !fig.preimage && set.contains(&(f, lo)) && set.contains(&(f, hi))
        }
        Family::Collision => false,
        _ => match &scope {
            Some(scope) if !scope.is_empty() => {
                scope.iter().all(|set| set.iter().any(|&(g, v)| g == f && lo <= v && v <= hi))
                    && scope.iter().any(|set| set.contains(&(f, lo)))
                    && scope.iter().any(|set| set.contains(&(f, hi)))
            }
            _ => false,
        },
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerKind {
    /// Checked by hand against the generated file: correct, but the scanner
    /// cannot tell which figure of the line belongs to which regime.
    Verified,
    /// Describes a figure as past, withdrawn or superseded, and says so.
    Historical,
    /// A figure about another system (stwo, Zcash, a symmetric cipher, ...).
    External,
    /// A width or a parameter, not a security level.
    NotALevel,
    /// A v2 design figure, quoted as a candidate.
    V2Candidate,
    /// FINDING: stated as a current level, and not what the calculator gives.
    Stale,
}

#[derive(Clone, Debug)]
pub struct LedgerEntry {
    pub kind: LedgerKind,
    pub path: String,
    /// A substring of the line that contains the figure(s) the row covers, or
    /// "*" for every unmatched figure in the file.
    pub snippet: String,
    /// Required for "*": how many unmatched figures the row covers.
    pub count: Option<usize>,
    pub reason: String,
    /// 1-based line of the ledger file.
    pub line_no: usize,
}

pub fn parse_ledger(text: &str) -> Result<Vec<LedgerEntry>, String> {
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 5 {
            return Err(format!("line {}: expected 5 tab-separated fields, got {}", i + 1, f.len()));
        }
        let kind = match f[0] {
            "verified" => LedgerKind::Verified,
            "historical" => LedgerKind::Historical,
            "external" => LedgerKind::External,
            "not-a-level" => LedgerKind::NotALevel,
            "v2-candidate" => LedgerKind::V2Candidate,
            "stale" => LedgerKind::Stale,
            other => return Err(format!("line {}: unknown kind {other:?}", i + 1)),
        };
        if f[1].is_empty() || f[2].is_empty() {
            return Err(format!("line {}: empty path or snippet", i + 1));
        }
        let count = if f[3].is_empty() {
            None
        } else {
            Some(f[3].parse::<usize>().map_err(|e| format!("line {}: count {:?}: {e}", i + 1, f[3]))?)
        };
        if f[2] == "*" && count.is_none() {
            return Err(format!("line {}: a whole-file row (\"*\") needs a count", i + 1));
        }
        if f[2] != "*" && figures_in_line(f[2]).is_empty() {
            return Err(format!(
                "line {}: the snippet {:?} contains no figure; a row covers only the figures inside its snippet",
                i + 1,
                f[2]
            ));
        }
        if f[4].trim().is_empty() {
            return Err(format!("line {}: a row needs a reason", i + 1));
        }
        out.push(LedgerEntry {
            kind,
            path: f[1].to_string(),
            snippet: f[2].to_string(),
            count,
            reason: f[4].to_string(),
            line_no: i + 1,
        });
    }
    Ok(out)
}

/// Where `snippet` occurs in `line`, as `[start, end)` char ranges of the
/// scanner's view of the line (`view`), the view `Figure::start` and
/// `Figure::end` are in. The snippet is read through the same view, trimmed.
fn snippet_spans(snippet: &str, line: &str) -> impl Iterator<Item = (usize, usize)> {
    let hay: Vec<char> = view(line).chars;
    let mut needle: Vec<char> = view(snippet).chars;
    while needle.last() == Some(&' ') {
        needle.pop();
    }
    let lead = needle.iter().take_while(|&&c| c == ' ').count();
    needle.drain(..lead);
    let n = needle.len();
    let spans: Vec<(usize, usize)> = if n == 0 || n > hay.len() {
        Vec::new()
    } else {
        (0..=hay.len() - n).filter(|&s| hay[s..s + n] == needle[..]).map(|s| (s, s + n)).collect()
    };
    spans.into_iter()
}

/// A row covers a figure when the figure lies inside an occurrence of the
/// row's snippet on the figure's line. A figure added to, or changed on, a
/// listed line is therefore not covered unless the row's snippet names it.
pub fn entry_covers(entry: &LedgerEntry, hit: &Hit) -> bool {
    entry.path == hit.path && (entry.snippet == "*" || snippet_spans(&entry.snippet, &hit.line).any(|(a, b)| a <= hit.figure.start && hit.figure.end <= b))
}

#[derive(Clone, Debug, Default)]
pub struct Verdict {
    /// Figures that match a published figure.
    pub matched: usize,
    /// Figures that do not, and that the ledger lists.
    pub covered: usize,
    /// Figures that do not, and that the ledger does not list.
    pub uncovered: Vec<Hit>,
    /// Ledger rows that cover no unmatched figure.
    pub dead: Vec<LedgerEntry>,
    /// Rows with a count whose coverage differs: (row, figures covered now).
    pub count_mismatch: Vec<(LedgerEntry, usize)>,
    /// Number of `stale` rows.
    pub stale: usize,
    /// Number of figures a `stale` row covers: the findings, one per figure.
    pub stale_figures: usize,
}

pub fn check(hits: &[Hit], published: &Published, ledger: &[LedgerEntry]) -> Verdict {
    let mut v = Verdict::default();
    let mut coverage = vec![0usize; ledger.len()];
    let mut stale_hits = 0;
    for hit in hits {
        if hit_matches(hit, published) {
            v.matched += 1;
            continue;
        }
        let mut covered = false;
        let mut stale = false;
        for (i, e) in ledger.iter().enumerate() {
            if entry_covers(e, hit) {
                coverage[i] += 1;
                covered = true;
                stale |= e.kind == LedgerKind::Stale;
            }
        }
        if stale {
            stale_hits += 1;
        }
        if covered {
            v.covered += 1;
        } else {
            v.uncovered.push(hit.clone());
        }
    }
    for (i, e) in ledger.iter().enumerate() {
        if coverage[i] == 0 {
            v.dead.push(e.clone());
        } else if let Some(c) = e.count {
            if c != coverage[i] {
                v.count_mismatch.push((e.clone(), coverage[i]));
            }
        }
    }
    v.stale = ledger.iter().filter(|e| e.kind == LedgerKind::Stale).count();
    v.stale_figures = stale_hits;
    v
}
