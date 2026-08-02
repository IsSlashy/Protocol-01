//! CROSS-CIRCUIT CONFUSION — can a proof for one circuit be accepted as another?
//!
//! `verify_uniform` (lib.rs) probes circuit configs in a fixed order and takes
//! the FIRST whose `from_bytes` succeeds. Its own comment says it does not fall
//! through on a *verification* failure, for CU reasons. So the probe is a
//! **parse-only discriminator**, and its correctness rests entirely on the claim
//! that no two configs accept the same byte string.
//!
//! That claim had never been tested. This file tests it, exhaustively, across
//! all 7×7 ordered pairs — under BOTH envelopes:
//!
//!   * exact-length bytes (what `cargo test` naturally produces), and
//!   * **the envelope the shipped client actually sends**: every proof padded
//!     with trailing zeros to `UNIFORM_PROOF_SIZE = 145_000`
//!     (`apps/mobile/services/stark/index.ts`). Under that envelope length
//!     discriminates NOTHING — all seven circuits present exactly 145,000 bytes
//!     — so the probe rests on the internal field checks alone.
//!
//! Reading the matrix: a `Some` off the diagonal is a confusion. A `Some` off
//! the diagonal at a config that is probed EARLIER than the true one is a live
//! confusion in `verify_uniform`.

mod common;

use p01_stark_verifier::compact_proof::{
    get_circuit_config, CompactStarkProof, GenericCompactProof,
};

/// The uniform envelope the mobile client pads every proof to before upload.
/// Mirrors `export const UNIFORM_PROOF_SIZE = 145_000;` in
/// `apps/mobile/services/stark/index.ts`. `tests/cu_budget.rs` already pins the
/// two against each other; this file only needs the number.
const UNIFORM_PROOF_SIZE: usize = 145_000;

/// `verify_uniform`'s probe order, copied from `lib.rs`. If that constant moves,
/// this file must move with it — `probe_order_matches_lib` pins it.
const PROBE_ORDER: [u8; 4] = [1, 6, 3, 5];

// ============================================================================
// One genuine proof per circuit
// ============================================================================

fn genuine_proof_bytes(circuit_id: u8) -> Vec<u8> {
    match circuit_id {
        0 => common::prove0(&common::w0(0)).proof_bytes,
        1 => common::prove1(&common::w1(0)).proof_bytes,
        2 => common::prove2(&common::w2(0)).proof_bytes,
        3 => common::prove3(&common::w3(0)).proof_bytes,
        4 => common::prove4(&common::w4(0)).proof_bytes,
        5 => common::prove5(&common::w5(0)).proof_bytes,
        6 => common::prove6(&common::w6(0)).proof_bytes,
        _ => unreachable!(),
    }
}

fn all_genuine() -> Vec<Vec<u8>> {
    (0u8..=6).map(genuine_proof_bytes).collect()
}

/// Pad exactly as `padProofToUniformSize` does: a zero-filled buffer of
/// `UNIFORM_PROOF_SIZE`, with the proof copied into the front.
fn pad_uniform(bytes: &[u8]) -> Vec<u8> {
    assert!(bytes.len() <= UNIFORM_PROOF_SIZE);
    let mut out = vec![0u8; UNIFORM_PROOF_SIZE];
    out[..bytes.len()].copy_from_slice(bytes);
    out
}

fn parses_as(bytes: &[u8], circuit_id: u8) -> bool {
    let config = get_circuit_config(circuit_id).expect("0..=6 has a config");
    GenericCompactProof::from_bytes(bytes, config).is_some()
}

fn render_matrix(label: &str, m: &[[bool; 7]; 7]) -> String {
    let mut s = format!("\n{label}\n      as C0 as C1 as C2 as C3 as C4 as C5 as C6\n");
    for (n, row) in m.iter().enumerate() {
        s.push_str(&format!("C{n} → "));
        for cell in row.iter() {
            s.push_str(if *cell { "  PARSE" } else { "      ." });
        }
        s.push('\n');
    }
    s
}

// ============================================================================
// 1. The recorded sizes, re-measured
// ============================================================================

#[test]
fn recorded_proof_sizes_hold() {
    // Sizes carried in the brief. Re-measured here so a format change that
    // shifts a size cannot silently invalidate the size-based reasoning below.
    const RECORDED: [usize; 7] = [47_641, 68_881, 69_761, 78_157, 81_457, 78_877, 81_037];
    let proofs = all_genuine();
    let mut measured = [0usize; 7];
    for (i, p) in proofs.iter().enumerate() {
        measured[i] = p.len();
    }
    println!("measured sizes: {measured:?}");
    assert_eq!(measured, RECORDED, "proof sizes drifted from the recorded set");

    // Pairwise distinct — a necessary condition for length to discriminate at
    // all. (It is NOT sufficient: see `parser_length_check_is_a_minimum`.)
    for i in 0..7 {
        for j in (i + 1)..7 {
            assert_ne!(measured[i], measured[j], "C{i} and C{j} have the same length");
        }
    }
}

#[test]
fn probe_order_matches_lib() {
    let src = include_str!("../src/lib.rs");
    let needle = "const PROBE_ORDER: [u8; 4] = [";
    let start = src.find(needle).expect("PROBE_ORDER not found in lib.rs") + needle.len();
    let end = start + src[start..].find(']').expect("unterminated PROBE_ORDER");
    let parsed: Vec<u8> = src[start..end]
        .split(',')
        .map(|t| t.trim().parse::<u8>().expect("probe order entry"))
        .collect();
    assert_eq!(
        parsed.as_slice(),
        &PROBE_ORDER[..],
        "verify_uniform's probe order changed; this suite's reasoning is stale",
    );
    assert!(!parsed.contains(&0), "[C0 GATE] circuit 0 must never be probed");
}

// ============================================================================
// 2. THE DEFECT: the parser's length check is a MINIMUM, not an equality
// ============================================================================

/// **MEASURED: the parser's length checks are minimums, in both parsers.**
///
/// Every check in `from_bytes` is `if data.len() < cursor + X`, and neither
/// parser ever compares the final cursor to `data.len()`. An arbitrary tail —
/// zeros or not — is accepted and ignored.
///
/// This test asserts that as a FACT rather than a defect, and the reason is not
/// leniency: it is load-bearing. `apps/mobile/services/stark/index.ts` pads
/// every proof to `UNIFORM_PROOF_SIZE = 145_000` before upload and declares that
/// as `proof_size`, and `verify_uniform` parses the whole padded slice. An
/// exact-length parser would reject 100% of proofs the shipped client sends.
/// Scanning the tail for zeros instead is not affordable either: the largest
/// tail is 145_000 - 47_641 = 97_359 bytes against a C4 phase-1 budget already
/// at 843,918 of 861,000 CU.
///
/// So this is stated, not fixed, and the consequences are drawn where they land:
///
///   * length can NEVER discriminate circuits at this probe — see
///     `cross_circuit_parse_matrix_uniform_padded` for what does;
///   * the encoding of a given statement is malleable (any tail verifies), so
///     nothing may key uniqueness or replay off proof bytes.
#[test]
fn parser_length_check_is_a_minimum_not_an_equality() {
    for cid in 0u8..=6 {
        let bytes = genuine_proof_bytes(cid);
        assert!(parses_as(&bytes, cid), "C{cid}: exact-length genuine proof must parse");

        for extra in [1usize, 2, 31, 1_000, 63_543] {
            let mut longer = bytes.clone();
            longer.extend(std::iter::repeat(0u8).take(extra));
            assert!(
                parses_as(&longer, cid),
                "C{cid}: a {extra}-byte tail is now REJECTED. If that was deliberate, the \
                 mobile client's UNIFORM_PROOF_SIZE padding must go first — as written it \
                 sends {UNIFORM_PROOF_SIZE} bytes for every circuit and every proof would \
                 now fail to parse on chain.",
            );
            // Non-zero tails too: the parser does not look, so "zero-padded" is
            // not a property the wire format enforces.
            let mut noisy = bytes.clone();
            noisy.extend(std::iter::repeat(0xABu8).take(extra));
            assert!(parses_as(&noisy, cid), "C{cid}: non-zero {extra}-byte tail");
        }
    }
}

/// The legacy C0 parser has the same shape and the same property. Stated
/// separately because C0 is the sole verifier for four shipped instructions, so
/// "the two parsers agree" is worth an assertion of its own.
#[test]
fn legacy_parser_length_check_is_a_minimum_too() {
    let bytes = genuine_proof_bytes(0);
    assert!(CompactStarkProof::from_bytes(&bytes).is_some(), "genuine C0 must parse");
    for extra in [1usize, 1_000, 97_359] {
        let mut longer = bytes.clone();
        longer.extend(std::iter::repeat(0u8).take(extra));
        assert!(
            CompactStarkProof::from_bytes(&longer).is_some(),
            "legacy parser rejected a C0 proof with a {extra}-byte tail while the generic \
             parser accepts one — the two wire contracts have drifted",
        );
    }
}

/// Truncation must always fail — the direction that already worked. Pinned so a
/// fix for the tail cannot be written as "accept anything".
#[test]
fn parser_rejects_truncation() {
    for cid in 0u8..=6 {
        let bytes = genuine_proof_bytes(cid);
        for cut in [1usize, 2, 33, 5_000] {
            let short = &bytes[..bytes.len() - cut];
            assert!(!parses_as(short, cid), "C{cid}: parser accepted a proof {cut} bytes short");
        }
        assert!(CompactStarkProof::from_bytes(&bytes[..bytes.len() - 1]).is_none() || cid != 0);
    }
}

// ============================================================================
// 3. The 7×7 matrix, exact-length envelope
// ============================================================================

#[test]
fn cross_circuit_parse_matrix_exact_length() {
    let proofs = all_genuine();
    let mut m = [[false; 7]; 7];
    for n in 0..7usize {
        for k in 0..7usize {
            m[n][k] = parses_as(&proofs[n], k as u8);
        }
    }
    println!("{}", render_matrix("EXACT-LENGTH ENVELOPE", &m));

    for n in 0..7usize {
        assert!(m[n][n], "C{n} does not parse under its own config");
        for k in 0..7usize {
            if k == n {
                continue;
            }
            assert!(
                !m[n][k],
                "CONFUSION: a genuine C{n} proof parses as C{k}. `verify_uniform` takes the \
                 FIRST config that parses, so this is a live mis-dispatch whenever C{k} is \
                 probed before C{n}.",
            );
        }
    }
}

// ============================================================================
// 4. The 7×7 matrix under the envelope the client actually sends
// ============================================================================

/// **The envelope that ships.** `apps/mobile/services/stark/index.ts` pads every
/// proof with trailing zeros to `UNIFORM_PROOF_SIZE` before upload, and
/// `verify_uniform` slices `proof_size` bytes straight out of the buffer — so
/// the probe sees 145,000 bytes for EVERY circuit and length discriminates
/// nothing.
///
/// This is the matrix that matters. The diagonal must stay true (the shipped
/// flow must keep working) and everything off it must stay false with NO help
/// from length.
#[test]
fn cross_circuit_parse_matrix_uniform_padded() {
    let proofs = all_genuine();
    let padded: Vec<Vec<u8>> = proofs.iter().map(|p| pad_uniform(p)).collect();
    let mut m = [[false; 7]; 7];
    for n in 0..7usize {
        for k in 0..7usize {
            m[n][k] = parses_as(&padded[n], k as u8);
        }
    }
    println!("{}", render_matrix("UNIFORM 145,000-BYTE ENVELOPE", &m));

    for n in 0..7usize {
        for k in 0..7usize {
            if k == n {
                continue;
            }
            assert!(
                !m[n][k],
                "CONFUSION UNDER THE SHIPPED ENVELOPE: a genuine C{n} proof padded to \
                 {UNIFORM_PROOF_SIZE} bytes parses as C{k}.",
            );
        }
    }
}

/// WHAT the discriminator actually is, now that length has been shown not to be
/// it: three exact-value fields read at config-dependent offsets. This test
/// names them and shows each one is decisive on its own, so a future edit that
/// loosens any of them turns red here rather than silently leaving the probe
/// resting on the other two.
///
/// `num_queries` is the one the seam pass added: it was read from the wire and
/// only bounded by `> 256`, with the equality deferred to
/// `verify_query_positions_generic` — i.e. AFTER the probe had already committed
/// to a circuit. Moving it into the parser is a strict tightening (an honest
/// proof always carries exactly `config.num_queries`) and it is the only one of
/// the three that separates C1 (27) from C3/C5/C6 (22).
#[test]
fn the_discriminator_is_three_exact_value_fields_not_length() {
    let bytes = genuine_proof_bytes(3);
    let cfg = get_circuit_config(3).unwrap();

    // Offsets, derived from the wire layout the parser walks.
    let tw = cfg.trace_width;
    let k = cfg.quotient_segments;
    let off_num_fri_layers = 32 + 32 + tw * 8 + tw * 8 + 8 + k * 8;
    let off_fri_final_size = off_num_fri_layers + 1 + /* layers */ 8 * 32;
    let off_num_queries = off_fri_final_size + 2 + cfg.fri_final_poly_size * 8 + 8;

    // Sanity: the offsets point at the values the config says they must hold.
    assert_eq!(bytes[off_num_fri_layers], 8, "num_fri_layers byte");
    assert_eq!(
        u16::from_le_bytes([bytes[off_fri_final_size], bytes[off_fri_final_size + 1]]),
        cfg.fri_final_poly_size as u16,
    );
    assert_eq!(
        u16::from_le_bytes([bytes[off_num_queries], bytes[off_num_queries + 1]]) as usize,
        cfg.num_queries,
        "num_queries on the wire must be the config's — 22 for C3",
    );

    // Each field alone is decisive.
    for (name, off, len) in [
        ("num_fri_layers", off_num_fri_layers, 1usize),
        ("fri_final_poly_size", off_fri_final_size, 2),
        ("num_queries", off_num_queries, 2),
    ] {
        for delta in [1u8, 0xFF] {
            let mut tampered = bytes.clone();
            for b in tampered[off..off + len].iter_mut() {
                *b = b.wrapping_add(delta);
            }
            assert!(
                !parses_as(&tampered, 3),
                "{name}: the parser accepted a proof whose {name} disagrees with the config \
                 (+{delta}). That field is one of the three the parse-only probe in \
                 verify_uniform depends on.",
            );
        }
    }
}

/// The `num_queries` tightening restated as the property it buys, on the exact
/// pair the probe order was written to worry about: C1 is probed FIRST, so a
/// C3/C5/C6 proof that parsed as C1 would be mis-dispatched. C1 wants 27 queries
/// and C3/C5/C6 carry 22 — a field the parser now reads.
#[test]
fn parse_time_query_count_separates_c1_from_the_22_query_circuits() {
    for cid in [3u8, 5, 6] {
        let bytes = genuine_proof_bytes(cid);
        assert_eq!(get_circuit_config(cid).unwrap().num_queries, 22);
        assert_eq!(get_circuit_config(1).unwrap().num_queries, 27);
        assert!(
            !parses_as(&bytes, 1),
            "C{cid} parses as C1, which `verify_uniform` probes FIRST",
        );
        assert!(!parses_as(&pad_uniform(&bytes), 1), "…and under the padded envelope");
    }
}

// ============================================================================
// 5. C0 ↔ generic, both directions
// ============================================================================

/// C0's wire format is byte-for-byte the generic format at
/// `CONFIG_SUBSCRIBER_OWNERSHIP` (tw=3, md=9, k=7, 4 FRI layers). So a C0 proof
/// DOES parse through the generic parser — the refusal is behavioural, not
/// structural. Pinned in both directions so a future edit that drops the
/// `CircuitZeroIsLegacyOnly` gates cannot be mistaken for safe on the grounds
/// that "the parser would reject it anyway".
#[test]
fn c0_bytes_parse_through_the_generic_parser_so_the_gate_is_load_bearing() {
    let c0 = genuine_proof_bytes(0);
    assert!(
        parses_as(&c0, 0),
        "if this ever goes false the C0 gates are belt-and-braces; today they are the only \
         thing standing between a C0 proof and the generic verifier",
    );

    // Behavioural refusal: the generic verifier says no to circuit 0 before it
    // touches a single byte.
    let config = get_circuit_config(0).unwrap();
    let proof = GenericCompactProof::from_bytes(&c0, config).unwrap();
    let err = p01_stark_verifier::verify::verify_generic(&proof, 0, &[1], config).unwrap_err();
    assert!(
        matches!(err, p01_stark_verifier::verify::VerifyError::CircuitZeroIsLegacyOnly),
        "generic path must refuse circuit 0 by name, got {err:?}",
    );
}

/// The other direction: no C1..C6 proof may parse through the LEGACY parser.
/// If one did, `verify_stark_proof` with a buffer whose `circuit_id` is 0 would
/// hand a foreign proof to `verify_subscriber_ownership` — and C0 is the sole
/// verifier for four shipped instructions
/// (`zk_shielded::{pause,resume,cancel_private_stark}`, `p01_quantum_wallet`).
#[test]
fn no_generic_proof_parses_through_the_legacy_c0_parser() {
    for cid in 1u8..=6 {
        let bytes = genuine_proof_bytes(cid);
        assert!(
            CompactStarkProof::from_bytes(&bytes).is_none(),
            "CONFUSION: a genuine C{cid} proof parses through the LEGACY C0 parser. C0 is the \
             sole verifier for four shipped instructions.",
        );
        // …and under the shipped padded envelope too.
        let padded = pad_uniform(&bytes);
        assert!(
            CompactStarkProof::from_bytes(&padded).is_none(),
            "CONFUSION: a padded C{cid} proof parses through the LEGACY C0 parser",
        );
    }
}

// ============================================================================
// 6. The u8::MAX sentinel and the dispatch arms
// ============================================================================

/// `init_proof_buffer_v2` stores `circuit_id = u8::MAX` until `verify_uniform`
/// probes it. Every lookup that can see that value must fail closed.
#[test]
fn sentinel_and_every_unknown_id_have_no_config() {
    assert!(get_circuit_config(u8::MAX).is_none(), "the u8::MAX sentinel resolved to a config");
    for cid in 7u8..=u8::MAX {
        assert!(get_circuit_config(cid).is_none(), "circuit {cid} resolved to a config");
    }
    for cid in 0u8..=6 {
        assert!(get_circuit_config(cid).is_some(), "circuit {cid} lost its config");
    }
}

/// `get_boundary_assertions` is documented as failing closed and has a test for
/// 7/8/100/255. The OTHER dispatch arms were never swept. Every entry point that
/// takes a `circuit_id` must refuse an unknown one — including the sentinel —
/// rather than silently doing nothing.
#[test]
fn every_circuit_id_dispatch_fails_closed_on_unknown_ids() {
    // A structurally valid proof so the dispatch is reached with real data:
    // parse a genuine C3 proof, then feed it under foreign ids.
    let c3 = genuine_proof_bytes(3);
    let config3 = get_circuit_config(3).unwrap();
    let proof = GenericCompactProof::from_bytes(&c3, config3).unwrap();
    let public_inputs = [1u64, 2, 15];

    for cid in [7u8, 8, 100, 254, u8::MAX] {
        // verify_generic's step-4 dispatch.
        let err = p01_stark_verifier::verify::verify_generic(&proof, cid, &public_inputs, config3)
            .unwrap_err();
        assert!(
            !matches!(err, p01_stark_verifier::verify::VerifyError::CircuitZeroIsLegacyOnly),
            "circuit {cid} produced the C0 error",
        );
    }

    // Circuit 0 must fail closed at get_boundary_assertions' CALLERS too — but
    // 0 itself is a listed id there, so the refusal lives in verify_generic.
    assert!(matches!(
        p01_stark_verifier::verify::verify_generic(&proof, 0, &public_inputs, config3),
        Err(p01_stark_verifier::verify::VerifyError::CircuitZeroIsLegacyOnly),
    ));
}
