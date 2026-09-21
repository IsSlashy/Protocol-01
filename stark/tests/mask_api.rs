//! ⛔ LEAK-LEDGER A8 — the blinding mask can only come from the CSPRNG.
//!
//! A8 was: every `build_*_trace` in `stark/src/air/*.rs` and every
//! `generate_*_proof` in `stark/src/compact.rs` took the mask as a bare slice
//! and checked only its LENGTH. The shipped wasm entry points always drew it
//! from the OS CSPRNG, so web, extension and phone were never affected — but
//! the API let any other caller pass a zero, reused or deterministic mask and
//! get back a proof that verifies and hides nothing. The verifier cannot tell:
//! the mask is never published.
//!
//! The closure is by construction, so the evidence has to be a COMPILE
//! failure, not a runtime assert. Two halves:
//!
//! 1. `compile_fail_ui` — five programs in `tests/ui/` that must not compile.
//!    Two of them ARE A8: handing a raw slice to `build_spend_trace`, and
//!    handing raw `u64`s to `generate_spend_compact_proof`. Both compiled
//!    cleanly before this change, with an all-zero mask.
//!
//! 2. `the_raw_constructors_are_gated_out_of_every_shipping_build` — the ui
//!    programs compile with this test target's feature set, which has
//!    `deterministic-mask-for-tests` ON, so they cannot speak to whether the
//!    escape hatch ships. That is pinned on the source and the manifest
//!    instead, the same instrument `compact/zk_hiding.rs` already uses to
//!    count `draw_blinding_mask` sites in the generator.
//!
//! 3. [gate v2 r1, R2] Two holes the round-1 gate measured in the pins above,
//!    closed here:
//!    * `a_wrong_length_mask_panics_at_run_time_in_every_builder` — the length
//!      pin used to be a source grep, and `debug_assert_eq!` contains the text
//!      it looked for, so demoting the check (gone from every `--release`
//!      build, the wasm prover included) left the suite green. This one hands
//!      a wrong-length mask to the eight builders and demands the panic.
//!      ⛔ It only bites in `--release`: a debug build keeps `debug_assert!`.
//!      The source pin now refuses the `debug_` spelling too, for debug runs.
//!    * `draw_is_the_only_ungated_way_to_a_mask` — the constructor pin counted
//!      functions NAMED `from_raw*`, so an ungated `pub fn of_chosen(..) ->
//!      Self` went red only by accident (a rustc hint inside two `.stderr`
//!      files). This one reads the whole `impl BlindingMask` and the whole
//!      crate, whatever the names are.
//!    * `the_mask_has_no_trait_that_prints_copies_or_builds_it` — `Debug` and
//!      `Clone` were described as deliberate and tested by nothing.
//!
//! What none of this pins, because it is not true: that a drawn mask cannot be
//! read or reused. `as_slice().to_vec()` copies the values out and `&mask` can
//! be handed to two proofs. A8 is about PROVENANCE in safe Rust in a shipping
//! build; single use would need a by-value API.
//!
//! Run: `cargo test -p p01-stark --release --test mask_api`

use std::path::{Path, PathBuf};

use p01_stark::air;
use p01_stark::{BaseElement, BlindingMask};

/// Sources in this repo are a mix of LF and CRLF; the pins below are written
/// with LF, so read through this.
fn read(p: std::path::PathBuf) -> String {
    std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("{}: {e}", p.display()))
        .chars()
        .filter(|c| *c != '\r')
        .collect()
}

/// The five programs in `tests/ui/` must all fail to compile.
///
/// ⛔ RED-FIRST NOTE. Before the `BlindingMask` newtype, two of these five
/// compiled cleanly — `build_trace_from_slice.rs` with an all-zero
/// `Vec<BaseElement>` and `generate_proof_from_u64s.rs` with
/// `vec![0u64; MASK_LEN]` — and this test failed with `expected test case to
/// fail to compile, but it succeeded`. That message IS the A8 defect, stated
/// as a program. The red log is in the WP0b report.
#[test]
fn compile_fail_ui() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/ui/*.rs");
}

/// `from_raw_for_tests` / `from_raw_u64_for_tests` must be unreachable from a
/// default build, or the newtype is a suggestion rather than a gate.
///
/// The ui programs cannot check this: `trybuild` compiles them with this
/// target's feature set, which has `deterministic-mask-for-tests` on. So this
/// reads the source and the manifest directly.
#[test]
fn the_raw_constructors_are_gated_out_of_every_shipping_build() {
    let lib = read(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"));
    let manifest = read(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"));

    // 1. The struct has exactly one field and it is private.
    assert!(
        lib.contains("pub struct BlindingMask(Vec<BaseElement>);"),
        "the newtype must keep a single PRIVATE field; a `pub` field reopens A8 silently"
    );

    // 2. Every raw constructor carries the cfg gate, and there are no others.
    let gate = "#[cfg(any(test, feature = \"deterministic-mask-for-tests\"))]";
    let raw_ctors = ["pub fn from_raw_for_tests", "pub fn from_raw_u64_for_tests"];
    for ctor in raw_ctors {
        let at = lib
            .find(ctor)
            .unwrap_or_else(|| panic!("{ctor} vanished — update this pin with the new name"));
        let before = &lib[..at];
        assert!(
            before.trim_end().ends_with(gate),
            "{ctor} is not immediately preceded by {gate}"
        );
    }
    let declared = lib.matches("    pub fn from_raw").count();
    assert_eq!(
        declared,
        raw_ctors.len(),
        "a new `from_raw*` constructor appeared on BlindingMask; gate it and pin it here"
    );

    // 3. `draw` is the only ungated public constructor.
    assert!(
        lib.contains("pub fn draw(len: usize) -> Result<Self, getrandom::Error>"),
        "BlindingMask::draw must stay the public constructor"
    );

    // 4. The escape-hatch feature is NOT in `default`, so `cargo build`,
    //    `cargo build-sbf` and `wasm-pack build stark -- --features wasm` never
    //    compile it. It is reachable only through `test-probes` (a dev-only
    //    feature of the verifier crate) and this crate's own dev-dependency.
    let default_line = manifest
        .lines()
        .find(|l| l.trim_start().starts_with("default = "))
        .expect("stark/Cargo.toml has no `default = [...]`");
    assert!(
        !default_line.contains("deterministic-mask-for-tests"),
        "`deterministic-mask-for-tests` is in `default`: the escape hatch ships. Line: {default_line}"
    );
    let wasm_line = manifest
        .lines()
        .find(|l| l.trim_start().starts_with("wasm = "))
        .expect("stark/Cargo.toml has no `wasm = [...]`");
    assert!(
        !wasm_line.contains("deterministic-mask-for-tests"),
        "`wasm` pulls in the escape hatch: the shipped prover blob would carry it. Line: {wasm_line}"
    );

    // 5. No `Debug` on the mask: a `{:?}` in a log or a panic message publishes
    //    the one value the hiding argument assumes nobody ever sees.
    assert!(
        !lib.contains("derive(Debug)]\npub struct BlindingMask")
            && !lib.contains("impl std::fmt::Debug for BlindingMask")
            && !lib.contains("impl core::fmt::Debug for BlindingMask"),
        "BlindingMask must not be printable"
    );
}

/// The gate must not have been bought by deleting the length checks: a mask of
/// the wrong length still has to be refused, loudly, at every entry point.
#[test]
fn the_length_check_survived_the_newtype() {
    let air = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/air");
    let mut checked = 0usize;
    for file in [
        "balance_proof.rs",
        "confidential_balance.rs",
        "denominated_pool.rs",
        "merkle_path.rs",
        "merkle_update.rs",
        "spend.rs",
        "subscriber_ownership.rs",
        "transfer.rs",
    ] {
        let src = read(air.join(file));
        assert!(
            src.contains("mask: &BlindingMask"),
            "{file} still takes a raw mask slice"
        );
        // C3 and C6 are depth-parametric, so their expected length is
        // `mask_len_for_depth(depth)` rather than a `MASK_LEN` constant.
        // [gate v2 r1, R2] Anchored on the line start: `debug_assert_eq!(`
        // contains `assert_eq!(`, and a debug assert is absent from every
        // release build. The behaviour itself is pinned by the run-time probe
        // below; this half is what still bites in a debug `cargo test`.
        assert!(
            src.contains("\n    assert_eq!(\n        mask.len(),\n        MASK_LEN")
                || src.contains(
                    "\n    assert_eq!(\n        mask.len(),\n        mask_len_for_depth(depth)"
                ),
            "{file} lost the `assert_eq!` that pins the mask LENGTH (a `debug_assert_eq!` does \
             not count: it is compiled out of `--release`, so out of the shipped prover); the \
             newtype pins provenance, not size, and both are load-bearing"
        );
        checked += 1;
    }
    assert_eq!(checked, 8, "all eight shipped circuits must be covered");
}

// ---------------------------------------------------------------------------
// [gate v2 r1, R2] The length check, as BEHAVIOUR.
// ---------------------------------------------------------------------------

/// `(left, right)` of an `assert_eq!` panic message, whatever surrounds them.
fn left_right(msg: &str) -> Option<(usize, usize)> {
    fn number_after(msg: &str, key: &str) -> Option<usize> {
        let at = msg.rfind(key)? + key.len();
        let digits: String = msg[at..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse().ok()
    }
    Some((number_after(msg, "left:")?, number_after(msg, "right:")?))
}

/// Runs `f` on a mask of `got` elements and demands the LENGTH assert's panic:
/// an `assert_eq!` whose left is `got` and whose right is `want`.
///
/// Two ways to be wrong, both told apart from the real thing:
/// * no panic at all — the check is gone (that is sabotage S4 in `--release`
///   with a too-long mask: the builder just reads the first `want` elements);
/// * a panic that is not this assert — with a too-short mask and no check, the
///   builder dies on a slice index instead, which carries no `left`/`right`.
fn must_refuse(circuit: &str, want: usize, got: usize, f: &dyn Fn(&BlindingMask)) -> Result<(), String> {
    let mask = BlindingMask::from_raw_for_tests(vec![BaseElement::new(7); got]);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mask)));
    let payload = match outcome {
        Ok(()) => {
            return Err(format!(
                "{circuit}: a mask of {got} elements was ACCEPTED where {want} are required"
            ))
        }
        Err(p) => p,
    };
    let msg = payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    match left_right(&msg) {
        Some((l, r)) if l == got && r == want => Ok(()),
        _ => Err(format!(
            "{circuit}: a mask of {got} elements (want {want}) panicked, but not on the length \
             assert: {:?}",
            msg.lines().next().unwrap_or("")
        )),
    }
}

/// A wrong-length mask must PANIC, at run time, in each of the eight builders,
/// and on the length assert itself.
///
/// ⛔ Run it in `--release`. That is where `debug_assert_eq!` vanishes, and the
/// shipped wasm prover is a release build. In a debug build this test cannot
/// tell `assert_eq!` from `debug_assert_eq!`; the source pin above can.
///
/// The probe calls `build_*_trace` directly rather than `generate_*_proof`,
/// because `generate_spend_compact_proof` repeats the check in `compact.rs` and
/// would hide a demoted assert in `air/spend.rs` behind its own.
#[test]
fn a_wrong_length_mask_panics_at_run_time_in_every_builder() {
    let e = BaseElement::new;
    let path = |d: usize| -> (Vec<BaseElement>, Vec<u8>) {
        ((0..d as u64).map(|i| e(1000 + 37 * i)).collect(), (0..d).map(|i| (i % 2) as u8).collect())
    };
    let (pe3, pi3) = path(air::merkle_path::CANONICAL_DEPTH);
    let (pe6, pi6) = path(air::merkle_update::CANONICAL_DEPTH);
    let (pe7, pi7) = path(air::spend::CANONICAL_DEPTH);

    type Probe<'a> = (&'static str, usize, Box<dyn Fn(&BlindingMask) + 'a>);
    let probes: Vec<Probe<'_>> = vec![
        ("C0 subscriber_ownership", air::subscriber_ownership::MASK_LEN, Box::new(|m| {
            let _ = air::subscriber_ownership::build_masked_trace(e(42), m);
        })),
        ("C1 denominated_pool", air::denominated_pool::MASK_LEN, Box::new(|m| {
            let _ = air::denominated_pool::build_pool_commitment_trace(e(111), e(222), e(333), e(444), m);
        })),
        ("C2 balance_proof", air::balance_proof::MASK_LEN, Box::new(|m| {
            let _ = air::balance_proof::build_balance_proof_trace(e(42), e(1000), e(777), e(999), m);
        })),
        ("C3 merkle_path", air::merkle_path::mask_len_for_depth(pe3.len()), Box::new(|m| {
            let _ = air::merkle_path::build_merkle_trace(e(777), &pe3, &pi3, m);
        })),
        ("C4 confidential_balance", air::confidential_balance::MASK_LEN, Box::new(|m| {
            let _ = air::confidential_balance::build_confidential_balance_trace(
                e(42), e(1000), e(111), e(800), e(222), e(200), e(333), e(999), m,
            );
        })),
        ("C5 transfer", air::transfer::MASK_LEN, Box::new(|m| {
            use air::transfer::{TransferInput, TransferOutput};
            let _ = air::transfer::build_transfer_trace(
                e(13),
                e(50),
                &TransferInput { amount: e(500), randomness: e(77) },
                &TransferInput { amount: e(400), randomness: e(88) },
                &TransferOutput { amount: e(100), recipient: e(1234), randomness: e(555) },
                &TransferOutput { amount: e(800), recipient: e(2222), randomness: e(333) },
                m,
            );
        })),
        ("C6 merkle_update", air::merkle_update::mask_len_for_depth(pe6.len()), Box::new(|m| {
            let _ = air::merkle_update::build_merkle_update_trace(e(111), e(222), &pe6, &pi6, m);
        })),
        ("C7 spend", air::spend::MASK_LEN, Box::new(|m| {
            let _ = air::spend::build_spend_trace(e(42), e(999), e(7), e(555), &pe7, &pi7, m);
        })),
    ];
    assert_eq!(probes.len(), 8, "all eight shipped circuits must be probed");

    let mut holes: Vec<String> = Vec::new();
    for (circuit, want, f) in &probes {
        assert!(*want > 1, "{circuit}: MASK_LEN {want} leaves no room for a shorter mask");
        // One too many is the case that matters: without the check nothing else
        // stops it. One too few and empty are the easy ones, kept as controls
        // that the message parser really reads this assert and not any panic.
        for got in [want + 1, want - 1, 0] {
            if let Err(why) = must_refuse(circuit, *want, got, f.as_ref()) {
                holes.push(why);
            }
        }
    }
    assert!(
        holes.is_empty(),
        "THE MASK LENGTH CHECK IS NOT ENFORCED AT RUN TIME ({} build) in {} case(s):\n  {}\n\
         A mask of the wrong length shifts or truncates the blinding region, and the verifier \
         cannot see it. `debug_assert_eq!` is NOT a check: it is absent from `--release`.",
        if cfg!(debug_assertions) { "debug" } else { "release" },
        holes.len(),
        holes.join("\n  "),
    );
}

/// The probe above proves nothing if `must_refuse` accepts any panic, or if a
/// right-length mask panics too. Both controls, on the smallest circuit.
#[test]
fn the_run_time_probe_tells_the_length_assert_from_any_other_outcome() {
    let want = air::subscriber_ownership::MASK_LEN;
    let build = |m: &BlindingMask| {
        let _ = air::subscriber_ownership::build_masked_trace(BaseElement::new(42), m);
    };
    // A right-length mask is accepted, so "no panic" is reported as a hole.
    let accepted = must_refuse("control", want, want, &build).unwrap_err();
    assert!(accepted.contains("ACCEPTED"), "{accepted}");
    // A panic that is not the length assert is reported as such.
    let other = must_refuse("control", want, want + 1, &|_m: &BlindingMask| panic!("index out of bounds")).unwrap_err();
    assert!(other.contains("not on the length assert"), "{other}");
    // An `assert_eq!` about OTHER numbers is not mistaken for this one.
    let wrong = must_refuse("control", want, want + 1, &|_m: &BlindingMask| assert_eq!(1usize, 2usize, "unrelated")).unwrap_err();
    assert!(wrong.contains("not on the length assert"), "{wrong}");
    assert_eq!(left_right("assertion `left == right` failed: x\n  left: 12\n right: 345"), Some((12, 345)));
}

// ---------------------------------------------------------------------------
// [gate v2 r1, R2] `draw` is the only ungated way to a mask — by shape, not by
// name.
// ---------------------------------------------------------------------------

/// Every `.rs` under `dir`, recursively.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let p = entry.expect("dir entry").path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// The source with every `//` comment blanked, line structure kept. Comments in
/// this crate quote code freely (`Self(v)`, `impl ... for BlindingMask`), and a
/// pin that reads them would fail on prose. No string literal in the scanned
/// spans holds a `//`.
fn code_only(src: &str) -> Vec<String> {
    src.lines()
        .map(|l| match l.find("//") {
            Some(at) => l[..at].to_string(),
            None => l.to_string(),
        })
        .collect()
}

/// One `fn` item as written: where, how deep, under which attributes, and its
/// signature up to the body, on one line with single spaces.
struct FnItem {
    line: usize,
    indent: usize,
    attrs: Vec<String>,
    sig: String,
}

fn fn_name(line: &str) -> Option<&str> {
    let mut t = line.trim_start();
    loop {
        let before = t;
        if t.starts_with("pub(") {
            t = t[t.find(')')? + 1..].trim_start();
        }
        for q in ["pub ", "const ", "unsafe ", "async ", "extern \"C\" "] {
            if let Some(rest) = t.strip_prefix(q) {
                t = rest.trim_start();
            }
        }
        if t == before {
            break;
        }
    }
    let rest = t.strip_prefix("fn ")?;
    let end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
    Some(&rest[..end])
}

fn fn_items(code: &[String]) -> Vec<FnItem> {
    let mut out = Vec::new();
    for (i, line) in code.iter().enumerate() {
        if fn_name(line).is_none() {
            continue;
        }
        // Signature: this line onward, up to the `{` that opens the body (or
        // the `;` of a bodiless declaration).
        let mut sig = String::new();
        for l in &code[i..] {
            sig.push(' ');
            sig.push_str(l.trim());
            if l.contains('{') || l.trim_end().ends_with(';') {
                break;
            }
        }
        let sig = sig.split('{').next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
        // Attributes: the `#[...]` lines directly above, across doc comments
        // (already blanked) and nothing else.
        let mut attrs = Vec::new();
        for l in code[..i].iter().rev() {
            let t = l.trim();
            if t.starts_with("#[") {
                attrs.push(t.to_string());
            } else if !t.is_empty() {
                break;
            }
        }
        attrs.reverse();
        out.push(FnItem { line: i + 1, indent: line.len() - line.trim_start().len(), attrs, sig });
    }
    out
}

/// Does the signature hand back a mask? `Self` only counts inside the mask's
/// own `impl`.
fn returns_a_mask(sig: &str, inside_the_impl: bool) -> bool {
    let Some((_, ret)) = sig.split_once("->") else { return false };
    ret.contains("BlindingMask") || (inside_the_impl && ret.contains("Self"))
}

const TEST_ONLY_GATES: [&str; 3] = [
    "#[cfg(test)]",
    "#[cfg(any(test, feature = \"test-probes\"))]",
    "#[cfg(any(test, feature = \"deterministic-mask-for-tests\"))]",
];

/// What the pin finds wrong with `lib_rs` plus the rest of `src/`, as text. The
/// committed tree must give an empty list; `draw_is_the_only_ungated_way_to_a_mask`
/// asserts that, and the sabotage controls below assert the list is NOT empty
/// for each known way of reopening A8.
fn a8_provenance_holes(files: &[(String, String)]) -> Vec<String> {
    let mut holes = Vec::new();
    let mut impl_blocks = 0usize;
    let mut struct_decls = 0usize;

    for (rel, src) in files {
        let code = code_only(src);

        // compact/zk_hiding.rs is one big `#[cfg(test)] mod` (checked below).
        let whole_file_is_test_only = rel == "compact/zk_hiding.rs";

        // -- the mask's own impl block: line span [impl_from, impl_to) --------
        let mut impl_span: Option<(usize, usize)> = None;
        for (i, l) in code.iter().enumerate() {
            let t = l.trim();
            if t.starts_with("impl") && t.contains("BlindingMask") {
                if t.contains(" for ") {
                    holes.push(format!(
                        "{rel}:{}: a trait is implemented for the mask (`{t}`); `From`, `Default`, \
                         `Clone`, `FromIterator`, `Deserialize`, `Debug` each either BUILD, COPY or \
                         PRINT a mask",
                        i + 1
                    ));
                    continue;
                }
                impl_blocks += 1;
                if rel != "lib.rs" {
                    holes.push(format!("{rel}:{}: an `impl BlindingMask` outside lib.rs", i + 1));
                }
                let mut depth = 0i32;
                let mut end = code.len();
                'scan: for (j, m) in code.iter().enumerate().skip(i) {
                    for ch in m.chars() {
                        match ch {
                            '{' => depth += 1,
                            '}' => {
                                depth -= 1;
                                if depth == 0 {
                                    end = j + 1;
                                    break 'scan;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                impl_span = Some((i, end));
            }
        }

        // -- the struct: one declaration, private field, NO attribute ---------
        for (i, l) in code.iter().enumerate() {
            if !l.contains("struct BlindingMask") {
                continue;
            }
            struct_decls += 1;
            if l.trim() != "pub struct BlindingMask(Vec<BaseElement>);" {
                holes.push(format!("{rel}:{}: the struct is not a single PRIVATE field: `{}`", i + 1, l.trim()));
            }
            for above in code[..i].iter().rev() {
                let t = above.trim();
                if t.starts_with("#[") {
                    holes.push(format!(
                        "{rel}:{}: `{t}` on the struct. A derive is how `Debug` (prints the mask), \
                         `Clone` (copies it), `Default` and serde (build one) arrive",
                        i + 1
                    ));
                } else if !t.is_empty() {
                    break;
                }
            }
        }

        // -- no constructor EXPRESSION anywhere but the struct line itself ----
        // The private field is visible crate-wide (the struct sits at the
        // root), so `crate::BlindingMask(v)` compiles anywhere in `src/`.
        for (i, l) in code.iter().enumerate() {
            let in_impl = impl_span.is_some_and(|(a, b)| i >= a && i < b);
            let literal = l.contains("BlindingMask(") && !l.contains("struct BlindingMask(");
            let braced = l.contains("BlindingMask { 0:") || l.contains("BlindingMask {0:");
            if (literal || braced) && !in_impl {
                holes.push(format!("{rel}:{}: a mask is built outside `impl BlindingMask`: `{}`", i + 1, l.trim()));
            }
        }

        // -- every fn --------------------------------------------------------
        let test_mod_open_at = |line_idx: usize| -> bool {
            // Inside a column-0 `#[cfg(test)] mod x {` that has not closed yet.
            let mut open = false;
            for (j, t) in code.iter().enumerate().take(line_idx) {
                if t.starts_with("mod ") && t.trim_end().ends_with('{') {
                    open = j > 0 && code[j - 1].trim() == "#[cfg(test)]";
                } else if t.starts_with('}') {
                    open = false;
                }
            }
            open
        };
        for f in fn_items(&code) {
            let in_impl = impl_span.is_some_and(|(a, b)| f.line > a && f.line <= b);
            let gated = f.attrs.iter().any(|a| TEST_ONLY_GATES.contains(&a.as_str()));
            if in_impl {
                let where_ = format!("{rel}:{} `{}`", f.line, f.sig);
                if f.sig.contains("&mut self") {
                    holes.push(format!("{where_}: a `&mut self` method can overwrite a drawn mask with chosen values"));
                }
                if gated {
                    let known = [
                        "pub fn from_raw_for_tests(v: Vec<BaseElement>) -> Self",
                        "pub fn from_raw_u64_for_tests(v: &[u64]) -> Self",
                    ];
                    if !known.contains(&f.sig.as_str()) || f.attrs != [TEST_ONLY_GATES[2]] {
                        holes.push(format!("{where_}: a test-only method this pin does not know; pin it here"));
                    }
                    continue;
                }
                // Ungated: exactly these four, and `draw` only under `csprng`.
                let allowed: [(&str, &[&str]); 4] = [
                    ("pub fn draw(len: usize) -> Result<Self, getrandom::Error>", &["#[cfg(feature = \"csprng\")]"]),
                    ("pub fn as_slice(&self) -> &[BaseElement]", &[]),
                    ("pub fn len(&self) -> usize", &[]),
                    ("pub fn is_empty(&self) -> bool", &[]),
                ];
                let ok = allowed.iter().any(|(sig, attrs)| {
                    f.sig == *sig && f.attrs.iter().map(String::as_str).collect::<Vec<_>>() == *attrs
                });
                if !ok {
                    holes.push(if returns_a_mask(&f.sig, true) {
                        format!(
                            "{where_} {:?}: an UNGATED constructor. `draw` must stay the only way to \
                             a mask in a shipping build; gate this on `deterministic-mask-for-tests` \
                             or delete it. This is LEAK-LEDGER A8, reopened",
                            f.attrs
                        )
                    } else {
                        format!(
                            "{where_} {:?}: an ungated method this pin does not know. The shipping \
                             surface of the mask is exactly draw / as_slice / len / is_empty",
                            f.attrs
                        )
                    });
                }
                continue;
            }
            // Outside the impl: anything that returns a mask must be test-only.
            if returns_a_mask(&f.sig, false) && !gated && !whole_file_is_test_only {
                let inside_test_mod = f.indent > 0 && test_mod_open_at(f.line - 1);
                if !inside_test_mod {
                    holes.push(format!(
                        "{rel}:{} `{}` {:?}: returns a mask and is compiled into a default build. \
                         Every `c*_deterministic_probe_mask` and test helper must sit behind \
                         `cfg(test)` / `test-probes` / `deterministic-mask-for-tests`",
                        f.line, f.sig, f.attrs
                    ));
                }
            }
        }
    }

    if impl_blocks != 1 {
        holes.push(format!("expected exactly one `impl BlindingMask`, found {impl_blocks}"));
    }
    if struct_decls != 1 {
        holes.push(format!("expected exactly one `struct BlindingMask`, found {struct_decls}"));
    }
    holes
}

/// `(path relative to src/, contents)` for the whole crate.
fn crate_sources() -> Vec<(String, String)> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = Vec::new();
    rust_files(&src, &mut paths);
    paths.sort();
    paths
        .into_iter()
        .map(|p| {
            let rel = p.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
            (rel, read(p))
        })
        .collect()
}

/// `draw` is the only ungated way to a mask, by SHAPE: the ungated methods of
/// `impl BlindingMask` are exactly `draw`, `as_slice`, `len`, `is_empty`; no
/// trait is implemented for or derived on the type; no code outside the impl
/// builds one; and every other function in the crate that returns a mask is
/// compiled only for tests.
///
/// The round-1 gate's sabotage S1 (`pub fn of_chosen(v: Vec<BaseElement>) ->
/// Self`, no cfg) left the name-based pin above green. It fails here, and so do
/// its relatives in `every_known_way_to_reopen_a8_is_reported`.
#[test]
fn draw_is_the_only_ungated_way_to_a_mask() {
    let files = crate_sources();
    assert!(files.iter().any(|(rel, _)| rel == "lib.rs"));
    assert!(files.len() > 15, "only {} source files read; the scan is not looking at the crate", files.len());

    // The one whole-file exemption has to be what it claims.
    let compact = &files.iter().find(|(rel, _)| rel == "compact.rs").expect("compact.rs").1;
    assert!(
        compact.contains("#[cfg(test)]\nmod zk_hiding;"),
        "compact/zk_hiding.rs is exempt from the scan as a `#[cfg(test)] mod`; it no longer is one"
    );

    let holes = a8_provenance_holes(&files);
    assert!(
        holes.is_empty(),
        "LEAK-LEDGER A8 IS OPEN AGAIN: {} way(s) to a blinding mask that did not come from the \
         CSPRNG, or to print / copy / overwrite one, in a shipping build:\n  {}",
        holes.len(),
        holes.join("\n  "),
    );

    // Non-vacuity: the scan really saw the seven `c*_deterministic_probe_mask`
    // helpers and the two raw constructors it is there to police.
    let mut gated_mask_fns = 0usize;
    for (rel, src) in &files {
        if rel == "compact/zk_hiding.rs" {
            continue;
        }
        let code = code_only(src);
        gated_mask_fns += fn_items(&code)
            .iter()
            .filter(|f| returns_a_mask(&f.sig, rel == "lib.rs") && f.attrs.iter().any(|a| TEST_ONLY_GATES.contains(&a.as_str())))
            .count();
    }
    assert!(
        gated_mask_fns >= 9,
        "the scan found {gated_mask_fns} gated mask-returning functions; at least 2 raw \
         constructors + 7 probe masks exist, so it is not reading what it should"
    );
}

/// The pin above, run against lib.rs with each known way of reopening A8
/// written into it. Every one must be reported. These are the sabotages the
/// verifiers and the gate ran by hand (S1, S2) plus their near relatives, kept
/// here so the pin cannot quietly lose one.
#[test]
fn every_known_way_to_reopen_a8_is_reported() {
    let files = crate_sources();
    let lib = &files.iter().find(|(rel, _)| rel == "lib.rs").unwrap().1;
    let anchor = "    /// The mask elements, for the `build_*_trace` bodies inside this crate.\n";
    assert_eq!(lib.matches(anchor).count(), 1, "the sabotage anchor moved; update it");
    let struct_line = "pub struct BlindingMask(Vec<BaseElement>);\n";
    assert_eq!(lib.matches(struct_line).count(), 1);

    let in_impl = |body: &str| lib.replace(anchor, &format!("{body}\n{anchor}"));
    let after_struct = |item: &str| lib.replace(struct_line, &format!("{struct_line}\n{item}\n"));
    let cases: Vec<(&str, String, &str)> = vec![
        ("S1 of_chosen", in_impl("    pub fn of_chosen(v: Vec<BaseElement>) -> Self {\n        Self(v)\n    }\n"), "UNGATED constructor"),
        ("S1b named return type", in_impl("    pub fn zeroed(n: usize) -> BlindingMask {\n        BlindingMask(vec![BaseElement::ZERO; n])\n    }\n"), "UNGATED constructor"),
        ("S1c pub(crate) const", in_impl("    pub(crate) const fn empty() -> Self {\n        Self(Vec::new())\n    }\n"), "UNGATED constructor"),
        ("S1d wrapped in Option", in_impl("    pub fn try_of(v: Vec<BaseElement>) -> Option<Self> {\n        Some(Self(v))\n    }\n"), "UNGATED constructor"),
        ("S1e overwrite in place", in_impl("    pub fn set(&mut self, v: Vec<BaseElement>) {\n        self.0 = v;\n    }\n"), "&mut self"),
        ("S1f mutable view", in_impl("    pub fn as_mut_slice(&mut self) -> &mut [BaseElement] {\n        &mut self.0\n    }\n"), "&mut self"),
        ("S1g gate dropped from from_raw_for_tests", lib.replacen("    #[cfg(any(test, feature = \"deterministic-mask-for-tests\"))]\n    pub fn from_raw_for_tests", "    pub fn from_raw_for_tests", 1), "UNGATED constructor"),
        ("S1h gate weakened to csprng", lib.replacen("    #[cfg(any(test, feature = \"deterministic-mask-for-tests\"))]\n    pub fn from_raw_for_tests", "    #[cfg(feature = \"csprng\")]\n    pub fn from_raw_for_tests", 1), "UNGATED constructor"),
        ("S2 derive(Debug, Clone)", lib.replace(struct_line, &format!("#[derive(Debug, Clone)]\n{struct_line}")), "on the struct"),
        ("S2b manual Debug via fmt::", after_struct("impl std::fmt::Debug for BlindingMask {\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n        write!(f, \"{:?}\", self.0)\n    }\n}"), "a trait is implemented"),
        ("S3 From<Vec<_>>", after_struct("impl From<Vec<BaseElement>> for BlindingMask {\n    fn from(v: Vec<BaseElement>) -> Self {\n        Self(v)\n    }\n}"), "a trait is implemented"),
        ("S3b free fn at the crate root", after_struct("pub fn mask_of(v: Vec<BaseElement>) -> BlindingMask {\n    BlindingMask(v)\n}"), "returns a mask and is compiled into a default build"),
        ("S3c pub field", lib.replace(struct_line, "pub struct BlindingMask(pub Vec<BaseElement>);\n"), "not a single PRIVATE field"),
        ("S3d second impl block", after_struct("impl BlindingMask {\n    pub fn of(v: Vec<BaseElement>) -> Self {\n        Self(v)\n    }\n}"), "exactly one `impl BlindingMask`"),
    ];

    let mut survivors = Vec::new();
    for (name, sabotaged, expect) in &cases {
        assert_ne!(sabotaged, lib, "{name}: the sabotage did not apply");
        let mut tree: Vec<(String, String)> = files.iter().filter(|(rel, _)| rel != "lib.rs").cloned().collect();
        tree.push(("lib.rs".to_string(), sabotaged.clone()));
        let holes = a8_provenance_holes(&tree);
        if !holes.iter().any(|h| h.contains(expect)) {
            survivors.push(format!("{name}: expected a hole mentioning {expect:?}, got {holes:?}"));
        }
    }
    // And one outside lib.rs: a probe mask in compact.rs that lost its gate.
    let (_, compact) = files.iter().find(|(rel, _)| rel == "compact.rs").unwrap();
    let gated = "#[cfg(any(test, feature = \"test-probes\"))]\npub fn c0_deterministic_probe_mask() -> crate::BlindingMask {";
    assert_eq!(compact.matches(gated).count(), 1, "the compact.rs sabotage anchor moved");
    let mut tree: Vec<(String, String)> = files.iter().filter(|(rel, _)| rel != "compact.rs").cloned().collect();
    tree.push(("compact.rs".to_string(), compact.replace(gated, "pub fn c0_deterministic_probe_mask() -> crate::BlindingMask {")));
    let holes = a8_provenance_holes(&tree);
    if !holes.iter().any(|h| h.contains("c0_deterministic_probe_mask") && h.contains("default build")) {
        survivors.push(format!("S5 ungated c0 probe mask: not reported, got {holes:?}"));
    }

    assert!(survivors.is_empty(), "the A8 pin has a hole:\n  {}", survivors.join("\n  "));
}

// ---------------------------------------------------------------------------
// [gate v2 r1, R2] No trait prints, copies or builds a mask — checked by the
// COMPILER, so a derive, a manual impl and a blanket impl all count.
// ---------------------------------------------------------------------------

/// `true` iff `$t: $bound`. Inherent associated consts win over trait ones, and
/// the inherent impl only exists when the bound holds.
macro_rules! implements {
    ($t:ty: $($bound:tt)+) => {{
        struct Probe<T: ?Sized>(core::marker::PhantomData<T>);
        // unused exactly when the answer is yes, and the inherent const when it is no
        #[allow(dead_code)]
        trait Fallback {
            const YES: bool = false;
        }
        impl<T: ?Sized> Fallback for Probe<T> {}
        #[allow(dead_code)]
        impl<T: ?Sized + $($bound)+> Probe<T> {
            const YES: bool = true;
        }
        <Probe<$t>>::YES
    }};
}

/// `lib.rs` says the mask is "deliberately NOT `Debug`" and the WP0b report says
/// "no `Clone`"; until the round-1 gate nothing tested either
/// (`#[derive(Debug, Clone)]` left this whole suite green). A `{:?}` of a mask
/// in a log or a panic message publishes the value the hiding argument assumes
/// nobody sees; `Clone` and `Default` / `From` are a copy and two constructors.
#[test]
fn the_mask_has_no_trait_that_prints_copies_or_builds_it() {
    // Controls: the probe says yes when the answer is yes.
    assert!(implements!(Vec<BaseElement>: Clone));
    assert!(implements!(Vec<BaseElement>: core::fmt::Debug));
    assert!(implements!(BlindingMask: Sized));

    assert!(!implements!(BlindingMask: core::fmt::Debug), "BlindingMask is Debug: a `{{:?}}` publishes the mask");
    assert!(!implements!(BlindingMask: core::fmt::Display), "BlindingMask is Display");
    assert!(!implements!(BlindingMask: Clone), "BlindingMask is Clone: one draw can now sit behind two owners");
    assert!(!implements!(BlindingMask: Default), "BlindingMask is Default: an EMPTY mask without the CSPRNG");
    assert!(!implements!(BlindingMask: From<Vec<BaseElement>>), "BlindingMask: From<Vec<BaseElement>> reopens A8");
    assert!(!implements!(BlindingMask: From<Vec<u64>>), "BlindingMask: From<Vec<u64>> reopens A8");
    assert!(!implements!(BlindingMask: core::iter::FromIterator<BaseElement>), "`.collect()` into a mask reopens A8");
    assert!(!implements!(BlindingMask: AsMut<[BaseElement]>), "a mutable view overwrites a drawn mask");
    assert!(!implements!(BlindingMask: core::ops::DerefMut), "a mutable view overwrites a drawn mask");
    assert!(
        !implements!(BlindingMask: core::ops::IndexMut<usize>),
        "IndexMut overwrites a drawn mask one element at a time"
    );
}
