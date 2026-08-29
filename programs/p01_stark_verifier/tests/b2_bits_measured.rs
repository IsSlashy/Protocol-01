//! [B2-M] What quotient segmentation bought, MEASURED here and SUBTRACTED here.
//!
//! # Why this file exists at all
//!
//! B2 was specified, implemented and re-pinned without anything in the tree ever
//! computing its own gain. The post-B2 arrays landed in `b1_deep_binding.rs` and
//! the pre-B2 array was DELETED in the same wave:
//!
//! ```text
//! $ git grep -n B1_RESIDUAL_FORGERY_BITS 0235c624   # the base B2 was built on
//! 0235c624:programs/p01_stark_verifier/tests/b1_deep_binding.rs:335:
//!     const B1_RESIDUAL_FORGERY_BITS: [u32; 7] = [43, 43, 43, 38, 43, 38, 38];
//! $ git grep -n FORGERY_BITS 6de57685             # the B2 head
//!     (only B2_CONJECTURED_FORGERY_BITS / B2_UNCONDITIONAL_FORGERY_BITS)
//! ```
//!
//! So the one number the change was made for survived only in a commit message,
//! and "B2 bought N bits" was, in this tree, unfalsifiable. This file restores the
//! subtrahend, derives BOTH ends independently of the shipped derivation, and
//! asserts the difference.
//!
//! # What is MEASURED here and what is merely DERIVED
//!
//! MEASURED — a command produces it, on real proof bytes, on all seven circuits:
//!
//! * the FRI rate `rho`, as the agreement count of the best-known adversarial
//!   terminal play against the terminal layer the adversary actually committed to
//!   (`the_per_query_rate_is_measured_on_all_seven_circuits`). This is the same
//!   method that produced the 1.000 bits/query figure for B1 — `T5` in
//!   `b1_deep_binding.rs` — but re-implemented here from proof bytes and field
//!   arithmetic only, sharing no helper with it, and run on SEVEN circuits where
//!   the shipped version runs on two;
//! * that the terminal check is not vacuous: the published interpolant of a forged
//!   fold really does leave the code;
//! * that a query's terminal index is `pos mod fri_final_poly_size` and that those
//!   indices are spread over the whole terminal domain
//!   (`terminal_query_indices_cover_the_whole_terminal_domain`). Nothing in the
//!   tree measured this, and every bits-per-query figure the project has ever
//!   published assumes it: if the terminal index were constant, the agreement set
//!   would be hit every time and the rate would be worth ZERO bits.
//!
//! DERIVED — arithmetic on measured or shipped inputs, and labelled as such:
//!
//! * the two soundness columns at B2, from `CircuitConfig` + the shipped
//!   `GRINDING_BITS`, by a second implementation that does not share code with
//!   `soundness_bits_are_derived_from_the_config`;
//! * the two columns at B1, from constants transcribed out of git at `0235c624`;
//! * the difference.
//!
//! # The answer, MEASURED + DERIVED, printed by the tests below
//!
//! ```text
//!  id | B1 conj | B2 conj | gain | B1 uncond | B2 uncond | gain
//!  C0 |      48 |      52 |   +4 |        28 |        46 |  +18
//!  C1 |      43 |      50 |   +7 |        27 |        46 |  +19
//!  C2 |      43 |      50 |   +7 |        27 |        46 |  +19
//!  C3 |      38 |      47 |   +9 |        25 |        42 |  +17
//!  C4 |      43 |      48 |   +5 |        27 |        46 |  +19
//!  C5 |      38 |      47 |   +9 |        25 |        42 |  +17
//!  C6 |      38 |      47 |   +9 |        25 |        42 |  +17
//! ```
//!
//! The per-query rate went from 1.000 to 4.000 bits and the query term gained 72
//! to 87 bits — and the ANSWER gained 4 to 9, because the base-field Fiat-Shamir
//! floor absorbed the rest. That gap is the headline, and it is asserted below
//! rather than described: pre-B2 the conjectured column was QUERY-bound on every
//! circuit; post-B2 it is FLOOR-bound on every circuit. B2 did not buy a security
//! level, it bought headroom that only an extension field can spend.
//!
//! # The C0 discrepancy in the pinned number
//!
//! The project's published pre-B2 array was `[43, 43, 43, 38, 43, 38, 38]`, from a
//! gate that asserted `bits == num_queries + grinding` — 1.000 bits per query on
//! all seven. C0's terminal bound was 7 of 16, not 8 of 16, so a C0 query was
//! worth `log2(16/7) = 1.193` bits and its true B1 figure was 48. The pin was
//! CONSERVATIVE on C0 by 5 bits. `B1_PINNED_FORGERY_BITS` keeps the published
//! number and reports its own delta column, so the correction is visible instead
//! of retconned.

use p01_stark::compact::{OodForgery, TerminalPoly};
use p01_stark_verifier::compact_proof::{
    get_circuit_config, CompactStarkProof, GenericCompactProof, CircuitConfig, GRINDING_BITS,
};
use p01_stark_verifier::goldilocks::{Felt, MODULUS};

// ============================================================================
// Local field / wire helpers. Deliberately NOT shared with b1_deep_binding.rs:
// two implementations that disagree is the outcome this file is built to catch.
// ============================================================================

/// Header: `trace_root 32 | quotient_root 32 | ood_current 8w | ood_next 8w |
/// ood_z 8 | ood_quotient 8k | num_fri_layers 1 | roots 32L | fps u16 | poly`.
///
/// Same layout on the legacy C0 parser and the generic one.
fn read_terminal_coeffs(bytes: &[u8], w: usize, k: usize) -> Vec<Felt> {
    let mut c = 32 + 32 + w * 8 * 2 + 8 + k * 8;
    let num_layers = bytes[c] as usize;
    c += 1 + num_layers * 32;
    let fps = u16::from_le_bytes([bytes[c], bytes[c + 1]]) as usize;
    c += 2;
    (0..fps)
        .map(|i| {
            let v = u64::from_le_bytes(bytes[c + i * 8..c + i * 8 + 8].try_into().unwrap());
            assert!(v < MODULUS, "terminal coefficient {i} is not canonical");
            Felt::new(v)
        })
        .collect()
}

fn horner(coeffs: &[Felt], x: Felt) -> Felt {
    let mut acc = Felt::ZERO;
    for &c in coeffs.iter().rev() {
        acc = acc.mul(x).add(c);
    }
    acc
}

/// A generator of the ORDER-`n` multiplicative subgroup of Goldilocks, found by
/// search rather than read out of the verifier's tables.
///
/// The agreement COUNT is invariant under which generator is used — a different
/// generator relabels the same `n` points — so this does not have to be the
/// verifier's `gen_final`, and deliberately is not.
fn subgroup_generator(n: u64) -> Felt {
    assert!(n.is_power_of_two() && n > 1);
    let exp = (MODULUS - 1) / n;
    for base in 2u64..200 {
        let g = Felt::new(base).exp(exp);
        if g.exp(n) == Felt::ONE && g.exp(n / 2) != Felt::ONE {
            return g;
        }
    }
    panic!("no element of order {n} found");
}

/// The adversary's best-known terminal play: reduce the true interpolant `c`
/// modulo `x^k - 1`, with `k` the largest power of two at most the degree bound.
///
/// At bound 8 (pre-B2) this is literally `p_m = c_m + c_{m+8}` and agrees on the
/// 8 even indices. At bound 1 (post-B2) it is the constant `SUM_m c_m = c(1)` and
/// agrees at index 0 alone. Either way the published polynomial is inside the
/// bound, so the degree check cannot be what rejects it and all the soundness is
/// in the terminal comparison — which is the point.
fn best_alias(c: &[Felt], bound: usize) -> Vec<Felt> {
    let fps = c.len();
    let mut k = 1usize;
    while k * 2 <= bound {
        k *= 2;
    }
    assert!(fps % k == 0, "k={k} must divide fps={fps}");
    let mut p = vec![Felt::ZERO; fps];
    for (m, slot) in p.iter_mut().enumerate().take(k) {
        let mut acc = Felt::ZERO;
        let mut t = m;
        while t < fps {
            acc = acc.add(c[t]);
            t += k;
        }
        *slot = acc;
    }
    p
}

/// A coordinated OOD forgery on circuit `id`, with the HONEST terminal poly, i.e.
/// the true interpolant of the forger's own folded `D`. That is the word he is
/// committed to; `best_alias` is the closest thing to it he is ALLOWED to publish.
fn forged_proof_bytes(id: u8) -> Vec<u8> {
    let f = OodForgery::Coordinated { col: 0, delta: 1 };
    let t = TerminalPoly::Honest;
    match id {
        0 => p01_stark::compact::generate_compact_proof_with_forgery(42, f, t).proof_bytes,
        1 => p01_stark::compact::generate_pool_commitment_proof_with_forgery(111, 222, 333, 444, f, t)
            .proof_bytes,
        2 => p01_stark::compact::generate_balance_compact_proof_with_forgery(42, 1000, 777, 999, f, t)
            .proof_bytes,
        3 => {
            let pe: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
            let pi: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
            p01_stark::compact::generate_merkle_path_compact_proof_with_forgery(777, &pe, &pi, f, t)
                .proof_bytes
        }
        4 => p01_stark::compact::generate_confidential_balance_compact_proof_with_forgery(
            42, 1000, 111, 800, 222, 200, 333, 999, f, t,
        )
        .proof_bytes,
        5 => p01_stark::compact::generate_transfer_compact_proof_with_forgery(
            13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50, f, t,
        )
        .proof_bytes,
        6 => {
            let pe: Vec<u64> = (0..12).map(|i| 100u64 + i * 13).collect();
            let pi: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();
            p01_stark::compact::generate_merkle_update_compact_proof_with_forgery(
                111, 222, &pe, &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len()), f, t)
            .proof_bytes
        }
        _ => unreachable!(),
    }
}

/// Query positions of an HONEST proof on circuit `id`, seeded by `s`.
fn honest_query_positions(id: u8, s: u64) -> Vec<u32> {
    match id {
        0 => {
            let d = p01_stark::compact::generate_compact_proof(s);
            let p = CompactStarkProof::from_bytes(&d.proof_bytes).expect("C0 parses");
            p.queries.iter().map(|q| q.position).collect()
        }
        _ => {
            let d = match id {
                1 => p01_stark::compact::generate_pool_commitment_proof(s, s + 1, s + 2, s + 3),
                2 => p01_stark::compact::generate_balance_compact_proof(s, 1000 + s, 777, 999 + s),
                3 => {
                    let pe: Vec<u64> = (0..15u64).map(|i| 1000 + i + s).collect();
                    let pi: Vec<u8> = (0..15u8).map(|i| ((i as u64 + s) % 2) as u8).collect();
                    p01_stark::compact::generate_merkle_path_compact_proof(777 + s, &pe, &pi)
                }
                4 => p01_stark::compact::generate_confidential_balance_compact_proof(
                    42 + s,
                    1000,
                    111 + s,
                    800,
                    222,
                    200,
                    333 + s,
                    999,
                ),
                5 => p01_stark::compact::generate_transfer_compact_proof(
                    13 + s,
                    500,
                    77,
                    400,
                    88,
                    100,
                    150,
                    1234 + s,
                    555,
                    65,
                    2222,
                    333,
                    50,
                ),
                6 => {
                    let pe: Vec<u64> = (0..12).map(|i| 100u64 + i * 13 + s).collect();
                    let pi: Vec<u8> = (0..12).map(|i| ((i as u64 + s) % 2) as u8).collect();
                    p01_stark::compact::generate_merkle_update_compact_proof(111 + s, 222, &pe, &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len()))
                }
                _ => unreachable!(),
            };
            let cfg = get_circuit_config(id).unwrap();
            let p = GenericCompactProof::from_bytes(&d.proof_bytes, cfg).expect("generic parses");
            p.queries.iter().map(|q| q.position).collect()
        }
    }
}

// ============================================================================
// MEASUREMENT 1 — the per-query rate, on all seven circuits.
// ============================================================================

/// The number every bits figure in this repo is built on, measured seven times.
///
/// For each circuit: build the coordinated forgery, take the terminal interpolant
/// it actually published, check it is OUTSIDE the code (else there is nothing to
/// measure), reduce it to the best in-bound alias, and count how many of the
/// `fri_final_poly_size` terminal points the two agree at. That count IS the
/// per-query pass probability of the attack, and `-log2(agree / fps)` IS the
/// bits-per-query figure.
///
/// MEASURED, this run: `1 of 16` on all seven, i.e. **4.000 bits per query**.
/// PRE-B2 the same construction gave `8 of 16` on the generic circuits and `4 of
/// 16` on legacy C0, i.e. 1.000 and 2.000 bits — see `T5` / `T5b`.
///
/// The upper assertion is the one that matters: `agree > bound` would mean the
/// bound over-states the rate and every bits figure in the tree is an over-claim.
/// The lower assertion (`agree == bound`, not `<=`) is what keeps this a
/// MEASUREMENT: an alias that agreed at fewer points would be a weaker adversary
/// than the code allows, and quoting the resulting rate would be luck, not a bound.
#[test]
fn the_per_query_rate_is_measured_on_all_seven_circuits() {
    let mut rates = Vec::new();
    for id in 0u8..=6 {
        let cfg: &CircuitConfig = get_circuit_config(id).unwrap();
        let bytes = forged_proof_bytes(id);
        let c = read_terminal_coeffs(&bytes, cfg.trace_width, cfg.quotient_segments);
        let fps = c.len();
        assert_eq!(
            fps, cfg.fri_final_poly_size,
            "C{id}: wire fps {fps} disagrees with the config",
        );

        let bound = cfg.fri_final_poly_degree_bound;
        assert!(
            c[bound..].iter().any(|&v| v != Felt::ZERO),
            "C{id}: the forged terminal interpolant is INSIDE the degree bound, so this \
             measurement is vacuous — the adversary would not have to alias anything",
        );

        let p = best_alias(&c, bound);
        let g = subgroup_generator(fps as u64);
        let mut agree = Vec::new();
        for j in 0..fps {
            let x = g.exp(j as u64);
            if horner(&c, x) == horner(&p, x) {
                agree.push(j);
            }
        }

        let bits = (fps as f64 / agree.len() as f64).log2();
        println!(
            "[B2-M rate] C{id}: bound {bound} of {fps} -> agreement {} of {fps} at {agree:?} \
             -> {bits:.3} bits/query",
            agree.len(),
        );

        assert_eq!(
            agree.len(),
            bound,
            "C{id}: an in-bound alias must agree at EXACTLY {bound} of {fps} terminal points. \
             More means the FRI rate is worse than `fri_final_poly_degree_bound / \
             fri_final_poly_size` says and every bits figure in this tree over-claims; \
             fewer means the shipped adversary is weaker than the code permits and the \
             rate is not measured, only observed.",
        );
        rates.push(bits);
    }

    for (id, &b) in rates.iter().enumerate() {
        assert!(
            (b - 4.0).abs() < 1e-12,
            "C{id} measured {b} bits/query; the tree's soundness arrays are derived at 4.000. \
             If the segmentation changed, re-derive BOTH columns before touching any comment.",
        );
    }
}

// ============================================================================
// MEASUREMENT 2 — the assumption underneath every bits figure ever published here.
// ============================================================================

/// A query's terminal index is `pos mod fri_final_poly_size`, and those indices
/// land all over the terminal domain.
///
/// `verify_fri_generic` folds with `j = pos & (half_i - 1)`; at the last layer
/// `half_i == fri_final_poly_size`, so the terminal comparison a query performs is
/// selected by `pos mod fps` and by nothing else. Every bits-per-query figure this
/// project has published — 1.000, 4.000, and the 124 that was never true — assumes
/// that index is spread over the domain. If it were constant, the agreement set
/// would be hit by every query and the rate would be worth ZERO bits. Nothing in
/// the tree measured it until this test.
///
/// Also MEASURED here: `derive_positions_from_seed` rejects duplicates
/// (`if !positions.contains(&pos)`), so the `num_queries` positions in a proof are
/// distinct and the query term is not silently discounted by birthday collisions —
/// which on C0 (27 draws from an LDE of 512) would otherwise cost ~0.7 queries.
#[test]
fn terminal_query_indices_cover_the_whole_terminal_domain() {
    const PROOFS_PER_CIRCUIT: u64 = 8;
    for id in 0u8..=6 {
        let cfg = get_circuit_config(id).unwrap();
        let fps = cfg.fri_final_poly_size;
        let mut hist = vec![0usize; fps];
        let mut total = 0usize;
        for s in 0..PROOFS_PER_CIRCUIT {
            let positions = honest_query_positions(id, 40 + s * 7);
            assert_eq!(
                positions.len(),
                cfg.num_queries,
                "C{id}: proof carries {} positions, config says {}",
                positions.len(),
                cfg.num_queries,
            );
            let mut sorted = positions.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(
                sorted.len(),
                positions.len(),
                "C{id}: duplicate query positions — the query term is not \
                 num_queries * bits/query if the same position is drawn twice",
            );
            for p in positions {
                assert!((p as usize) < cfg.lde_size, "C{id}: position out of domain");
                hist[(p as usize) & (fps - 1)] += 1;
                total += 1;
            }
        }
        let lo = *hist.iter().min().unwrap();
        let hi = *hist.iter().max().unwrap();
        println!(
            "[B2-M index] C{id}: {total} queries over {PROOFS_PER_CIRCUIT} proofs, \
             fps {fps}, min/expected/max per index = {lo}/{}/{hi} -> {hist:?}",
            total / fps,
        );
        assert!(
            lo >= 1,
            "C{id}: terminal index histogram has an EMPTY bucket ({hist:?}). The agreement \
             set of the aliased terminal play is one index; if queries never reach some \
             indices, `bits/query = log2(fps / agreement)` over-states the rate.",
        );
        // Deliberately loose: proof generation is deterministic, so this is a fixed
        // observation and not a random draw, but a tight pin would break on any
        // unrelated transcript change. What must never happen is concentration.
        assert!(
            hi * fps <= total * 3,
            "C{id}: terminal indices are concentrated ({hist:?}); one index holds more than \
             3x its share of {total} queries. Re-derive the per-query rate before quoting it.",
        );
    }
}

// ============================================================================
// The two soundness columns, derived twice.
// ============================================================================

/// The shipped post-B2 columns, transcribed from `b1_deep_binding.rs`.
/// `the_two_files_agree_on_the_post_b2_columns` ties these to that file's text.
const B2_CONJECTURED: [u32; 7] = [52, 50, 50, 47, 48, 47, 47];
const B2_UNCONDITIONAL: [u32; 7] = [46, 46, 46, 42, 46, 42, 42];

/// The B1-era columns, derived from constants transcribed out of git at
/// `0235c624` (the commit B2 was built on):
///
/// ```text
/// compact_proof.rs:234  pub const GRINDING_BITS: u32 = 16;
/// compact_proof.rs:251  pub const LEGACY_FRI_FINAL_POLY_DEGREE_BOUND: usize = 7;
/// compact_proof.rs:72   C0 fri_final_poly_degree_bound: 7
/// compact_proof.rs:85/98/119/132/165/193  C1..C6 fri_final_poly_degree_bound: 8
/// ```
///
/// with `quotient_segments` absent (the composition was committed as ONE column,
/// so `k = 1`) and every other field identical to today's.
const PRE_B2_CONJECTURED: [u32; 7] = [48, 43, 43, 38, 43, 38, 38];
const PRE_B2_UNCONDITIONAL: [u32; 7] = [28, 27, 27, 25, 27, 25, 25];

/// What the project actually PUBLISHED before B2, from the deleted
/// `B1_RESIDUAL_FORGERY_BITS`. Kept separate from `PRE_B2_CONJECTURED` because it
/// is not the same quantity: it applied 1.000 bits/query to all seven circuits,
/// which is 5 bits conservative on C0 (bound 7 of 16, not 8 of 16).
const B1_PINNED_FORGERY_BITS: [u32; 7] = [43, 43, 43, 38, 43, 38, 38];

const PRE_B2_GRINDING_BITS: u32 = 16;
const PRE_B2_TERMINAL_BOUND: [usize; 7] = [7, 8, 8, 8, 8, 8, 8];
const PRE_B2_QUOTIENT_SEGMENTS: usize = 1;

struct Columns {
    conjectured: u32,
    unconditional: u32,
    query_conjectured: f64,
    query_unconditional: f64,
    field_floor: f64,
}

/// A SECOND implementation of the shipped derivation, written from the definitions
/// rather than copied, so that one implementation cannot be wrong and agree with
/// itself.
///
/// * conjectured  — ethSTARK Conjecture 8.4, list decoding to capacity.
/// * unconditional — unique decoding; a theorem, no conjecture.
/// * field_floor  — every Fiat-Shamir challenge in this construction is ONE base
///   field Goldilocks element, so the adversary's total number of independent
///   re-rolls caps the whole thing at `64 - log2(#draws)`.
#[allow(clippy::too_many_arguments)]
fn columns(
    bound: usize,
    fps: usize,
    num_queries: usize,
    trace_length: usize,
    trace_width: usize,
    quotient_segments: usize,
    lde_size: usize,
    grinding: u32,
) -> Columns {
    assert!(bound >= 1 && bound < fps, "vacuous or degenerate terminal bound");
    let rho = bound as f64 / fps as f64;
    let num_folds = (lde_size / fps).trailing_zeros() as usize;
    let draws = 8.0 * trace_length as f64
        + (trace_width + quotient_segments + 1) as f64
        + (num_folds * lde_size) as f64;
    let field_floor = 64.0 - draws.log2();
    let nq = num_queries as f64;
    let g = grinding as f64;
    let query_conjectured = nq * (1.0 / rho).log2() + g;
    let query_unconditional = nq * (2.0 / (1.0 + rho)).log2() + g;
    Columns {
        conjectured: query_conjectured.min(field_floor).floor() as u32,
        unconditional: query_unconditional.min(field_floor).floor() as u32,
        query_conjectured,
        query_unconditional,
        field_floor,
    }
}

fn b2_columns(id: u8) -> Columns {
    let c = get_circuit_config(id).unwrap();
    columns(
        c.fri_final_poly_degree_bound,
        c.fri_final_poly_size,
        c.num_queries,
        c.trace_length,
        c.trace_width,
        c.quotient_segments,
        c.lde_size,
        GRINDING_BITS,
    )
}

/// B1 reuses every LIVE field except the three B2 moved, so a future change to
/// `num_queries` or `trace_length` cannot make the subtraction compare two
/// different circuits.
fn b1_columns(id: u8) -> Columns {
    let c = get_circuit_config(id).unwrap();
    columns(
        PRE_B2_TERMINAL_BOUND[id as usize],
        c.fri_final_poly_size,
        c.num_queries,
        c.trace_length,
        c.trace_width,
        PRE_B2_QUOTIENT_SEGMENTS,
        c.lde_size,
        PRE_B2_GRINDING_BITS,
    )
}

// ============================================================================
// MEASUREMENT 3 — the subtraction.
// ============================================================================

/// What B2 bought, as a difference this suite computes rather than a sentence a
/// commit message asserts.
#[test]
fn what_b2_bought_in_bits_is_a_subtraction_that_runs() {
    println!(
        " id | B1 conj | B2 conj | gain | B1 uncond | B2 uncond | gain | B1 PIN | gain vs PIN"
    );
    for id in 0u8..=6 {
        let b1 = b1_columns(id);
        let b2 = b2_columns(id);

        assert_eq!(
            b1.conjectured, PRE_B2_CONJECTURED[id as usize],
            "C{id}: the B1-era conjectured column no longer re-derives from the constants \
             transcribed out of 0235c624",
        );
        assert_eq!(
            b1.unconditional, PRE_B2_UNCONDITIONAL[id as usize],
            "C{id}: the B1-era unconditional column no longer re-derives",
        );
        assert_eq!(
            b2.conjectured, B2_CONJECTURED[id as usize],
            "C{id}: this file's independent derivation disagrees with the shipped \
             B2_CONJECTURED_FORGERY_BITS. One of the two derivations is wrong.",
        );
        assert_eq!(
            b2.unconditional, B2_UNCONDITIONAL[id as usize],
            "C{id}: this file's independent derivation disagrees with the shipped \
             B2_UNCONDITIONAL_FORGERY_BITS",
        );

        let gain_conj = b2.conjectured as i64 - b1.conjectured as i64;
        let gain_uncond = b2.unconditional as i64 - b1.unconditional as i64;
        let gain_vs_pin = b2.conjectured as i64 - B1_PINNED_FORGERY_BITS[id as usize] as i64;
        println!(
            " C{id} | {:7} | {:7} | {:+4} | {:9} | {:9} | {:+4} | {:6} | {:+11}",
            b1.conjectured,
            b2.conjectured,
            gain_conj,
            b1.unconditional,
            b2.unconditional,
            gain_uncond,
            B1_PINNED_FORGERY_BITS[id as usize],
            gain_vs_pin,
        );

        assert!(gain_conj > 0 && gain_uncond > 0, "C{id}: B2 must not have LOST bits");

        // The headline. The query term gained 72-87 bits; the answer gained 4-9.
        let query_gain = b2.query_conjectured - b1.query_conjectured;
        assert!(
            (gain_conj as f64) < query_gain,
            "C{id}: the conjectured gain ({gain_conj}) is no longer strictly smaller than the \
             query-term gain ({query_gain:.1}). That gap IS the base-field floor. If it \
             closed, the floor stopped binding and the commentary in b1_deep_binding.rs and \
             in this file describes a regime that no longer exists.",
        );
    }
}

/// The structural statement, asserted: B2 moved the conjectured column from
/// QUERY-bound to FLOOR-bound.
///
/// Pre-B2 the query term was 38-48 bits against a floor of 47.8-52.5, so adding
/// queries or grinding raised the answer. Post-B2 the query term is 110-130
/// against the same floor, so neither does. That is why "B2 bought 87 bits" is
/// true of the query term and false of the security level, and why the next
/// change has to be the extension field and not more queries.
#[test]
fn b2_moved_the_conjectured_column_from_query_bound_to_floor_bound() {
    for id in 0u8..=6 {
        let b1 = b1_columns(id);
        let b2 = b2_columns(id);
        println!(
            "[B2-M bound] C{id}: B1 query {:.2} vs floor {:.2} | B2 query {:.2} vs floor {:.2}",
            b1.query_conjectured, b1.field_floor, b2.query_conjectured, b2.field_floor,
        );
        assert!(
            b1.query_conjectured < b1.field_floor,
            "C{id}: the B1-era conjectured column was NOT query-bound; the 'B2 bought \
             headroom the field ate' story does not describe this circuit",
        );
        assert!(
            b2.query_conjectured > b2.field_floor,
            "C{id}: the post-B2 conjectured column is no longer floor-bound",
        );
    }
}

/// The dual, and the reason "add more queries" is not a dead end.
///
/// The UNCONDITIONAL column is query-bound at both ends, so unlike the
/// conjectured one it still responds to `num_queries`. MEASURED headroom is
/// printed: the smallest `num_queries` at which each circuit's unconditional
/// column would reach its floor. Anything past that needs the extension field.
#[test]
fn the_unconditional_column_is_query_bound_at_both_ends() {
    for id in 0u8..=6 {
        let c = get_circuit_config(id).unwrap();
        let b1 = b1_columns(id);
        let b2 = b2_columns(id);
        assert!(
            b1.query_unconditional < b1.field_floor && b2.query_unconditional < b2.field_floor,
            "C{id}: the unconditional column stopped being query-bound; its gain is no longer \
             a statement about the number of queries",
        );
        let mut saturating_nq = c.num_queries;
        loop {
            let t = columns(
                c.fri_final_poly_degree_bound,
                c.fri_final_poly_size,
                saturating_nq,
                c.trace_length,
                c.trace_width,
                c.quotient_segments,
                c.lde_size,
                GRINDING_BITS,
            );
            if t.query_unconditional >= t.field_floor {
                break;
            }
            saturating_nq += 1;
            assert!(saturating_nq < 4096, "runaway");
        }
        println!(
            "[B2-M nq] C{id}: ships {} queries; the unconditional column saturates its floor \
             at {saturating_nq} ({:.2} -> {:.2} bits, no wire change)",
            c.num_queries, b2.unconditional as f64, b2.field_floor,
        );
        assert!(
            saturating_nq > c.num_queries,
            "C{id}: already saturated — re-derive before quoting query headroom",
        );
    }
}

// ============================================================================
// Cross-file ties. Two files, one set of numbers.
// ============================================================================

const B1_DEEP_BINDING_SRC: &str = include_str!("b1_deep_binding.rs");
const SELF_SRC: &str = include_str!("b2_bits_measured.rs");

fn fmt(a: &[u32; 7]) -> String {
    format!(
        "[{}]",
        a.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(", ")
    )
}

/// This file's arrays and `b1_deep_binding.rs`'s arrays are the same numbers, by
/// source text. Two independent derivations that agree are only worth something if
/// they are also derived against the same published constants.
#[test]
fn the_two_files_agree_on_the_post_b2_columns() {
    for (name, arr) in [
        ("B2_CONJECTURED_FORGERY_BITS", &B2_CONJECTURED),
        ("B2_UNCONDITIONAL_FORGERY_BITS", &B2_UNCONDITIONAL),
    ] {
        let line = format!("const {name}: [u32; 7] = {};", fmt(arr));
        assert!(
            B1_DEEP_BINDING_SRC.contains(&line),
            "b1_deep_binding.rs must declare exactly `{line}`. If the shipped array moved, \
             this file's independent derivation has to move with it — and it only moves if \
             a config or GRINDING_BITS moved.",
        );
    }
}

/// The gain table in this file's own module doc is generated by the test above.
/// Gate it against the derivation so the number a pitch deck reaches for cannot
/// drift from the number the suite computes.
#[test]
fn the_module_doc_gain_table_matches_the_derivation() {
    let doc_end = SELF_SRC.find("\nuse ").expect("module doc precedes the imports");
    let doc = &SELF_SRC[..doc_end];
    for id in 0u8..=6 {
        let b1 = b1_columns(id);
        let b2 = b2_columns(id);
        let row = format!(
            "//!  C{id} | {:7} | {:7} | {:+4} | {:9} | {:9} | {:+4}",
            b1.conjectured,
            b2.conjectured,
            b2.conjectured as i64 - b1.conjectured as i64,
            b1.unconditional,
            b2.unconditional,
            b2.unconditional as i64 - b1.unconditional as i64,
        );
        assert!(
            doc.contains(&row),
            "the module doc's gain table is stale: expected the row `{row}`",
        );
    }
    assert!(
        doc.contains("1.000 to 4.000 bits"),
        "the module doc must state the MEASURED per-query rate change, which \
         `the_per_query_rate_is_measured_on_all_seven_circuits` produces",
    );
}
