//! CROSS-LANGUAGE WIRE PARITY: the prover crate and the verifier crate are two
//! independent implementations of one format. This file diffs them by DRIVING
//! them, not by reading either one's source.
//!
//! # What was already covered, and what was not
//!
//! Three things in the tree already speak to prover/verifier agreement:
//!
//!   * `b1_deep_binding::cross_language_fixture_digests` pins seven proof
//!     sha256 digests, which the TypeScript side pins again against the shipped
//!     WASM blob. That proves the two LANGUAGES emit the same bytes. It says
//!     nothing about whether those bytes match the verifier's declared geometry
//!     — a prover and a WASM copy of that same prover agree with each other by
//!     construction, and both could disagree with `CircuitConfig`.
//!   * `b1_deep_binding::prover_and_verifier_agree_on_the_segmentation_constants`
//!     covers FIVE constants (`GRINDING_BITS`, the two `*_QUOTIENT_SEGMENTS`,
//!     the two `*_FRI_FINAL_POLY_DEGREE_BOUND`) and covers them by SOURCE TEXT
//!     — `prover.contains("const GENERIC_QUOTIENT_SEGMENTS: usize = 8;")`. The
//!     comment two hundred lines above it in `verify.rs` records exactly why
//!     that is not enough: `GRINDING_BITS` was pinned twice by text while the
//!     verifier compared against a hardcoded `16`, and the whole package stayed
//!     green. A text pin proves a constant is DECLARED, never that it is USED.
//!   * `honest_liveness` proves honest proofs verify, which would catch a
//!     geometry disagreement — but only as a blanket rejection, with no field
//!     named, and only for the witnesses it happens to enumerate.
//!
//! NOT covered before this file: `trace_width`, `trace_length`, `blowup`,
//! `lde_size`, `merkle_depth`, `num_queries`, `num_fri_layers` and
//! `fri_final_poly_size` — eight of the eleven `CircuitConfig` fields — and the
//! TOTAL SERIALIZED LENGTH, which nothing anywhere checks (see
//! `the_parser_does_not_check_length_this_test_does`).
//!
//! Every assertion below is measured off real proof bytes produced by the
//! prover crate and read back through the verifier's own parser. No source
//! string is read to reach a verdict.

use p01_stark_verifier::compact_proof::{
    get_circuit_config, CircuitConfig, CompactStarkProof, GenericCompactProof,
    CONFIG_SUBSCRIBER_OWNERSHIP, FRI_FINAL_POLY_SIZE, LEGACY_QUOTIENT_SEGMENTS, MERKLE_DEPTH,
    TRACE_WIDTH,
};

// ---------------------------------------------------------------------------
// Fixtures — the SAME seven witnesses `b1_deep_binding.rs`, `wireFormat.test.ts`
// and `prover-behaviour.mjs` use, so a reader can diff the four files directly.
// ---------------------------------------------------------------------------

fn fixture_c0() -> Vec<u8> {
    p01_stark::compact::generate_compact_proof(42).proof_bytes
}
fn fixture_c1() -> Vec<u8> {
    p01_stark::compact::generate_pool_commitment_proof(42, 17, 7, 11).proof_bytes
}
fn fixture_c2() -> Vec<u8> {
    p01_stark::compact::generate_balance_compact_proof(42, 1000, 777, 999).proof_bytes
}
fn fixture_c3() -> Vec<u8> {
    let pe: Vec<u64> = (0..12u64).map(|i| 1000 + i).collect();
    let pi: Vec<u8> = (0..12u8).map(|i| i % 2).collect();
    p01_stark::compact::generate_merkle_path_compact_proof(777, &pe, &pi, &p01_stark::compact::c3_deterministic_probe_mask(pe.len())).proof_bytes
}
fn fixture_c4() -> Vec<u8> {
    p01_stark::compact::generate_confidential_balance_compact_proof(
        42, 1000, 111, 800, 222, 200, 333, 999,
    )
    .proof_bytes
}
fn fixture_c5() -> Vec<u8> {
    p01_stark::compact::generate_transfer_compact_proof(
        13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50,
    )
    .proof_bytes
}
fn fixture_c6() -> Vec<u8> {
    let pe: Vec<u64> = (0..12).map(|i| 100u64 + i * 13).collect();
    let pi: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();
    p01_stark::compact::generate_merkle_update_compact_proof(111, 222, &pe, &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len())).proof_bytes
}

fn fixture_c7() -> Vec<u8> {
    use p01_stark::air::spend::{CANONICAL_DEPTH, MASK_ROWS, TRACE_WIDTH};
    const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;

    let pe: Vec<u64> = (0..CANONICAL_DEPTH as u64).map(|i| 1000 + i * 37).collect();
    let pi: Vec<u8> = (0..CANONICAL_DEPTH).map(|i| (i % 2) as u8).collect();
    // Deterministic: a wire-size pin needs the same bytes every run. ⛔ NOT the
    // shape a spend uses -- that draws MASK_ROWS * TRACE_WIDTH fresh CSPRNG
    // elements for every proof, and reusing a mask across two proofs of one
    // note relates two traces that must be independent.
    let mut st = 0x9E37_79B9_7F4A_7C15u64;
    let mut mask = Vec::with_capacity(MASK_ROWS * TRACE_WIDTH);
    for _ in 0..(MASK_ROWS * TRACE_WIDTH) {
        st ^= st >> 12;
        st ^= st << 25;
        st ^= st >> 27;
        mask.push(st.wrapping_mul(0x2545_F491_4F6C_DD1D) % GOLDILOCKS);
    }
    p01_stark::compact::generate_spend_compact_proof(
        42, 999, 7, 555, &pe, &pi, &[11, 22, 33, 44], &mask,
    )
    .proof_bytes
}

/// `(circuit_id, label, build)`.
type Circuit = (u8, &'static str, fn() -> Vec<u8>);

/// The seven GENERIC circuits, C1 through C7. C0 is on the legacy parser and is
/// handled separately everywhere below, because it is a different function with
/// a different signature — lumping the two is how a legacy-only defect gets a
/// green from a generic-only sweep.
///
/// (Said "six" until 2026-08-26. The array grew to seven when C7 landed and the
/// sentence above it did not, which is the smallest possible version of the
/// thing `c7_pin_coverage.rs` exists to catch.)
const GENERIC: [Circuit; 7] = [
    (1, "C1 pool_commitment", fixture_c1),
    (2, "C2 balance_proof", fixture_c2),
    (3, "C3 merkle_path", fixture_c3),
    (4, "C4 confidential_balance", fixture_c4),
    (5, "C5 transfer", fixture_c5),
    (6, "C6 merkle_update", fixture_c6),
    // [C7 2026-08-24] C7 is the circuit this file exists for. It shares C6's
    // trace width, trace length, blowup, LDE size, merkle depth and query
    // count; `fri_final_poly_size` (32 against 16) is the ONLY field that
    // separates the two configs, and the parity sweep below is what would
    // notice if it stopped.
    (7, "C7 spend", fixture_c7),
];

// ---------------------------------------------------------------------------
// The closed form, DERIVED FROM THE PARSER'S OWN CURSOR ARITHMETIC
// ---------------------------------------------------------------------------

/// Bytes of the pair path published for FRI layer `layer`.
///
/// Twin of the private `compact_proof::fri_layer_pair_path_bytes`. Written out
/// here rather than exported, so that this file re-derives the layout instead of
/// borrowing the very function it is checking.
fn fri_layer_pair_path_bytes(merkle_depth: usize, layer: usize) -> usize {
    merkle_depth.saturating_sub(layer + 2) * 32
}

/// How many FRI layer roots the wire must carry, from the config alone.
///
/// `GenericCompactProof::from_bytes` enforces exactly this
/// (`num_fri_layers != num_folds.saturating_sub(1)` -> `None`), so it is a
/// config-derived quantity and not a free wire field.
fn expected_fri_layers(config: &CircuitConfig) -> usize {
    let num_folds = (config.lde_size / config.fri_final_poly_size).trailing_zeros() as usize;
    num_folds.saturating_sub(1)
}

/// The EXACT number of bytes a proof for `config` occupies on the wire.
///
/// This is the sum of every `cursor +=` in the parser, in order, with nothing
/// rounded and nothing approximated. It is the length rule the PROVER encodes by
/// construction and the VERIFIER encodes only as a chain of lower bounds — see
/// `the_parser_does_not_check_length_this_test_does`.
///
/// Identical for the legacy and generic layouts: they differ in WHERE the
/// geometry comes from (constants vs `CircuitConfig`), not in the field order.
fn expected_wire_size(config: &CircuitConfig) -> usize {
    let tw = config.trace_width;
    let md = config.merkle_depth;
    let nq = config.num_queries;
    let k = config.quotient_segments;
    let fps = config.fri_final_poly_size;
    let layers = expected_fri_layers(config);

    let header = 32                       // trace_root
        + 32                              // quotient_root
        + tw * 8                          // ood_current
        + tw * 8                          // ood_next
        + 8                               // ood_z
        + k * 8                           // [B2] ood_quotient, one Q_j(z) per segment
        + 1                               // num_fri_layers
        + layers * 32                     // fri_layer_roots
        + 2                               // fri_final_poly_size
        + fps * 8                         // fri_final_poly
        + 8                               // grinding_nonce
        + 2; // num_queries

    let fri_block: usize = (0..layers)
        .map(|i| 16 + fri_layer_pair_path_bytes(md, i))
        .sum();

    let per_query = 4                     // position
        + 4 * tw * 8                      // [ROUTE C] row | mirror | next | next-mirror
        + (md - 1) * 32                   // trace pair path
        + (md - 1) * 32                   // next-row trace pair path
        + k * 8                           // [B2/B4] quotient mirror block
        + (md - 1) * 32                   // quotient pair path
        + fri_block;

    header + nq * per_query + nq * k * 8 // + the segment-major quotient tail
}

// ---------------------------------------------------------------------------
// 1. Every CircuitConfig field the wire encodes, RECOVERED from the bytes
// ---------------------------------------------------------------------------
//
// # Why the obvious measurement is worthless, and what replaces it
//
// The obvious way to "measure" the geometry is to parse with the circuit's own
// config and read the field widths back off the parsed proof. THAT IS CIRCULAR
// and it is worth naming, because it is the shape a reviewer would accept:
//
//   ood_current_bytes = &data[cursor .. cursor + config.trace_width * 8]
//
// so `proof.ood_current_iter().count()` is `config.trace_width` for ANY input
// long enough, including a proof of a different circuit and including 145,000
// bytes of zeroes. The same holds for `quotient_segments` (sliced by
// `config.quotient_segments`) and for `merkle_depth` (paths sliced by
// `config.merkle_depth`). Three of the eight fields cannot be measured that way
// at all, and a test that did would be green against every mutation of them.
//
// So the geometry is RECOVERED instead: sweep candidate `(trace_width,
// merkle_depth, quotient_segments)` triples, keep every one under which the
// bytes both PARSE and consume EXACTLY `bytes.len()`, and require that the
// surviving set is the single triple the circuit's config declares. Nothing in
// that procedure is told the answer. `num_queries` and `num_fri_layers` are read
// straight off the wire and are not circular to begin with.

/// Every `(trace_width, merkle_depth, quotient_segments)` under which `bytes`
/// parses AND accounts for its own length exactly.
///
/// The sweep bounds are deliberately far wider than anything shipped: widths to
/// 16 (largest shipped is 10), depths to 20 (largest is 13), segments to 16
/// (largest is 8). A recovery that is unique only because the sweep was narrow
/// would be a measurement of the sweep.
/// Every `fri_final_poly_size` any shipping config declares.
///
/// 🚨 THIS SWEEP HARD-CODED 16 UNTIL 2026-08-25, AND C7 IS THE ONLY CIRCUIT
/// THAT IS NOT 16 — it is 32. So no candidate this function built could ever
/// have the right wire size for a C7 proof, `recover_geometry` returned an EMPTY
/// set for it, and `every_wire_field_agrees_with_the_config_that_declares_it`
/// failed with "the bytes are consistent with the geometries [] and the config's
/// (10, 13, 8) is NOT among them — the two crates disagree about the circuit's
/// shape". They do not disagree. The recovery could not see C7's shape at all.
///
/// `ci.yml` runs this target, so that red predates and is independent of the
/// PROBE_ORDER change: it has been failing since C7 gained a wire fixture.
///
/// Derived from the configs rather than listed, so a circuit with a new
/// `fri_final_poly_size` is swept the day it lands instead of silently
/// recovering nothing. That is mildly circular — the configs are also what the
/// sweep is checking — but strictly less so than a literal that matches six
/// circuits and no seventh, and the ambiguity SET it produces is still recovered
/// from the bytes.
fn declared_fri_final_poly_sizes() -> Vec<usize> {
    let mut sizes: Vec<usize> = (0u8..=7)
        .filter_map(get_circuit_config)
        .map(|c| c.fri_final_poly_size)
        .collect();
    sizes.sort_unstable();
    sizes.dedup();
    assert!(
        sizes.len() >= 2,
        "every shipping circuit declares the same fri_final_poly_size ({sizes:?}); this sweep \
         is back to a single literal and the next circuit that differs will recover nothing"
    );
    sizes
}

fn recover_geometry(bytes: &[u8], num_queries: usize) -> Vec<(usize, usize, usize)> {
    let mut found = Vec::new();
    for ffps in declared_fri_final_poly_sizes() {
        for tw in 1..=16usize {
            for md in 2..=20usize {
                for k in 1..=16usize {
                    let candidate = CircuitConfig {
                        trace_width: tw,
                        trace_length: (1usize << md) / 16,
                        blowup: 16,
                        lde_size: 1usize << md,
                        merkle_depth: md,
                        num_rounds: 30,
                        fri_final_poly_size: ffps,
                        // Never read by `from_bytes` and never part of the wire
                        // size, so it cannot widen or narrow this set.
                        fri_final_poly_degree_bound: 1,
                        quotient_segments: k,
                        num_queries,
                    };
                    if expected_wire_size(&candidate) != bytes.len() {
                        continue;
                    }
                    if GenericCompactProof::from_bytes(bytes, &candidate).is_some() {
                        found.push((tw, md, k));
                    }
                }
            }
        }
    }
    found.sort_unstable();
    found.dedup();
    found
}

/// Compare the recovered geometry against the config that declares it,
/// collecting EVERY disagreement rather than dying on the first.
///
/// Collecting matters here for the same reason it matters in
/// `cross_language_fixture_digests`: a geometry change moves several fields at
/// once, and a test that surfaces one field per run turns a single re-measure
/// into seven rebuilds of a slow suite, which is the pressure that produces a
/// half-updated pin set.
#[allow(clippy::too_many_arguments)]
fn diff(
    label: &str,
    bytes: &[u8],
    wire_num_queries: usize,
    wire_num_fri_layers: usize,
    wire_fri_final_poly_size: usize,
    max_position: usize,
    c: &CircuitConfig,
    drift: &mut Vec<String>,
) {
    let mut push = |field: &str, measured: usize, declared: usize| {
        if measured != declared {
            drift.push(format!(
                "{label}.{field}: prover emitted {measured}, CircuitConfig declares {declared}"
            ));
        }
    };

    // Read straight off the wire — not sliced by the config, so not circular.
    push("num_queries", wire_num_queries, c.num_queries);
    push("num_fri_layers", wire_num_fri_layers, expected_fri_layers(c));
    push("fri_final_poly_size", wire_fri_final_poly_size, c.fri_final_poly_size);
    push("bytes", bytes.len(), expected_wire_size(c));

    // Recovered by sweep — the only non-circular reading of the three fields the
    // parser slices by.
    //
    // MEASURED, and it is not what one would guess: `merkle_depth` IS uniquely
    // determined by the bytes, but `trace_width` and `quotient_segments` are NOT
    // — they trade off along `2*trace_width + quotient_segments = const`, because
    // a trace column costs `32` bytes per query (four Route C rows) and a
    // quotient segment costs `16` (the mirror block plus the tail entry), so
    // swapping one column for two segments is byte-for-byte free AND parses.
    // Six to eight distinct geometries produce byte-identical proofs for every
    // shipped circuit. The declared pair is therefore pinned only up to that
    // line, and this test says exactly that instead of claiming a uniqueness the
    // format does not have.
    let declared = (c.trace_width, c.merkle_depth, c.quotient_segments);
    let invariant = 2 * c.trace_width + c.quotient_segments;
    let predicted: Vec<(usize, usize, usize)> = (1..=16usize)
        .filter_map(|tw| {
            let k = invariant.checked_sub(2 * tw)?;
            if (1..=16).contains(&k) {
                Some((tw, c.merkle_depth, k))
            } else {
                None
            }
        })
        .collect();
    let recovered = recover_geometry(bytes, wire_num_queries);
    println!(
        "[GEOM] {label} declared {declared:?}, invariant 2*tw+k={invariant}, \
         {} byte-identical geometries: {recovered:?}",
        recovered.len()
    );
    if !recovered.contains(&declared) {
        drift.push(format!(
            "{label}: the bytes are consistent with the geometries {recovered:?} and the \
             config's {declared:?} is NOT among them — the two crates disagree about the \
             circuit's shape"
        ));
    }
    if recovered != predicted {
        drift.push(format!(
            "{label}: the ambiguity set moved. Recovered {recovered:?}, but the layout \
             predicts exactly {predicted:?} — every (trace_width, quotient_segments) with \
             2*tw+k = {invariant} inside the sweep, at merkle_depth {}. A set that is \
             SMALLER means a field started separating that did not before (good, re-pin); a \
             set that is LARGER or at a different depth means the layout changed under this \
             test.",
            c.merkle_depth
        ));
    }

    // `lde_size` and `blowup` are not wire fields; they are checkable only as
    // the domain the positions live in and the relation to `trace_length`.
    if c.lde_size != c.trace_length * c.blowup {
        drift.push(format!(
            "{label}.lde_size: config says {} but trace_length * blowup is {}",
            c.lde_size,
            c.trace_length * c.blowup
        ));
    }
    if max_position >= c.lde_size {
        drift.push(format!(
            "{label}.position: prover emitted a query at {max_position} on a domain of size {}",
            c.lde_size
        ));
    }
    // `merkle_depth` must be log2 of the domain it authenticates, or the pair
    // paths cannot reach a root.
    if 1usize << c.merkle_depth != c.lde_size {
        drift.push(format!(
            "{label}.merkle_depth: 2^{} = {} but lde_size is {}",
            c.merkle_depth,
            1usize << c.merkle_depth,
            c.lde_size
        ));
    }
}

/// THE headline check. Eight geometry fields plus the total length, on all seven
/// circuits, prover-side measured against verifier-side declared.
///
/// A disagreement here is not a soundness hole — it makes every honest proof
/// fail — but it fails at the LAST instruction of a ~145-transaction chunked
/// upload, after the user has paid for all of it, and it names nothing.
#[test]
fn every_wire_field_agrees_with_the_config_that_declares_it() {
    let mut drift: Vec<String> = Vec::new();

    // C0 — legacy parser, geometry from module constants rather than a config.
    {
        let bytes = fixture_c0();
        let proof = CompactStarkProof::from_bytes(&bytes)
            .expect("C0 fixture must parse with the verifier's legacy parser");
        let max_position = proof.queries.iter().map(|q| q.position as usize).max().unwrap();
        println!(
            "[WIRE] C0 subscriber_ownership  nq={} layers={} fps={} bytes={}",
            proof.queries.len(),
            proof.num_fri_layers(),
            proof.fri_final_poly_iter().count(),
            bytes.len()
        );
        diff(
            "C0",
            &bytes,
            proof.queries.len(),
            proof.num_fri_layers(),
            proof.fri_final_poly_iter().count(),
            max_position,
            &CONFIG_SUBSCRIBER_OWNERSHIP,
            &mut drift,
        );

        // The legacy parser does NOT read its geometry from `CircuitConfig`; it
        // reads it from `TRACE_WIDTH` / `MERKLE_DEPTH` / `LEGACY_QUOTIENT_SEGMENTS`
        // / `FRI_FINAL_POLY_SIZE`. Those four are a SECOND declaration of C0's
        // geometry and nothing tied them to `CONFIG_SUBSCRIBER_OWNERSHIP`.
        if TRACE_WIDTH != CONFIG_SUBSCRIBER_OWNERSHIP.trace_width {
            drift.push(format!(
                "C0: compact_proof::TRACE_WIDTH is {TRACE_WIDTH} but \
                 CONFIG_SUBSCRIBER_OWNERSHIP.trace_width is {}",
                CONFIG_SUBSCRIBER_OWNERSHIP.trace_width
            ));
        }
        if MERKLE_DEPTH != CONFIG_SUBSCRIBER_OWNERSHIP.merkle_depth {
            drift.push(format!(
                "C0: compact_proof::MERKLE_DEPTH is {MERKLE_DEPTH} but \
                 CONFIG_SUBSCRIBER_OWNERSHIP.merkle_depth is {}",
                CONFIG_SUBSCRIBER_OWNERSHIP.merkle_depth
            ));
        }
        if LEGACY_QUOTIENT_SEGMENTS != CONFIG_SUBSCRIBER_OWNERSHIP.quotient_segments {
            drift.push(format!(
                "C0: LEGACY_QUOTIENT_SEGMENTS is {LEGACY_QUOTIENT_SEGMENTS} but \
                 CONFIG_SUBSCRIBER_OWNERSHIP.quotient_segments is {}",
                CONFIG_SUBSCRIBER_OWNERSHIP.quotient_segments
            ));
        }
        if FRI_FINAL_POLY_SIZE != CONFIG_SUBSCRIBER_OWNERSHIP.fri_final_poly_size {
            drift.push(format!(
                "C0: FRI_FINAL_POLY_SIZE is {FRI_FINAL_POLY_SIZE} but \
                 CONFIG_SUBSCRIBER_OWNERSHIP.fri_final_poly_size is {}",
                CONFIG_SUBSCRIBER_OWNERSHIP.fri_final_poly_size
            ));
        }
    }

    for (cid, label, build) in GENERIC.iter() {
        let config = get_circuit_config(*cid).expect("every generic circuit has a config");
        let bytes = build();
        let proof = GenericCompactProof::from_bytes(&bytes, config)
            .unwrap_or_else(|| panic!("{label} fixture must parse with its own config"));
        let max_position = proof.queries.iter().map(|q| q.position as usize).max().unwrap();
        println!(
            "[WIRE] {label}  nq={} layers={} fps={} bytes={}",
            proof.queries.len(),
            proof.num_fri_layers(),
            proof.fri_final_poly_iter().count(),
            bytes.len()
        );
        diff(
            label,
            &bytes,
            proof.queries.len(),
            proof.num_fri_layers(),
            proof.fri_final_poly_iter().count(),
            max_position,
            config,
            &mut drift,
        );
    }

    assert!(
        drift.is_empty(),
        "\n\n  >>> PROVER / VERIFIER GEOMETRY SKEW <<<\n  {}\n\n  These are wire parameters \
         held twice, once per crate, with no shared type. Every one of them was measured off \
         real proof bytes; none of them was read out of a source file. A disagreement makes \
         every honest proof of that circuit fail on the LAST instruction of a chunked upload, \
         after the user has paid for the whole thing.\n",
        drift.join("\n  "),
    );
}

/// The parser accepts a proof LONGER than the format, so nothing on chain checks
/// the length rule the prover encodes. This test is the only place it is checked.
///
/// MEASURED, and this is the point: `from_bytes` is a chain of
/// `if data.len() < cursor + X { return None; }` and there is no final
/// `cursor == data.len()`. Appending arbitrary bytes to an honest proof leaves it
/// parsing, and that is not incidental — the shipped mobile client pads EVERY
/// proof to `UNIFORM_PROOF_SIZE = 145_000` before upload, so on the live path the
/// verifier is ALWAYS handed a buffer longer than the format. Length can
/// therefore never be a discriminator on chain, and any comment that reasons from
/// "the length checks would reject it" is reasoning about a case the shipped
/// client does not produce.
#[test]
fn the_parser_does_not_check_length_this_test_does() {
    // Leg 1: the exact closed form reproduces every shipped proof size.
    let sizes: Vec<(&str, usize, usize)> = std::iter::once(("C0", fixture_c0().len(), {
        expected_wire_size(&CONFIG_SUBSCRIBER_OWNERSHIP)
    }))
    .chain(GENERIC.iter().map(|(cid, label, build)| {
        let config = get_circuit_config(*cid).unwrap();
        (*label, build().len(), expected_wire_size(config))
    }))
    .collect();
    for (label, actual, closed_form) in sizes.iter() {
        println!("[LEN] {label} actual {actual} closed-form {closed_form}");
    }
    let bad: Vec<String> = sizes
        .iter()
        .filter(|(_, a, c)| a != c)
        .map(|(l, a, c)| format!("{l}: emitted {a}, the layout implies {c}"))
        .collect();
    assert!(
        bad.is_empty(),
        "\n\n  >>> WIRE LENGTH SKEW <<<\n  {}\n",
        bad.join("\n  ")
    );

    // Leg 2: the parser itself does not enforce any of it. Stated as a measured
    // fact so nobody later argues that it does. A tail of arbitrary bytes — the
    // shape the uniform-padding client actually produces — still parses.
    let config = get_circuit_config(1).unwrap();
    let honest = fixture_c1();
    for tail in [1usize, 4096, 145_000 - 68_881] {
        let mut padded = honest.clone();
        padded.resize(honest.len() + tail, 0u8);
        assert!(
            GenericCompactProof::from_bytes(&padded, config).is_some(),
            "a {tail}-byte zero tail must still parse — if this ever becomes an \
             Err, the shipped uniform-padding client stops working and this test \
             is the warning, not the bug"
        );
        let mut padded_nz = honest.clone();
        padded_nz.resize(honest.len() + tail, 0xABu8);
        assert!(
            GenericCompactProof::from_bytes(&padded_nz, config).is_some(),
            "a {tail}-byte 0xAB tail also parses; the tail is not read at all"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. The uniform probe — the one place circuit identity is GUESSED
// ---------------------------------------------------------------------------

/// The order `verify_uniform` probes configs in, replicated here so the
/// behaviour below is driven rather than described.
///
/// It is pinned against the program text by
/// `the_probe_order_this_test_drives_is_the_one_the_program_implements`, because
/// a behavioural test of the wrong order is worse than no test: it would report
/// a resolution nothing on chain performs.
const PROBE_ORDER: [u8; 5] = [1, 6, 3, 5, 7];

/// `apps/mobile/services/stark/index.ts`, embedded at COMPILE time so moving the
/// file is a build failure rather than a skipped check.
const MOBILE_STARK_TS: &str = include_str!("../../../apps/mobile/services/stark/index.ts");

/// `programs/p01_stark_verifier/src/lib.rs`, likewise.
const VERIFIER_LIB_RS: &str = include_str!("../src/lib.rs");

/// Parse `export const UNIFORM_PROOF_SIZE = 145_000;` out of the mobile client.
///
/// Read rather than copied, for the same reason `cu_budget.rs` reads it: the
/// padding envelope is a CLIENT constant that decides what the on-chain parser
/// is handed, and a second Rust-side copy of it is not a binding.
fn uniform_proof_size() -> usize {
    const NEEDLE: &str = "export const UNIFORM_PROOF_SIZE = ";
    let at = MOBILE_STARK_TS
        .find(NEEDLE)
        .expect("`export const UNIFORM_PROOF_SIZE = ` not found in the mobile STARK client");
    let digits: String = MOBILE_STARK_TS[at + NEEDLE.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '_')
        .collect();
    digits.replace('_', "").parse().expect("numeric literal")
}

/// Run the probe loop exactly as `verify_uniform` does and report what it lands
/// on. `None` = every probe refused to parse.
fn probe(bytes: &[u8]) -> Option<u8> {
    for &cid in PROBE_ORDER.iter() {
        let config = match get_circuit_config(cid) {
            Some(c) => c,
            None => continue,
        };
        if GenericCompactProof::from_bytes(bytes, config).is_some() {
            return Some(cid);
        }
    }
    None
}

#[test]
fn the_probe_order_this_test_drives_is_the_one_the_program_implements() {
    let want = format!(
        "const PROBE_ORDER: [u8; {}] = [{}];",
        PROBE_ORDER.len(),
        PROBE_ORDER
            .iter()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    assert!(
        VERIFIER_LIB_RS.contains(&want),
        "\n\n  >>> PROBE ORDER SKEW <<<\n  programs/p01_stark_verifier/src/lib.rs must \
         contain, verbatim:\n\n    {want}\n\n  The probe order is LOAD-BEARING — it decides \
         which circuit a proof is verified AS — and every behavioural assertion in this file \
         drives the copy above. If the program's order changed, change this constant in the \
         same commit and re-run; do not delete the assertion.\n",
    );
}

/// Under the SHIPPED uniform pipeline, which circuits can the probe actually
/// resolve, and which does it get wrong?
///
/// The mobile client pads every proof to `UNIFORM_PROOF_SIZE` before upload, so
/// all seven circuits present the SAME byte count to the probe and every
/// `data.len() < cursor + X` check is satisfied for every config. This test runs
/// the probe on padded proofs — the only shape the live path produces — rather
/// than on bare ones, which is the shape no client sends.
///
/// What it establishes:
///
///   * C1, C3, C5 and C6 resolve to THEMSELVES. That is the liveness claim the
///     uniform pipeline rests on and nothing checked it.
///   * C0, C2 and C4 are NOT in the probe set and do NOT resolve to themselves.
///     A client that submits one burns the whole ~145-transaction upload and
///     ~1.01 SOL of transient rent before the verify instruction fails.
///     `submitAndVerifyStarkProofUniform` in the mobile client takes any
///     `GenericStarkProof` and has no guard for this; its live call sites use
///     C1/C3/C6 only, so it is a latent liveness hole, not a live one.
#[test]
fn every_circuit_resolves_through_the_uniform_probe_or_is_named_as_unsupported() {
    let uniform = uniform_proof_size();
    assert_eq!(
        uniform, 145_000,
        "the mobile client's padding envelope moved; re-read this test before re-pinning"
    );

    let pad = |mut v: Vec<u8>| -> Vec<u8> {
        assert!(v.len() <= uniform, "a proof larger than the envelope cannot be padded");
        v.resize(uniform, 0u8);
        v
    };

    let all: Vec<(u8, &str, Vec<u8>)> = std::iter::once((0u8, "C0 subscriber_ownership", pad(fixture_c0())))
        .chain(
            GENERIC
                .iter()
                .map(|(cid, label, build)| (*cid, *label, pad(build()))),
        )
        .collect();

    let mut wrong: Vec<String> = Vec::new();
    for (cid, label, bytes) in all.iter() {
        let got = probe(bytes);
        println!(
            "[PROBE] {label} padded to {} B -> {:?}",
            bytes.len(),
            got
        );
        let in_probe_set = PROBE_ORDER.contains(cid);
        if in_probe_set {
            if got != Some(*cid) {
                wrong.push(format!(
                    "{label} is in PROBE_ORDER but the probe resolved it to {got:?} — the \
                     uniform pipeline cannot verify it at all"
                ));
            }
        } else if let Some(other) = got {
            // [C7 2026-08-24] WAS `else if got == Some(*cid)`, which only
            // complained when the probe resolved a non-member to ITSELF. A
            // non-member resolving to a DIFFERENT circuit produced no entry in
            // `wrong` and this test went green.
            //
            // That is precisely the shape C7 creates: it is in GENERIC and
            // deliberately out of PROBE_ORDER, and it shares every observable
            // config field with C6 except `fri_final_poly_size`. A C7 proof
            // resolving to C6 would be checked against C6's constraints, and
            // nothing in this file would have said so.
            if other == *cid {
                wrong.push(format!(
                    "{label} is NOT in PROBE_ORDER yet the probe resolved it to itself; \
                     either the probe set grew or this test is reading a stale order"
                ));
            } else {
                wrong.push(format!(
                    "{label} is NOT in PROBE_ORDER yet the probe resolved it to C{other} \
                     -- a MIS-PROBE, not an unsupported circuit. Its proof would be \
                     checked against C{other}'s constraints."
                ));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "\n\n  >>> UNIFORM PROBE RESOLUTION <<<\n  {}\n",
        wrong.join("\n  ")
    );
}

/// The probe's separating power under padding is NOT the length checks.
///
/// `verify_uniform` justifies putting C6 before C3/C5 with "its strict tw=10
/// length checks (`data.len() < cursor + 80`) reject any C3/C5-shaped proof".
/// That reasoning does not survive the shipped client: every proof arrives padded
/// to 145,000 bytes, so no lower-bound length check can refuse anything. This
/// test measures what is actually doing the separating — the exact-value checks
/// (`fri_final_poly_size`, the `num_fri_layers == num_folds - 1` relation and
/// `num_queries != config.num_queries`), read at offsets that move with
/// `trace_width`, `merkle_depth` and `quotient_segments`.
///
/// It drives the claim directly: a C3, C5 or C6 proof padded to the envelope must
/// still be refused by the OTHER two configs.
#[test]
fn under_uniform_padding_the_22_query_circuits_still_separate() {
    let uniform = uniform_proof_size();
    let pad = |mut v: Vec<u8>| -> Vec<u8> {
        v.resize(uniform, 0u8);
        v
    };
    let subjects: [Circuit; 3] = [
        (3, "C3 merkle_path", fixture_c3),
        (5, "C5 transfer", fixture_c5),
        (6, "C6 merkle_update", fixture_c6),
    ];
    let mut confusions: Vec<String> = Vec::new();
    for (cid, label, build) in subjects.iter() {
        let bytes = pad(build());
        for (other, other_label, _) in subjects.iter() {
            if other == cid {
                continue;
            }
            let config = get_circuit_config(*other).unwrap();
            if GenericCompactProof::from_bytes(&bytes, config).is_some() {
                confusions.push(format!(
                    "a padded {label} proof PARSES as {other_label} — under padding the only \
                     thing left between them is the value checks, and they did not separate"
                ));
            }
        }
    }
    assert!(
        confusions.is_empty(),
        "\n\n  >>> CROSS-CONFIG PARSE UNDER PADDING <<<\n  {}\n",
        confusions.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// 3. Determinism — the precondition every digest pin in the repo rests on
// ---------------------------------------------------------------------------

/// The geometry measurements above are worth nothing if the prover is not
/// deterministic, and so are the seven sha256 pins in `b1_deep_binding.rs`,
/// `wireFormat.test.ts` and `prover-behaviour.mjs`.
///
/// `fixture_proofs_are_deterministic` already asserts this for the same seven
/// witnesses. Repeated here on ONE circuit only, as a cheap local precondition,
/// so that a failure in this file is never mistaken for nondeterminism.
#[test]
fn the_measurements_in_this_file_rest_on_a_deterministic_prover() {
    assert_eq!(fixture_c1(), fixture_c1(), "C1 proof generation must be deterministic");
}
