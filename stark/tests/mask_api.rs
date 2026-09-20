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
//! Run: `cargo test -p p01-stark --release --test mask_api`

use std::path::Path;

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
        assert!(
            src.contains("mask.len(),\n        MASK_LEN")
                || src.contains("mask.len(),\n        mask_len_for_depth(depth)"),
            "{file} lost the assert that pins the mask LENGTH; the newtype pins \
             provenance, not size, and both are load-bearing"
        );
        checked += 1;
    }
    assert_eq!(checked, 8, "all eight shipped circuits must be covered");
}
