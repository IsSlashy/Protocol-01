//! CROSS-CIRCUIT CONFUSION — can a proof for one circuit be accepted as another?
//!
//! `verify_uniform` (lib.rs) probes circuit configs in a fixed order and takes
//! the FIRST whose `from_bytes` succeeds. Its own comment says it does not fall
//! through on a *verification* failure, for CU reasons. So the probe is a
//! **parse-only discriminator**, and its correctness rests entirely on the claim
//! that no two configs accept the same byte string.
//!
//! That claim had never been tested. This file tests it, exhaustively, across
//! all 8×8 ordered pairs — under BOTH envelopes:
//!
//! 🚨 IT SWEPT 7×7 UNTIL 2026-08-25, AND C7 WAS THE ROW AND COLUMN IT SKIPPED.
//!
//! The storage was already `[[false; 8]; 8]`, `all_genuine()` already built the
//! C7 proof, and `genuine_proof_bytes` already had a `7 =>` arm — but every
//! sweep ran `0..7usize`, so the C7 proof was generated, padded, stored and
//! never probed against a foreign config in either direction. The header and
//! both section banners said "7×7" the whole time; the eight-wide storage is
//! what made it read as covered.
//!
//! That mattered beyond tidiness. `ci.yml` justifies running this target by
//! claiming it is "the 8x8 parse matrix ... the only test that would notice" if
//! `fri_final_poly_size` stopped separating C6 from C7. It would not have
//! noticed. And `verify_uniform` is a parse-only discriminator that takes the
//! FIRST config that accepts the bytes, so an unmeasured C7 collision is a
//! soundness question, not a cosmetic one — which is exactly what had to be
//! settled before deciding whether C7 joins `PROBE_ORDER`.
//!
//! MEASURED once the sweep was widened: both matrices are perfectly diagonal.
//! C7 parses only as C7, nothing else parses as C7, under exact-length AND
//! under the 145,000-byte padded envelope.
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
const PROBE_ORDER: [u8; 5] = [1, 6, 3, 5, 7];

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
        7 => common::prove7(&common::w7(0)).proof_bytes,
        _ => unreachable!(),
    }
}

fn all_genuine() -> Vec<Vec<u8>> {
    (0u8..=7).map(genuine_proof_bytes).collect()
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
    let config = get_circuit_config(circuit_id).expect("0..=7 has a config");
    GenericCompactProof::from_bytes(bytes, config).is_some()
}

fn render_matrix(label: &str, m: &[[bool; 8]; 8]) -> String {
    let mut s = format!("\n{label}\n      as C0 as C1 as C2 as C3 as C4 as C5 as C6 as C7\n");
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
    // [C7 2026-08-24] Eighth entry: 77,965 B, MEASURED. C7 is SMALLER than C6
    // (81,037) despite identical width, length, blowup and query count, because
    // `fri_final_poly_size = 32` drops one committed FRI layer.
    const RECORDED: [usize; 8] =
        [47_641, 68_881, 69_761, 78_157, 81_457, 78_877, 81_037, 77_965];
    let proofs = all_genuine();
    let mut measured = [0usize; 8];
    for (i, p) in proofs.iter().enumerate() {
        measured[i] = p.len();
    }
    println!("measured sizes: {measured:?}");
    assert_eq!(measured, RECORDED, "proof sizes drifted from the recorded set");

    // Pairwise distinct — a necessary condition for length to discriminate at
    // all. (It is NOT sufficient: see `parser_length_check_is_a_minimum`.)
    //
    // 🚨 8, NOT 7, AND THIS LOOP WAS THE ONE C7 SLIPPED THROUGH. `0b7d12c0` was
    // titled "the parse matrix swept 7x7 — C7 was the row and column it
    // skipped" and widened every other sweep in this file (79, 227, 326, 371,
    // 613, 756, 1018, 1027, 1059). This one kept `0..7`, so `measured[7]` was
    // asserted equal to `RECORDED[7]` two lines above and then compared against
    // nothing. The file warns about exactly this shape at the `0..=7` loop
    // below — "this loop and the one below were HALF updated" — which is how a
    // second half-update went unnoticed in the same file, in the same commit.
    //
    // Widening is safe and was checked before it was written: 77,965 is
    // distinct from all seven others, and `assert_eq!(measured, RECORDED)`
    // above proves 77,965 is what the real C7 proof measures.
    for i in 0..8 {
        for j in (i + 1)..8 {
            assert_ne!(measured[i], measured[j], "C{i} and C{j} have the same length");
        }
    }
}

/// **MEASURED: nothing in the Fiat-Shamir transcript binds the circuit.**
///
/// `derive_ood_point` hashes `(trace_root, quotient_root, public_inputs)`;
/// `build_base_seed` adds the three OOD arrays; `derive_query_positions_generic`
/// adds the FRI layer roots, the final poly and the grinding nonce. No circuit
/// id, no config digest, no per-circuit domain tag — and there is no verifying
/// key to hash either (`vk_hash` does not exist anywhere in this program; the
/// `vk_hash_subscriber` on the subscription vault is a Groth16 key, unrelated).
///
/// The test states that behaviourally rather than by reading the source: run a
/// genuine C3 proof through `verify_generic` under a FOREIGN `circuit_id`, with
/// C3's own config and C3's own public inputs. Steps 0..3.5 — OOD derivation,
/// query-position derivation, grinding, Merkle, FRI — do not read `circuit_id`,
/// so if the transcript were bound they would reject. They do not. The refusal
/// comes only from the step-4 constraint dispatch.
///
/// So circuit identity is enforced in exactly one place, the AIR the dispatch
/// picks, and everything upstream of it is circuit-agnostic. That is what makes
/// `verify_uniform`'s parse-only probe the whole of the separation, and it is
/// why the tuple test below matters.
#[test]
fn the_transcript_does_not_bind_the_circuit_only_the_step4_dispatch_does() {
    use p01_stark_verifier::verify::VerifyError as E;

    let c3 = common::prove3(&common::w3(0));
    let cfg3 = get_circuit_config(3).unwrap();
    let proof = GenericCompactProof::from_bytes(&c3.proof_bytes, cfg3).unwrap();

    p01_stark_verifier::verify::verify_generic(&proof, 3, &c3.public_inputs, cfg3)
        .expect("control: honest C3 must verify");

    for foreign in [1u8, 2, 4, 5, 6] {
        let err = p01_stark_verifier::verify::verify_generic(
            &proof, foreign, &c3.public_inputs, cfg3,
        )
        .expect_err("a C3 proof must not verify as another circuit");
        println!("C3 proof under circuit_id={foreign} -> {err:?}");
        assert!(
            !matches!(
                err,
                E::OodConstraintFailed
                    | E::InvalidQueryPosition
                    | E::InsufficientQueries
                    | E::MerkleProofFailed
                    | E::FriFoldCheckFailed
            ),
            "circuit_id={foreign} was rejected at {err:?}, i.e. UPSTREAM of the constraint \
             dispatch. If that is now true the transcript has gained a circuit binding — good, \
             but this test's premise is stale and every claim resting on it must be re-read.",
        );
    }
}

/// **The separation is STRUCTURAL for only two of the seven, and for the rest it
/// reduces to `trace_width` — a field that never travels on the wire.**
///
/// `verify_uniform` is a parse-only discriminator, so what separates the configs
/// is exactly the tuple `from_bytes` can observe: the three exact-value fields it
/// compares (`num_fri_layers`, `fri_final_poly_size`, `num_queries`) plus the
/// offsets at which it reads them, which are set by `trace_width`,
/// `merkle_depth` and `quotient_segments`.
///
/// Printing that tuple makes the real shape of the thing visible:
///
///   C0 tw=3  md=9  k=7 nq=27 nfl=4
///   C1 tw=3  md=11 k=8 nq=27 nfl=6
///   C2 tw=4  md=11 k=8 nq=27 nfl=6   <- differs from C1 in trace_width ALONE
///   C3 tw=6  md=13 k=8 nq=22 nfl=8
///   C4 tw=4  md=12 k=8 nq=27 nfl=7
///   C5 tw=7  md=13 k=8 nq=22 nfl=8   <- differs from C3 in trace_width ALONE
///   C6 tw=10 md=13 k=8 nq=22 nfl=8   <- same
///
/// For {C1,C2} and {C3,C5,C6} every wire-visible exact-value field is IDENTICAL.
/// The only thing keeping a foreign buffer out is that `trace_width` shifts where
/// those fields are read from, so the parser lands on bytes that mean something
/// else — Merkle-root and OOD bytes — and they have to hit 1 + 2 + 2 = 5 exact
/// bytes by luck. That is ~2^40 proof regenerations to force a mis-probe, which
/// is not a practical attack (each proof costs seconds), but it is a
/// probabilistic separation, not a structural one, and it is the whole of it:
/// nothing in this system binds a circuit's identity cryptographically. See the
/// module note on the transcript.
///
/// This test fails the moment a new circuit is added whose observable tuple
/// collides with an existing one — the case where the argument above collapses
/// from "2^40" to "0", and `PROBE_ORDER` silently decides which AIR a proof is
/// checked against.
#[test]
fn no_two_configs_share_the_tuple_the_parser_can_observe() {
    let mut tuples = Vec::new();
    for cid in 0u8..=7 {
        let c = get_circuit_config(cid).unwrap();
        let nfl = (c.lde_size / c.fri_final_poly_size).trailing_zeros() as usize - 1;
        println!(
            "C{cid} tw={} md={} k={} nq={} nfl={} fps={}",
            c.trace_width, c.merkle_depth, c.quotient_segments, c.num_queries, nfl,
            c.fri_final_poly_size,
        );
        tuples.push((
            cid,
            (c.trace_width, c.merkle_depth, c.quotient_segments, c.num_queries, nfl,
             c.fri_final_poly_size),
        ));
    }
    for i in 0..tuples.len() {
        for j in (i + 1)..tuples.len() {
            assert_ne!(
                tuples[i].1, tuples[j].1,
                "C{} and C{} are INDISTINGUISHABLE to `from_bytes`. `verify_uniform` takes the \
                 first config that parses, so PROBE_ORDER — not the proof — would decide which \
                 AIR each is checked against.",
                tuples[i].0, tuples[j].0,
            );
        }
    }

    // …and the sharper statement: for four of the pairs, deleting `trace_width`
    // from the tuple makes them collide. Pinned so nobody concludes from the
    // green matrix that the configs are well separated.
    let collapsed: Vec<_> = tuples
        .iter()
        .map(|(cid, t)| (*cid, (t.1, t.2, t.3, t.4, t.5)))
        .collect();
    let mut collisions = 0usize;
    for i in 0..collapsed.len() {
        for j in (i + 1)..collapsed.len() {
            if collapsed[i].1 == collapsed[j].1 {
                collisions += 1;
                println!(
                    "C{} / C{}: separated by trace_width ALONE",
                    collapsed[i].0, collapsed[j].0
                );
            }
        }
    }
    assert_eq!(
        collisions, 4,
        "the number of config pairs separated by trace_width alone changed (was 4: C1/C2, \
         C3/C5, C3/C6, C5/C6). Re-read `cross_circuit_parse_matrix_uniform_padded` before \
         accepting the new number — a pair that becomes separated by nothing else is a pair \
         whose separation is a byte-offset coincidence.",
    );
}

#[test]
fn probe_order_matches_lib() {
    let src = include_str!("../src/lib.rs");
    let needle = "const PROBE_ORDER: [u8; 5] = [";
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
    for cid in 0u8..=7 {
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
    for cid in 0u8..=7 {
        let bytes = genuine_proof_bytes(cid);
        for cut in [1usize, 2, 33, 5_000] {
            let short = &bytes[..bytes.len() - cut];
            assert!(!parses_as(short, cid), "C{cid}: parser accepted a proof {cut} bytes short");
        }
        assert!(CompactStarkProof::from_bytes(&bytes[..bytes.len() - 1]).is_none() || cid != 0);
    }
}

// ============================================================================
// 3. The 8×8 matrix, exact-length envelope
// ============================================================================

#[test]
fn cross_circuit_parse_matrix_exact_length() {
    let proofs = all_genuine();
    let mut m = [[false; 8]; 8];
    for n in 0..8usize {
        for k in 0..8usize {
            m[n][k] = parses_as(&proofs[n], k as u8);
        }
    }
    println!("{}", render_matrix("EXACT-LENGTH ENVELOPE", &m));

    for n in 0..8usize {
        assert!(m[n][n], "C{n} does not parse under its own config");
        for k in 0..8usize {
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
// 4. The 8×8 matrix under the envelope the client actually sends
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
    let mut m = [[false; 8]; 8];
    for n in 0..8usize {
        for k in 0..8usize {
            m[n][k] = parses_as(&padded[n], k as u8);
        }
    }
    println!("{}", render_matrix("UNIFORM 145,000-BYTE ENVELOPE", &m));

    for n in 0..8usize {
        for k in 0..8usize {
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
/// proof always carries exactly `config.num_queries`).
///
/// [SEAM RUN 2, honest caveat] This test still passes with that tightening
/// REVERTED, because tampering `num_queries` in place also changes the length
/// the parser then requires — so the rejection here is length-mediated for that
/// field, not value-mediated. The value check is isolated in
/// `a_wire_query_count_that_disagrees_with_the_config_does_not_parse`, which
/// re-lengths the buffer to match the count it declares and IS red under the
/// revert. Do not read this test as evidence that `num_queries` discriminates
/// circuits: `surplus_query_splices_do_not_parse_as_another_circuit` is green
/// under the revert, so it does not.
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

/// The pair the probe order was written to worry about, stated on its own: C1 is
/// probed FIRST, so a C3/C5/C6 proof that parsed as C1 would be mis-dispatched.
///
/// [SEAM RUN 2] This was called `parse_time_query_count_separates_c1_from_the_22_
/// query_circuits`, which claimed a mechanism it does not have. C1 wants 27
/// queries and C3/C5/C6 carry 22, so the parse-time count check LOOKS like the
/// thing keeping them apart — but reverting that check to `> 256` leaves this
/// test green. The count field never gets read, because the shifted offsets
/// break `num_fri_layers` or `fri_final_poly_size` first. Renamed to the property
/// rather than the guess.
#[test]
fn the_22_query_circuits_do_not_parse_as_c1_which_is_probed_first() {
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
    // 7 included: C7 is a shipping circuit and the legacy C0 parser must refuse
    // its proofs exactly as it refuses C1..C6's.
    for cid in 1u8..=7 {
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
    // 🚨 8, not 7. This loop and the `0..=7` one below were HALF updated when
    // circuit 7 landed: the known-id sweep was widened and the unknown-id sweep
    // was not, so the file asserted both that 7 has a config and that it has
    // none. `ci.yml` runs this target, so CI was red from `3be88558` — the
    // commit that taught the verifier circuit 7 — until 2026-08-25.
    for cid in 8u8..=u8::MAX {
        assert!(get_circuit_config(cid).is_none(), "circuit {cid} resolved to a config");
    }
    for cid in 0u8..=7 {
        assert!(get_circuit_config(cid).is_some(), "circuit {cid} lost its config");
    }
}

/// `get_boundary_assertions` is documented as failing closed and has a test for
/// 7/8/100/255. The OTHER dispatch arms were never swept. Every entry point that
/// takes a `circuit_id` must refuse an unknown one — including the sentinel —
/// rather than silently doing nothing.
///
/// [SEAM RUN 2] The killed agent's version of this test passed `[1, 2, 15]` as
/// the public inputs of a genuine C3 proof. Those are not C3's public inputs, so
/// every call died at step 1b with `OodConstraintFailed` — visible as five
/// `[verify] OOD z mismatch` lines in its own output — and the step-4 dispatch it
/// claimed to sweep was NEVER REACHED. It then asserted only that the error was
/// not `CircuitZeroIsLegacyOnly`, which any error satisfies. A hollow green of
/// exactly the class this repo keeps producing.
///
/// Fixed: the proof's OWN public inputs are used, so steps 0..3.5 (none of which
/// read `circuit_id`) genuinely pass and the unknown id arrives at the step-4
/// match. The assertion now names `UnsupportedCircuit`.
#[test]
fn every_circuit_id_dispatch_fails_closed_on_unknown_ids() {
    let c3 = common::prove3(&common::w3(0));
    let config3 = get_circuit_config(3).unwrap();
    let proof = GenericCompactProof::from_bytes(&c3.proof_bytes, config3).unwrap();
    let public_inputs = &c3.public_inputs;

    // Control: with these inputs and the honest id the proof verifies, which is
    // what makes the unknown-id calls below reach step 4 rather than dying early.
    p01_stark_verifier::verify::verify_generic(&proof, 3, public_inputs, config3)
        .expect("genuine C3 proof with its own public inputs must verify");

    // 7 is no longer in this list: it is a SHIPPING circuit now, so demanding
    // `UnsupportedCircuit` for it asserted the opposite of what the verifier is
    // supposed to do. It moves to its own assertion below rather than being
    // deleted, because "a C3 proof presented as circuit 7" is a real confusion
    // and dropping the id would have removed the coverage along with the red.
    for cid in [8u8, 100, 254, u8::MAX] {
        let err = p01_stark_verifier::verify::verify_generic(&proof, cid, public_inputs, config3)
            .unwrap_err();
        assert!(
            matches!(err, p01_stark_verifier::verify::VerifyError::UnsupportedCircuit),
            "circuit {cid} must be refused by the step-4 dispatch as UnsupportedCircuit, got \
             {err:?}. Anything else means the id was rejected somewhere earlier and this test \
             is not exercising the dispatch at all.",
        );
    }

    // A genuine C3 proof, presented as circuit 7, with C3's own public inputs.
    // C3 publishes three felts and C7 publishes six, so the arity guard is what
    // stands between the two — and it is named here rather than accepted as
    // "some error", because an arity guard that stopped firing would let a C3
    // proof reach C7's boundary fold with three of six public inputs unbound.
    let err = p01_stark_verifier::verify::verify_generic(&proof, 7, public_inputs, config3)
        .expect_err("a C3 proof must not verify as circuit 7");
    assert!(
        matches!(err, p01_stark_verifier::verify::VerifyError::PublicInputCountMismatch),
        "a C3 proof presented as circuit 7 was refused as {err:?}, not by the arity guard",
    );

    // Circuit 0 must fail closed at get_boundary_assertions' CALLERS too — but
    // 0 itself is a listed id there, so the refusal lives in verify_generic.
    assert!(matches!(
        p01_stark_verifier::verify::verify_generic(&proof, 0, public_inputs, config3),
        Err(p01_stark_verifier::verify::VerifyError::CircuitZeroIsLegacyOnly),
    ));
}

// ============================================================================
// 7. The wire layout, measured — and what truncation can and cannot buy
// ============================================================================

/// The byte layout `from_bytes` walks, derived from the CONFIG alone.
///
/// `header_len` is everything up to and including the 2-byte `num_queries`
/// field; `query_block` is the per-query block; the tail is
/// `num_queries * quotient_segments * 8`.
///
/// `query_block` is **not** written out from the wire spec — it is solved from
/// the measured proof length, and `layout` asserts the division is exact. That
/// makes this helper a measurement rather than a restatement of the parser, and
/// it is what lets `wire_layout_is_a_config_constant` claim an EXACT length.
struct Layout {
    header_len: usize,
    query_block: usize,
    num_queries: usize,
    k: usize,
}

fn layout(circuit_id: u8, proof_len: usize) -> Layout {
    let c = get_circuit_config(circuit_id).expect("0..=7 has a config");
    let k = c.quotient_segments;
    let nq = c.num_queries;
    let folds = (c.lde_size / c.fri_final_poly_size).trailing_zeros() as usize;
    let num_fri_layers = folds - 1;

    // trace_root | quotient_root | ood_current | ood_next | ood_z | ood_quotient
    // | num_fri_layers(1) | fri_layer_roots | fri_final_poly_size(2)
    // | fri_final_poly | grinding_nonce(8) | num_queries(2)
    let header_len = 32
        + 32
        + c.trace_width * 8
        + c.trace_width * 8
        + 8
        + k * 8
        + 1
        + num_fri_layers * 32
        + 2
        + c.fri_final_poly_size * 8
        + 8
        + 2;

    let body = proof_len
        .checked_sub(header_len + nq * k * 8)
        .unwrap_or_else(|| panic!("C{circuit_id}: proof shorter than header+tail"));
    assert_eq!(
        body % nq,
        0,
        "C{circuit_id}: {body} body bytes do not divide into {nq} query blocks — the wire \
         layout this helper assumes has drifted from the parser",
    );
    Layout { header_len, query_block: body / nq, num_queries: nq, k }
}

/// **MEASURED: the length `from_bytes` requires is a CONFIG CONSTANT, and it is
/// exactly the length the prover emits.**
///
/// This is the missing half of `parser_length_check_is_a_minimum_not_an_equality`.
/// That test shows the parser ignores a tail. This one shows the parser's
/// *required* length `R_k` depends on nothing an attacker supplies: every
/// variable-looking field (`num_fri_layers`, `fri_final_poly_size`,
/// `num_queries`) is pinned to the config before it can move the cursor's final
/// total. So `parses_as(bytes, k)` is monotone in `bytes.len()` with a single
/// threshold `R_k`, and `R_k` equals the genuine proof size.
///
/// The consequence is the one that matters for the probe: **truncation cannot
/// manufacture a cross-circuit parse.** A prefix of a C_n proof at any length
/// either falls short of `R_k` or presents the same bytes the full-length matrix
/// already rejected. `truncation_cannot_manufacture_a_cross_circuit_parse` shows
/// that by brute force; this test shows why.
#[test]
fn wire_layout_is_a_config_constant_equal_to_the_emitted_proof_size() {
    for cid in 0u8..=7 {
        let bytes = genuine_proof_bytes(cid);

        // [ADVERSARY 2026-08-03] CONTROL, and it is load-bearing rather than
        // decorative. Both assertions below pass VACUOUSLY when the parser
        // rejects the full-length proof: the bisection then finds no accepting
        // prefix at all, `lo` walks to `bytes.len()`, and `lo == bytes.len()`
        // holds for "R_k is exactly the proof size" and for "R_k does not
        // exist" alike. MEASURED: mutating `CONFIG_BALANCE_PROOF.merkle_depth`
        // from 11 to 12 makes C2 unparseable at every length and this test
        // stayed GREEN through it, while
        // `parser_length_check_is_a_minimum_not_an_equality` and
        // `wire_parity::every_wire_field_agrees_with_the_config_that_declares_it`
        // both went red. A test whose headline claim survives its subject
        // disappearing is not measuring the claim.
        assert!(
            parses_as(&bytes, cid),
            "C{cid}: the genuine full-length proof does not parse, so the bisection below \
             would measure nothing and pass. Fix the parse first."
        );

        let l = layout(cid, bytes.len());
        let reconstructed = l.header_len + l.num_queries * l.query_block + l.num_queries * l.k * 8;
        assert_eq!(reconstructed, bytes.len(), "C{cid}: layout arithmetic missed the length");

        // R_k by bisection on the prefix length. Monotone by the argument above;
        // the assertions below are what actually prove it here.
        let (mut lo, mut hi) = (0usize, bytes.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if parses_as(&bytes[..mid], cid) { hi = mid } else { lo = mid + 1 }
        }
        assert_eq!(
            lo,
            bytes.len(),
            "C{cid}: the parser accepts a {lo}-byte prefix of a {}-byte proof. The required \
             length is supposed to be the whole proof — a parser that is satisfied early is a \
             confusion oracle, because the bytes past {lo} are then free.",
            bytes.len(),
        );
    }
}

/// Brute force behind `wire_layout_is_a_config_constant…`: for EVERY ordered
/// pair and EVERY prefix length, no foreign parse exists.
///
/// This closes the one gap the 8×8 matrix leaves open. `proof_size` is chosen by
/// the CALLER at `init_proof_buffer_v2`, and `verify_uniform` slices exactly
/// `proof_size` bytes out of the account — so the attacker, not the prover,
/// picks the length the probe sees. Truncation is free. The matrix only tested
/// the full length and the 145,000-byte padding.
#[test]
fn truncation_cannot_manufacture_a_cross_circuit_parse() {
    let proofs = all_genuine();
    // [ADVERSARY] CONTROL. This test is entirely negative, so it is satisfied by
    // a parser that accepts NOTHING as well as by one that separates the
    // circuits correctly. The diagonal is asserted here so the sweep below is
    // known to be running against a parser that still parses.
    for (cid, bytes) in proofs.iter().enumerate() {
        assert!(
            parses_as(bytes, cid as u8),
            "C{cid}: genuine proof no longer parses as itself — every assertion below would \
             then pass for the wrong reason"
        );
    }
    // Every parse threshold in the set, so the sweep cannot step over one.
    let thresholds: Vec<usize> = proofs.iter().map(|p| p.len()).collect();

    for n in 0..8usize {
        for k in 0..8usize {
            if n == k {
                continue;
            }
            let src = &proofs[n];
            // Dense sweep near every threshold, coarse sweep everywhere else.
            let mut lens: Vec<usize> = (0..=src.len()).step_by(211).collect();
            for t in &thresholds {
                for d in 0..=8usize {
                    if *t >= d {
                        lens.push(t - d);
                    }
                    if t + d <= src.len() {
                        lens.push(t + d);
                    }
                }
            }
            lens.push(src.len());
            for len in lens {
                if len > src.len() {
                    continue;
                }
                assert!(
                    !parses_as(&src[..len], k as u8),
                    "CONFUSION BY TRUNCATION: the first {len} bytes of a genuine C{n} proof \
                     parse as C{k}. `proof_size` is caller-chosen, so this length is free to \
                     an attacker.",
                );
            }
        }
    }
}

// ============================================================================
// 8. THE QUERY-COUNT HOLE — the claim the killed agent left unverified
// ============================================================================

/// Splice a proof so it carries `extra` MORE queries than its config wants: bump
/// the wire count, append copies of query block 0, and append copies of query
/// 0's quotient-value felts so the tail still closes the length arithmetic.
///
/// **Everything duplicated is byte-identical to a genuine query.** Real position,
/// real trace rows, real Merkle paths, real FRI openings, real quotient segment
/// values. That is deliberate and it is what makes this an oracle rather than a
/// smoke test: nothing downstream of the count check can reject the surplus on
/// its CONTENTS, because its contents are honest. The count check is the only
/// thing standing in the way.
///
/// (The first version of this helper zero-filled the surplus quotient values.
/// It was useless: the constraint step rejected the zeros, so the test passed
/// with BOTH guards reverted and would have certified a hole as closed.)
fn with_surplus_queries(bytes: &[u8], circuit_id: u8, extra: usize) -> Vec<u8> {
    let l = layout(circuit_id, bytes.len());
    let nq = l.num_queries + extra;
    assert!(nq <= 256, "the old cap was 256; a test above it proves nothing about the old code");

    let mut out = Vec::with_capacity(bytes.len() + extra * (l.query_block + l.k * 8));
    out.extend_from_slice(&bytes[..l.header_len - 2]);
    out.extend_from_slice(&(nq as u16).to_le_bytes());

    let body_start = l.header_len;
    let body_end = body_start + l.num_queries * l.query_block;
    out.extend_from_slice(&bytes[body_start..body_end]);
    for _ in 0..extra {
        out.extend_from_slice(&bytes[body_start..body_start + l.query_block]);
    }

    // Quotient tail: `num_queries * k` felts, query-major. Duplicate query 0's
    // k felts for each surplus query, matching the duplicated query blocks.
    out.extend_from_slice(&bytes[body_end..body_end + l.num_queries * l.k * 8]);
    for _ in 0..extra {
        out.extend_from_slice(&bytes[body_end..body_end + l.k * 8]);
    }
    assert_eq!(
        out.len(),
        l.header_len + nq * l.query_block + nq * l.k * 8,
        "splice did not produce a well-formed {nq}-query buffer",
    );
    out
}

/// **THE DEFECT, verified.**
///
/// `verify_query_positions_legacy` gated on `proof.queries.len() < NUM_QUERIES`,
/// and the legacy parser bounded the wire count only by `> 256`. Together they
/// accepted a C0 proof carrying up to 256 queries where 27 are expected, and the
/// `i < expected.len()` guard in the comparison loop meant **every surplus
/// position went uncompared to the Fiat-Shamir-derived list** before entering the
/// per-query Merkle, FRI and constraint loops.
///
/// This is the exact hole B1 closed on the generic path (`verify_query_positions_
/// generic`, `<` → `!=`) while its own note said "the legacy path already gates
/// on the constant" — it did, with `<`, which is the same hole from the same
/// side. C0 is the sole verifier for `zk_shielded::{pause,resume,cancel}_private_
/// stark` and `p01_quantum_wallet`, so this was the widest-reach instance of it.
///
/// Both ends are closed now. This test goes RED if EITHER is reopened, which is
/// why it runs the whole pipeline and not just the parser:
///   * revert only the parser (`!= NUM_QUERIES` → `> 256`) and
///     `verify_query_positions_legacy` still refuses;
///   * revert only `verify_query_positions_legacy` (`!=` → `<`) and the parser
///     still refuses;
///   * revert both and a 28-query C0 proof VERIFIES.
#[test]
fn legacy_c0_pipeline_refuses_surplus_queries() {
    let c0 = common::prove0(&common::w0(0));
    let commitment = p01_stark_verifier::goldilocks::Felt::new(c0.commitment);

    // Control: the honest 27-query proof still verifies end to end. Without this
    // the test below could pass because the splice broke something unrelated.
    let honest = CompactStarkProof::from_bytes(&c0.proof_bytes).expect("genuine C0 must parse");
    assert_eq!(honest.queries.len(), 27, "C0 carries 27 queries");
    p01_stark_verifier::verify::verify_subscriber_ownership(&honest, commitment)
        .expect("honest C0 proof must verify");

    for extra in [1usize, 5, 229] {
        let spliced = with_surplus_queries(&c0.proof_bytes, 0, extra);
        let n = 27 + extra;
        match CompactStarkProof::from_bytes(&spliced) {
            None => println!("C0 +{extra}: refused at the PARSER"),
            Some(p) => {
                assert_eq!(p.queries.len(), n, "splice built the buffer it claimed to");
                let r = p01_stark_verifier::verify::verify_subscriber_ownership(&p, commitment);
                println!("C0 +{extra}: parsed {n} queries, verify -> {r:?}");
                assert!(
                    r.is_err(),
                    "C0 ACCEPTED a proof carrying {n} queries where 27 are expected. The \
                     surplus {extra} positions were never compared to the derived list. C0 is \
                     the sole verifier for four shipped instructions.",
                );
            }
        }
    }
}

/// The generic twin, on the two circuits `verify_uniform` probes first. B1 closed
/// `verify_query_positions_generic`; the parser now refuses the count as well, so
/// this pins both ends here too.
#[test]
fn generic_pipeline_refuses_surplus_queries() {
    for cid in [1u8, 3] {
        let (bytes, pubs) = match cid {
            1 => {
                let d = common::prove1(&common::w1(0));
                (d.proof_bytes, d.public_inputs)
            }
            _ => {
                let d = common::prove3(&common::w3(0));
                (d.proof_bytes, d.public_inputs)
            }
        };
        let config = get_circuit_config(cid).unwrap();

        let honest = GenericCompactProof::from_bytes(&bytes, config).expect("genuine must parse");
        p01_stark_verifier::verify::verify_generic(&honest, cid, &pubs, config)
            .unwrap_or_else(|e| panic!("honest C{cid} proof must verify: {e:?}"));

        for extra in [1usize, 7] {
            let spliced = with_surplus_queries(&bytes, cid, extra);
            let n = config.num_queries + extra;
            match GenericCompactProof::from_bytes(&spliced, config) {
                None => println!("C{cid} +{extra}: refused at the PARSER"),
                Some(p) => {
                    assert_eq!(p.queries.len(), n);
                    let r = p01_stark_verifier::verify::verify_generic(&p, cid, &pubs, config);
                    println!("C{cid} +{extra}: parsed {n} queries, verify -> {r:?}");
                    assert!(
                        r.is_err(),
                        "C{cid} ACCEPTED a proof carrying {n} queries where {} are expected",
                        config.num_queries,
                    );
                }
            }
        }
    }
}

/// A surplus-query buffer must not become a CROSS-CIRCUIT confusion.
///
/// Re-counting is the one lever an attacker has over the wire that MOVES THE
/// LENGTH without touching a single committed byte: bump `num_queries`, append
/// duplicate blocks, and the buffer grows by a chosen multiple of the query
/// block. Under the pre-seam parser (`num_queries > 256`) a C_n buffer could be
/// re-counted to whatever length was wanted, and length is the only thing that
/// varies freely between configs. This sweeps every ordered pair for the
/// resulting parse.
///
/// Split from the self-pair check below on purpose: `n == k` is a query-count
/// question, `n != k` is the confusion question, and running them in one loop
/// meant the first self-pair failure masked every cross-pair result.
#[test]
fn surplus_query_splices_do_not_parse_as_another_circuit() {
    let mut hits = Vec::new();
    for n in 0u8..=7 {
        let bytes = genuine_proof_bytes(n);
        for extra in [1usize, 5, 17, 100] {
            let spliced = with_surplus_queries(&bytes, n, extra);
            // Only some splices still fit the client's 145,000-byte envelope;
            // the ones that do not could never be uploaded through
            // `padProofToUniform` anyway, so the exact-length case is the whole
            // question for those.
            let padded = (spliced.len() <= UNIFORM_PROOF_SIZE).then(|| pad_uniform(&spliced));
            for k in 0u8..=7 {
                if k == n {
                    continue;
                }
                if parses_as(&spliced, k) {
                    hits.push(format!("C{n}+{extra} parses as C{k} (exact length)"));
                }
                if let Some(p) = &padded {
                    if parses_as(p, k) {
                        hits.push(format!("C{n}+{extra} parses as C{k} (padded envelope)"));
                    }
                }
            }
        }
    }
    assert!(hits.is_empty(), "CONFUSION BY RE-COUNTING:\n  {}", hits.join("\n  "));
}

/// …and the self-pair: a buffer whose wire count disagrees with its own config
/// must not parse either. This is the parse-time `num_queries != config.num_
/// queries` check, stated as the property it buys.
///
/// MEASURED: reverting that check to the pre-seam `num_queries > 256` turns this
/// test red on the very first case (`C0+1 parses as C0`) while the 8×8 matrices
/// stay diagonal — so the tightening is NOT what keeps genuine proofs apart, and
/// the savepoint comment that called it "a third independent exact-value field"
/// the probe rests on was overclaiming. What it actually buys is this: a
/// re-counted buffer is refused at the parser instead of `Vec::with_capacity`-ing
/// an attacker-chosen 256 and walking 256 query blocks before
/// `verify_query_positions_*` says no.
#[test]
fn a_wire_query_count_that_disagrees_with_the_config_does_not_parse() {
    for n in 0u8..=7 {
        let bytes = genuine_proof_bytes(n);
        for extra in [1usize, 5, 17, 100] {
            let spliced = with_surplus_queries(&bytes, n, extra);
            assert!(
                !parses_as(&spliced, n),
                "C{n}: a buffer declaring {} queries parses under C{n}'s own config, which \
                 wants {}. The count is read from the WIRE; nothing downstream of the parser \
                 should have to be the first line of defence.",
                get_circuit_config(n).unwrap().num_queries + extra,
                get_circuit_config(n).unwrap().num_queries,
            );
            if spliced.len() <= UNIFORM_PROOF_SIZE {
                assert!(!parses_as(&pad_uniform(&spliced), n), "C{n}: …under the padded envelope");
            }
        }
    }
}
