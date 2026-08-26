//! **Which soundness pins reach circuit 7, and which do not say that they don't.**
//!
//! # Why this file exists
//!
//! C7 was added on 2026-08-24, deployed on 2026-08-25, and it is the circuit the
//! product is FOR — the single-proof spend that removes the commitment linkage.
//! The eighteen verifier pins in `.github/workflows/ci.yml` are what stand
//! between a change and a soundness regression, and a pin that sweeps `0u8..=6`
//! runs green while saying nothing at all about the newest circuit.
//!
//! MEASURED 2026-08-26: five pins enumerate circuits and stop before C7, and not
//! one of them mentions C7 anywhere — not in a comment, not in an exclusion, not
//! in a TODO. Their green is therefore honest about seven circuits and silent
//! about the eighth, and nothing in the tree distinguished "C7 was considered and
//! excluded" from "C7 was never thought about".
//!
//! `cross_circuit_confusion.rs` is the reason this is worth a file. Commit
//! `0b7d12c0` was titled "the parse matrix swept 7x7 — C7 was the row and column
//! it skipped" and widened every sweep in that file except one, which kept
//! `0..7` and compared C7's length against nothing. Same file, same commit, same
//! bug class, silent because the assertion happened to hold. That is what an
//! unenumerated circuit looks like from the outside: green.
//!
//! # What this proves, and what it does not
//!
//! This is a SOURCE SCAN. It cannot prove a pin's logic covers C7 — only that
//! the file either reaches for C7 by name or records, in writing, why it does
//! not. It is the same contract `CI_UNRUN_TEST_TARGETS` in `cu_budget.rs` holds
//! over CI targets: the list is a place to record a coverage hole, not a place
//! to make one quiet, and an entry's whole lifetime is "written with the reason,
//! deleted when the reason is".
//!
//! ⛔ AN ENTRY BELOW IS NOT AN EXCUSE. Four of the five are real coverage holes
//! in CI-enforced soundness pins, and closing them needs MEASURED values that
//! must not be guessed — see each reason.
//!
//! Run:
//!   cargo test -p p01_stark_verifier --test c7_pin_coverage

use std::fs;
use std::path::PathBuf;

fn tests_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn source_of(stem: &str) -> String {
    let p = tests_dir().join(format!("{stem}.rs"));
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read {}: {e}", p.display()))
}

/// Does this file sweep ALL circuits, rather than exercising one or two?
///
/// The distinction matters and was measured. `b4_pair_leaf` and `fri_end_to_end`
/// both name `CONFIG_POOL_COMMITMENT`, but as a REPRESENTATIVE: the pair-leaf
/// commitment and the end-to-end parse are circuit-independent mechanisms, and
/// demanding C7 of them would be the kind of blanket rule people silence. So
/// naming a config is not enough. What counts is a bounded sweep (`u8..=N`) or a
/// per-circuit table (`[T; 6|7|8]`) — the shapes that mean "and here are all of
/// them", which are exactly the shapes that can stop one short.
fn enumerates_circuits(src: &str) -> bool {
    src.contains("u8..=")
        || src.contains("; 6]")
        || src.contains("; 7]")
        || src.contains("; 8]")
        || distinct_circuit_labels(src) >= 3
}

/// How many distinct `"C0"`..`"C7"` labels the file uses as VALUES.
///
/// 🚨 THE SHAPE THIS FILE MISSED ON ITS FIRST DAY. `honest_liveness.rs`
/// enumerates every circuit and stops at C6, and it does so with a hand-written
/// sequence of `run_generic("C1", ...)` calls — no range, no table. The two
/// predicates above saw nothing to check and waved it through, and it is the
/// single worst place to have missed: that suite's whole job is to prove the
/// verifier accepts EVERY honest proof, and it never generates a C7 witness.
///
/// Three is the threshold because two named circuits is a representative pair
/// (`b4_pair_leaf`, `fri_end_to_end`), while three or more is somebody walking
/// the list.
fn distinct_circuit_labels(src: &str) -> usize {
    let mut seen = [false; 8];
    for (i, flag) in seen.iter_mut().enumerate() {
        *flag = src.contains(&format!("\"C{i}\""));
    }
    seen.iter().filter(|f| **f).count()
}

/// Does it reach C7?
///
/// ⛔ STRUCTURAL SIGNALS ONLY — NEVER PROSE, and the first draft of this file got
/// that wrong. It counted the string "C7" anywhere in the source, which means
/// writing "C7 is excluded because..." into a pin would have made this file
/// declare the hole closed. A guard that a comment can satisfy is a guard a
/// comment will eventually satisfy by accident.
///
/// So only shapes that EXERCISE C7 count: a sweep bound of `..=7`, an
/// eight-wide table, an `0..8` loop, or the circuit named as a value. A table
/// width alone proves nothing in the other direction — `[Fixture; 7]` is C0..C6
/// in `b1_deep_binding` while `[Circuit; 7]` is C1..C7 in `wire_parity` — which
/// is why width decides `enumerates_circuits` and never this.
fn reaches_c7(src: &str) -> bool {
    src.contains("u8..=7")
        || src.contains("; 8]")
        || src.contains("0..8")
        || src.contains("CONFIG_SPEND")
        || src.contains("CIRCUIT_SPEND")
        // A QUOTED label is a value, not prose: `run_generic("C7", ...)` is the
        // way the hand-written shape declares a circuit. Unquoted `C7` in a
        // comment still does not count, and a test below pins that.
        || src.contains("\"C7\"")
}

/// Pins that enumerate circuits and stop before C7, each with the reason.
///
/// Deleting an entry is the goal. Adding one costs a written reason on purpose.
const PINS_THAT_DO_NOT_REACH_C7: [(&str, &str); 6] = [
    (
        "honest_liveness",
        "🚨 THE WORST ONE, AND THE REASON THIS FILE'S DETECTOR GREW A THIRD SHAPE. It runs C0          through C6 with hand-written `run_generic(\"C1\", ..)` calls and never generates a C7          witness — its own summary prints `WITNESSES * 7`. Its dispatcher WAS taught C7          (`7 => verify_deep_ali_circuit_7`, added 2026-08-24 so a C7 proof could not clear          phase 2 vacuously), which makes the omission look deliberate and is not the same thing:          the arm exists and nothing ever calls it. So the one suite whose entire job is 'does          the verifier accept EVERY honest proof' says nothing about the circuit the product is          for, and the only evidence C7 liveness holds is the single proof that landed on devnet.          Closing this needs a C7 witness family in tests/common/mod.rs, measured, not adapted",
    ),
    (
        "b2_bits_measured",
        "six sweeps at `0u8..=6` and five `[_; 7]` tables (B2_CONJECTURED, B2_UNCONDITIONAL, \
         PRE_B2_*, B1_PINNED_FORGERY_BITS, PRE_B2_TERMINAL_BOUND). Widening needs MEASURED \
         forgery-bit counts for C7 and a measured pre-B2 baseline it never had — C7 shipped \
         post-segmentation, so there is no 'before' to subtract. Those numbers must be produced \
         by running the attack, never derived from the other seven",
    ),
    (
        "b2_segment_binding",
        "seven sweeps at `1u8..=6`, and `config_for` has no `7 =>` arm: it ends \
         `other => panic!(\"no config for circuit {other}\")`, so widening the loop PANICS rather \
         than failing an assertion. Three more entry points (the phase-2 one, the generic \
         pipeline, the honest pipeline) panic the same way. Closing this is four match arms plus \
         a measured segment count, not a bound change",
    ),
    (
        "b1_deep_binding",
        "three sweeps at `0u8..=6`, plus FIXTURES: [Fixture; 7] and COVERAGE: [Coverage; 7]. \
         deployed-verifier.json:344 explains why C7 has no DIGEST fixture — 'its mask is fresh \
         per proof', which is true and is why wireFormat pins C7 by length instead. That covers \
         the fixture tables. It does NOT cover the three DEEP-binding sweeps, which do not need \
         a digest, and no file says why those stop at 6",
    ),
    (
        "route_c_trace_pair",
        "SHIPPING: [&CircuitConfig; 7] lists C0 through C6 and omits CONFIG_SPEND; \
         absolute: [usize; 7] holds only the seven pre-C7 sizes. Plausibly legitimate — the test \
         measures a delta against a PRE-Route-C baseline that C7 never had, since C7 was born \
         after Route C — but that reason is written nowhere in the file, and a plausible reason \
         nobody wrote down is indistinguishable from an oversight",
    ),
    (
        "ood_column_probe",
        "CASES: [Case; 6] covers C1 through C6. Its header excludes C0 explicitly and with a \
         reason ('a different measurement, not a skipped one'), which is exactly the standard \
         C7's absence fails to meet — the header still says it measures 'the seven circuits'. \
         🚨 This is the one that bears on the live claim: C7's 128 mask rows and its \
         underdetermination argument are precisely what a constant-column probe would test",
    ),
];

fn excluded(stem: &str) -> Option<&'static str> {
    PINS_THAT_DO_NOT_REACH_C7
        .iter()
        .find(|(name, _)| *name == stem)
        .map(|(_, why)| *why)
}

/// Every circuit-enumerating pin either reaches C7 or is listed with a reason.
#[test]
fn no_circuit_sweep_stops_at_c6_in_silence() {
    let mut silent: Vec<String> = Vec::new();

    for entry in fs::read_dir(tests_dir()).expect("cannot read tests dir") {
        let path = entry.expect("bad dir entry").path();
        if path.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
        let src = fs::read_to_string(&path).expect("cannot read pin");

        if !enumerates_circuits(&src) || reaches_c7(&src) || excluded(&stem).is_some() {
            continue;
        }
        silent.push(stem);
    }

    assert!(
        silent.is_empty(),
        "these pins sweep circuits, never reach C7, and say nothing about it: {silent:?}\n\n\
         A pin that stops at C6 runs green while measuring nothing about the circuit the\n\
         product is for. Either widen it — which usually means MEASURING values for C7, not\n\
         copying the others — or add it to PINS_THAT_DO_NOT_REACH_C7 with the reason.\n\
         Do not add it with an empty reason to go green."
    );
}

/// An entry must still be true. When a pin is widened, its entry goes.
#[test]
fn the_exclusion_list_does_not_outlive_its_reasons() {
    for (stem, why) in PINS_THAT_DO_NOT_REACH_C7 {
        let src = source_of(stem);
        assert!(
            !why.trim().is_empty(),
            "{stem} is excluded with an empty reason, which is the one thing this list forbids"
        );
        assert!(
            enumerates_circuits(&src),
            "{stem} no longer enumerates circuits at all, so this entry describes nothing — delete it"
        );
        assert!(
            !reaches_c7(&src),
            "{stem} NOW REACHES C7 — delete its entry from PINS_THAT_DO_NOT_REACH_C7.\n\
             That is the good failure: the hole was closed and the record of it should go with it."
        );
    }
}

/// ANTI-VACUITY. Every assertion above rests on two text predicates, and if
/// either were broken the whole file would pass while measuring nothing —
/// `reaches_c7` returning true everywhere makes the first test vacuous, and
/// `enumerates_circuits` returning false everywhere makes it vacuous the other
/// way. So drive both against known answers.
#[test]
fn the_detectors_are_not_broken() {
    // Pins that demonstrably DO reach C7 today.
    for stem in ["cross_circuit_confusion", "wire_parity"] {
        let src = source_of(stem);
        assert!(
            enumerates_circuits(&src),
            "{stem} should register as circuit-enumerating"
        );
        assert!(reaches_c7(&src), "{stem} should register as reaching C7");
    }

    // And the excluded ones must NOT, or the first test is passing for the
    // wrong reason. Checked here as well as above so a broken predicate shows
    // up as a detector failure rather than as an exclusion-list failure.
    assert!(
        !reaches_c7("for id in 0u8..=6 { let c = config_for(id); }"),
        "reaches_c7 is matching something it should not"
    );
    assert!(
        reaches_c7("for id in 0u8..=7 {}"),
        "reaches_c7 misses a widened sweep"
    );
    // The property the first draft of this file did not have: writing about C7
    // must not count as testing C7. Without this, documenting an exclusion in
    // the excluded file closes the hole on paper and nowhere else.
    assert!(
        !reaches_c7("//! C7 is absent here, on purpose, and here is the reason."),
        "prose about C7 is being counted as coverage of C7"
    );
    assert!(
        !enumerates_circuits("fn main() { let x = 1; }"),
        "enumerates_circuits is matching a file with no circuit sweep"
    );
    // The representative-sample shape must NOT register, or b4_pair_leaf and
    // fri_end_to_end come back and the rule starts demanding C7 of mechanisms
    // that have no circuit dimension.
    assert!(
        !enumerates_circuits("let c = &CONFIG_POOL_COMMITMENT; let d = &CONFIG_SUBSCRIBER_OWNERSHIP;"),
        "naming two configs is a representative sample, not an enumeration"
    );
    // The shape this file missed on its first day: no range, no table, just a
    // hand-written walk down the list. Two labels is a pair; three is a walk.
    assert!(
        enumerates_circuits(r#"run("C1", a); run("C2", b); run("C3", c);"#),
        "a hand-written per-circuit sequence must register as an enumeration"
    );
    assert!(
        !enumerates_circuits(r#"run("C1", a); run("C2", b);"#),
        "two labels is a representative pair, not a walk down the list"
    );
    assert_eq!(
        distinct_circuit_labels(r#""C0" "C1" "C1" "C6""#),
        3,
        "distinct_circuit_labels must count DISTINCT labels, not occurrences"
    );

    assert_eq!(
        PINS_THAT_DO_NOT_REACH_C7.len(),
        6,
        "the exclusion count changed — if a hole was closed, good, update this number \
         deliberately rather than letting the list drift"
    );
}
