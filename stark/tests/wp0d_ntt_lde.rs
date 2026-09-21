//! [WP0d 2026-09-19] The NTT low-degree extension changes no proof byte.
//!
//! # What changed, and what must not
//!
//! Before WP0d the compact prover built every low-degree extension by
//! evaluating the interpolant at each coset point one at a time: `lde_size`
//! evaluations of a degree-`< n` polynomial per column, so `n * lde_size`
//! multiplications per column, quadratic in the trace length. Three places did
//! it: the trace columns (`compute_lde_generic`, and `compute_lde` on the
//! legacy C0 path), the periodic columns inside every
//! `compute_quotient_lde_circuit_*`, and the quotient segments
//! (`segment_quotient_poly`). WP0d evaluates the same polynomials on the same
//! coset `h * <lde_g>` with one radix-2 NTT per column (`stark/src/ntt.rs`).
//!
//! Field arithmetic is exact, so the two methods must agree on every value.
//! This file holds the prover to that on REAL proofs: fixed witnesses, fixed
//! masks, all eight shipped circuits plus the legacy C0 generator, and the
//! SHA-256 of every proof pinned to what the pre-WP0d prover emitted. One
//! differing byte anywhere in a proof changes its digest.
//!
//! The pins were captured from the pre-WP0d prover (per-point evaluation) on
//! 2026-09-19, before any production edit, and the same test was green against
//! that prover before the NTT landed. They are v1 wire bytes: v1 is frozen, so
//! nothing should ever move them. A change that does is a wire change, and it
//! needs its own review, not a re-pin.
//!
//! # What this does NOT show
//!
//! Byte identity on nine fixed inputs is a strong regression check, not a
//! proof that the NTT is correct for every input. That half lives in
//! `stark/src/ntt.rs` (differential tests against a naive evaluator at every
//! power-of-two size up to 2^12, including coefficient vectors longer than the
//! domain) and in `compact.rs`'s `wp0d_ntt_lde` module (the rewritten builders
//! against the pre-WP0d bodies, kept verbatim as test oracles).
//!
//! Run: `cargo test -p p01-stark --release --test wp0d_ntt_lde -- --nocapture`
//! Timing (ignored, a measurement): add `-- --ignored prove_timing`.

use p01_stark::air;
use p01_stark::compact as c;
use sha2::{Digest, Sha256};
use std::time::Instant;

/// Goldilocks modulus. Masks are reduced below it so every mask element is a
/// canonical field element on either side of the change.
const P: u64 = 0xFFFF_FFFF_0000_0001;

/// Deterministic xorshift64 mask, one distinct seed per circuit. Test
/// scaffolding: a publicly reproducible mask HIDES NOTHING, which is exactly
/// what a byte-identity fixture needs and exactly what a shipped proof must
/// never use.
fn mask_raw(seed: u64, len: usize) -> Vec<u64> {
    let mut z = seed;
    (0..len)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % P
        })
        .collect()
}

/// [A8] The same bytes, carried by the type the prover now demands.
fn mask(seed: u64, len: usize) -> p01_stark::BlindingMask {
    p01_stark::BlindingMask::from_raw_u64_for_tests(&mask_raw(seed, len))
}

fn path(depth: usize, base: u64, step: u64) -> (Vec<u64>, Vec<u8>) {
    let pe: Vec<u64> = (0..depth as u64).map(|i| base + i * step).collect();
    let pi: Vec<u8> = (0..depth).map(|i| (i % 2) as u8).collect();
    (pe, pi)
}

/// The nine fixtures. Witnesses are the ones `bench_all_circuits.rs` uses, so a
/// timing here is comparable with that bench; the masks are fixed instead of
/// drawn, so two runs are the same proof and the grinding work is the same.
const NAMES: [&str; 9] = [
    "C0-legacy", "C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7",
];

/// The pinned fixture of `name`.
fn prove(name: &str) -> Vec<u8> {
    prove_salted(name, 0)
}

/// `name` with its mask seed moved by `salt`. `salt = 0` IS the pinned fixture;
/// any other salt is another valid proof of the same witness, used only by the
/// grinding split below. The legacy C0 generator takes no mask.
fn prove_salted(name: &str, salt: u64) -> Vec<u8> {
    match name {
        "C0-legacy" => c::generate_compact_proof(42).proof_bytes,
        "C0" => {
            c::generate_subscriber_ownership_proof(42, &mask((salt << 16) ^ 0xC0, air::subscriber_ownership::MASK_LEN))
                .proof_bytes
        }
        "C1" => {
            c::generate_pool_commitment_proof(111, 222, 333, 444, &mask((salt << 16) ^ 0xC1, air::denominated_pool::MASK_LEN))
                .proof_bytes
        }
        "C2" => {
            c::generate_balance_compact_proof(42, 1000, 777, 999, &mask((salt << 16) ^ 0xC2, air::balance_proof::MASK_LEN))
                .proof_bytes
        }
        "C3" => {
            let d = air::merkle_path::CANONICAL_DEPTH;
            let (pe, pi) = path(d, 1000, 37);
            c::generate_merkle_path_compact_proof(777, &pe, &pi, &mask((salt << 16) ^ 0xC3, air::merkle_path::mask_len_for_depth(d)))
                .proof_bytes
        }
        "C4" => c::generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999,
            &mask((salt << 16) ^ 0xC4, air::confidential_balance::MASK_LEN),
        )
        .proof_bytes,
        "C5" => c::generate_transfer_compact_proof(
            13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50,
            &mask((salt << 16) ^ 0xC5, air::transfer::MASK_LEN),
        )
        .proof_bytes,
        "C6" => {
            let d = air::merkle_update::CANONICAL_DEPTH;
            let (pe, pi) = path(d, 100, 13);
            c::generate_merkle_update_compact_proof(111, 222, &pe, &pi, &mask((salt << 16) ^ 0xC6, air::merkle_update::mask_len_for_depth(d)))
                .proof_bytes
        }
        "C7" => {
            let d = air::spend::CANONICAL_DEPTH;
            let (pe, pi) = path(d, 1000, 37);
            c::generate_spend_compact_proof(42, 999, 7, 555, &pe, &pi, &[11, 22, 33, 44], &mask((salt << 16) ^ 0xC7, air::spend::MASK_LEN))
                .proof_bytes
        }
        other => panic!("unknown fixture {other}"),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `(fixture, proof length, SHA-256 of the proof bytes)` emitted by the
/// PRE-WP0d prover. See the module header for where they come from.
const PINNED: [(&str, usize, &str); 9] = [
    ("C0-legacy", 47641, "157f45be56f966afeaa0bbb43255e17e16e0de07a2817429c7d554923b30930e"),
    ("C0", 74365, "7068736c7fbcc4418985f1d82545647566b46a77e06fe4d349472767d6c577f6"),
    ("C1", 94897, "4844aa14fb916094189c7487eba5d61d666d4bb040e839f7519bbd3c14fd5b18"),
    ("C2", 95777, "0037233ffef75ce631594dc304ca33bbf8165c2ebab90c761193d88eab474510"),
    ("C3", 79597, "97a8599ec63093a901fd57b03c0be9c994232e0ee0696e41cb3e9458e6899a95"),
    ("C4", 75085, "eda2774ffe811f64d4cc1c7c6829e7ec03cfaafddc2395ce5cf6b66f5dde2519"),
    ("C5", 91261, "5a427b7c53d8a20f43f7c10548688026c24f567887b7fb86c3571d16638b4772"),
    ("C6", 82477, "69995902601d3598e402b24dcd854f2717f9e8a8ca048c67380755f73c5789f3"),
    ("C7", 79405, "5b06ca1802e9761cad71b89902b7811980a87a665a09e7186d1836b2dd624c3c"),
];

fn pinned(name: &str) -> (usize, &'static str) {
    let row = PINNED.iter().find(|r| r.0 == name).unwrap_or_else(|| panic!("no pin for {name}"));
    (row.1, row.2)
}

/// One fixture, proved inside `catch_unwind`: the proof, or the panic message.
///
/// [gate v2 r1, R4] The gate used to call `prove` bare. Every sabotage the WP0d
/// verifiers ran trips a degree guard INSIDE the prover (`B1 TERMINAL DEGREE
/// BOUND VIOLATED`, `[B2] UNDER-SEGMENTED`), so the test died at the first
/// generic fixture, "C0": "C0-legacy", proved first, had passed silently, C1 to
/// C7 were never attempted, and the gate's own message was never produced by
/// any experiment. A panic is now one fixture's verdict, not the end of the run.
fn prove_caught(name: &str) -> Result<Vec<u8>, String> {
    let name = name.to_string();
    std::panic::catch_unwind(move || prove(&name)).map_err(|payload| {
        let msg = payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "a panic with no message".to_string());
        msg.lines().next().unwrap_or("").chars().take(200).collect()
    })
}

/// What is wrong with one fixture's outcome, or `None` when it is the pinned
/// proof.
fn verdict(name: &str, outcome: &Result<Vec<u8>, String>) -> Option<String> {
    let (len, want) = pinned(name);
    match outcome {
        Ok(bytes) => {
            let digest = sha256_hex(bytes);
            (bytes.len() != len || digest != want)
                .then(|| format!("{name}: got {} B {digest}, pinned {len} B {want}", bytes.len()))
        }
        Err(panic) => Some(format!("{name}: NO PROOF, the prover panicked: {panic}")),
    }
}

fn gate_message(mismatches: &[String]) -> String {
    format!(
        "WP0d BYTE-IDENTITY BROKEN: {} of {} proofs differ from the pre-NTT prover.\n  {}\n\
         The LDE rewrite must evaluate the same polynomials at the same coset points in the \
         same order. Do not re-pin: a moved v1 proof is a wire change.",
        mismatches.len(),
        NAMES.len(),
        mismatches.join("\n  "),
    )
}

/// THE GATE. Every fixture's proof is byte-identical to the pre-WP0d prover's.
///
/// Every fixture is attempted, whatever the others did, and the failure lists
/// all of them: a moved digest and a prover panic are both "this fixture is not
/// the pinned proof".
///
/// `P01_WP0D_DUMP_DIR=<dir>` also writes each proof to `<dir>/<fixture>.bin`,
/// so a before/after pair can be compared with `cmp` independently of this
/// file's own hashing.
#[test]
fn proofs_are_byte_identical_to_the_pre_ntt_prover() {
    assert_eq!(NAMES.len(), PINNED.len(), "one pin per fixture");
    let dump = std::env::var("P01_WP0D_DUMP_DIR").ok();
    let mut mismatches: Vec<String> = Vec::new();
    println!();
    println!("{:<10} {:>7}  sha256", "fixture", "bytes");
    for name in NAMES {
        let outcome = prove_caught(name);
        match &outcome {
            Ok(bytes) => {
                println!("{name:<10} {:>7}  {}", bytes.len(), sha256_hex(bytes));
                if let Some(dir) = &dump {
                    std::fs::create_dir_all(dir).expect("create dump dir");
                    std::fs::write(format!("{dir}/{name}.bin"), bytes).expect("write dump");
                }
            }
            Err(panic) => println!("{name:<10}   PANIC  {panic}"),
        }
        mismatches.extend(verdict(name, &outcome));
    }
    assert!(mismatches.is_empty(), "{}", gate_message(&mismatches));
}

/// [gate v2 r1, R4] The reporting path itself, which no sabotage had ever
/// reached: a proof with one byte flipped, a truncated proof and a panicking
/// prover are each reported under their fixture's name, and the pinned proof
/// is not. Without this, a gate that silently dropped a mismatch (or a fixture)
/// would still be green on a correct prover.
#[test]
fn the_gate_reports_a_moved_proof_a_short_proof_and_a_panic() {
    let good = prove("C0-legacy");
    assert_eq!(verdict("C0-legacy", &Ok(good.clone())), None, "the pinned proof is not a mismatch");

    let mut flipped = good.clone();
    let last = flipped.len() - 1;
    flipped[last] ^= 1;
    let moved = verdict("C0-legacy", &Ok(flipped)).expect("one flipped bit is a mismatch");
    assert!(moved.starts_with("C0-legacy: got 47641 B ") && moved.contains("pinned 47641 B 157f45be"), "{moved}");

    let short = verdict("C0-legacy", &Ok(good[..good.len() - 1].to_vec())).expect("a short proof is a mismatch");
    assert!(short.contains("got 47640 B"), "{short}");

    // The same bytes under another fixture's name are that fixture's mismatch.
    assert!(verdict("C7", &Ok(good)).is_some_and(|m| m.starts_with("C7: ")));

    // A panic inside the prover is caught, attributed, and does not stop the run.
    let caught = prove_caught("no-such-fixture").expect_err("an unknown fixture panics");
    assert_eq!(caught, "unknown fixture no-such-fixture");
    let panicked = verdict("C7", &Err(caught)).expect("a panic is a mismatch");
    assert_eq!(panicked, "C7: NO PROOF, the prover panicked: unknown fixture no-such-fixture");

    let msg = gate_message(&[moved, panicked]);
    assert!(msg.starts_with("WP0d BYTE-IDENTITY BROKEN: 2 of 9 proofs differ"), "{msg}");
    assert!(msg.contains("\n  C0-legacy: got ") && msg.contains("\n  C7: NO PROOF"), "{msg}");
}

/// The pin only means something if a fixture is a function of its inputs. If a
/// random draw ever crept into a generator, the gate above would fail at random
/// and say "the NTT is wrong" when it is not; this says what is actually wrong.
#[test]
fn every_fixture_is_deterministic() {
    for name in NAMES {
        assert_eq!(
            sha256_hex(&prove(name)),
            sha256_hex(&prove(name)),
            "{name}: two proofs of the same witness and mask differ, so no pin can hold"
        );
    }
}

/// [WP0d] Native proving time, fixed witnesses and fixed masks, N = 5 per
/// fixture. A MEASUREMENT, not a gate: run it on purpose, in release, on an idle
/// machine, and record the machine with the numbers.
///
/// Fixed masks rather than CSPRNG draws: the grinding nonce search depends on
/// the transcript, so a fresh mask per sample changes the proof-of-work time
/// from sample to sample (`bench_all_circuits.rs` reports a 2-6x min/max
/// spread). With a fixed mask the grinding work is identical before and after,
/// and the difference between two runs of this bench is the LDE.
///
/// Every sample is also checked against the pin, so the time is the time of the
/// byte-identical proof and not of something faster and wrong.
///
/// Each row also prints the grinding work of that proof, read off the wire (the
/// nonce search starts at 0, so `nonce + 1` SHA-256 iterations were spent). It is
/// the same work before and after WP0d, because the proofs are the same bytes.
/// Its cost per iteration is measured in place by
/// `prove_time_split_grinding_vs_rest`, not here.
///
/// `P01_WP0D_BENCH_OUT=<file>` writes the raw samples as JSON.
#[test]
#[ignore = "a measurement (~1 min pre-WP0d); run with --ignored in release"]
fn prove_timing_fixed_masks() {
    const N: usize = 5;
    println!();
    println!("native prove, release, fixed witness + fixed mask, N = {N}");
    println!(
        "{:<10} {:>9} {:>9} {:>9}  {:>7}  {:>12}",
        "fixture", "min ms", "median ms", "max ms", "bytes", "grind hashes"
    );
    let mut json = String::from("{\n");
    for (i, name) in NAMES.iter().enumerate() {
        let (len, want) = pinned(name);
        let mut ms: Vec<f64> = Vec::with_capacity(N);
        let mut hashes: Option<u64> = None;
        for _ in 0..N {
            let t = Instant::now();
            let bytes = prove(name);
            ms.push(t.elapsed().as_secs_f64() * 1000.0);
            assert_eq!((bytes.len(), sha256_hex(&bytes).as_str()), (len, want), "{name}: timed proof is not the pinned proof");
            hashes = grinding_hashes(name, &bytes);
        }
        let raw = ms.clone();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let h = hashes.map_or("n/a".to_string(), |h| h.to_string());
        println!("{name:<10} {:>9.1} {:>9.1} {:>9.1}  {len:>7}  {h:>12}", ms[0], ms[N / 2], ms[N - 1]);
        json.push_str(&format!(
            "  \"{name}\": {{\"prove_ms\": {raw:?}, \"min\": {:.3}, \"median\": {:.3}, \"max\": {:.3}, \"bytes\": {len}, \"grinding_hashes\": {}}}{}\n",
            ms[0], ms[N / 2], ms[N - 1],
            hashes.map_or("null".to_string(), |h| h.to_string()),
            if i + 1 == NAMES.len() { "" } else { "," }
        ));
    }
    json.push_str("}\n");
    if let Ok(path) = std::env::var("P01_WP0D_BENCH_OUT") {
        std::fs::write(&path, json).expect("write bench json");
        println!("raw samples written to {path}");
    }
}

/// `nonce + 1`, read off a GENERIC proof's wire (`None` for the legacy C0
/// format). Layout: roots (64) | ood current + next (16 w) | z (8) | the eight
/// Q_j(z) (64) | layer count (1) + roots (32 L) | final-poly length (2) + coeffs
/// (8 F) | nonce (8) | num_queries (2). The query count right after the nonce
/// must read back as 22 or 27, so a misparse fails here instead of printing a
/// wrong number.
fn grinding_hashes(name: &str, b: &[u8]) -> Option<u64> {
    let w = match name {
        "C0" => air::subscriber_ownership::MASKED_TRACE_WIDTH,
        "C1" => air::denominated_pool::TRACE_WIDTH,
        "C2" => air::balance_proof::TRACE_WIDTH,
        "C3" => air::merkle_path::TRACE_WIDTH,
        "C4" => air::confidential_balance::TRACE_WIDTH,
        "C5" => air::transfer::TRACE_WIDTH,
        "C6" => air::merkle_update::TRACE_WIDTH,
        "C7" => air::spend::TRACE_WIDTH,
        _ => return None,
    };
    let mut o = 64 + 16 * w + 8 + 8 * 8;
    let layers = b[o] as usize;
    o += 1 + 32 * layers;
    let f = u16::from_le_bytes([b[o], b[o + 1]]) as usize;
    o += 2 + 8 * f;
    let nonce = u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let q = u16::from_le_bytes([b[o + 8], b[o + 9]]);
    assert!(q == 22 || q == 27, "{name}: misparsed the wire (num_queries read as {q})");
    Some(nonce + 1)
}

/// [WP0d] How much of a native proof is grinding, measured IN PLACE.
///
/// After the NTT the LDE is no longer the bulk of a proof, and the 22-bit
/// grinding nonce search is: its length is geometric (mean 2^22 hashes) and
/// depends on the transcript, so it is what makes one proof take 30 ms and the
/// next 600 ms. A SHA-256 micro-benchmark underestimates the loop (it does not
/// run inside the prover's own loop), so this fits it instead: prove the same
/// witness under 8 different masks, read each proof's `nonce + 1` off the wire,
/// and least-squares `median_ms = rest_ms + slope * hashes`. `slope` is the
/// in-place cost per grinding iteration and `rest_ms` is everything else. An
/// R^2 near 1 is the check that the model fits; it is printed, not asserted.
#[test]
#[ignore = "a measurement (~20 s post-WP0d); run with --ignored in release"]
fn prove_time_split_grinding_vs_rest() {
    const SALTS: u64 = 8;
    const RUNS: usize = 3;
    println!();
    println!("in-place grinding split, release, {SALTS} masks x median of {RUNS}");
    for name in ["C5", "C7"] {
        let mut pts: Vec<(f64, f64)> = Vec::new();
        for salt in 1..=SALTS {
            let mut ms: Vec<f64> = Vec::with_capacity(RUNS);
            let mut h = 0u64;
            for _ in 0..RUNS {
                let t = Instant::now();
                let b = prove_salted(name, salt);
                ms.push(t.elapsed().as_secs_f64() * 1000.0);
                h = grinding_hashes(name, &b).expect("generic fixture");
            }
            ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!("  {name} salt {salt}: {h:>9} hashes, median {:>7.1} ms", ms[RUNS / 2]);
            pts.push((h as f64, ms[RUNS / 2]));
        }
        let n = pts.len() as f64;
        let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
        let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
        let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
        let sxx: f64 = pts.iter().map(|p| (p.0 - mx) * (p.0 - mx)).sum();
        let syy: f64 = pts.iter().map(|p| (p.1 - my) * (p.1 - my)).sum();
        let slope = sxy / sxx;
        let rest = my - slope * mx;
        let r2 = sxy * sxy / (sxx * syy);
        println!(
            "{name}: rest {rest:.1} ms, grinding {:.2} ns/iteration, R^2 {r2:.4}; at the mean 2^22 hashes a proof is ~{:.0} ms",
            slope * 1e6,
            rest + slope * 4_194_304.0,
        );
    }
}
