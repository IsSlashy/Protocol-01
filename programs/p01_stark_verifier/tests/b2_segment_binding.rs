//! [B2] The segment split is BOUND, not just committed.
//!
//! # The degree of freedom B2 created
//!
//! Pre-B2 the wire carried exactly one `Q(z)` and phase 2 pinned it:
//! `C(z) == Q(z) * Z_T(z)` is one equation in one quotient unknown. Post-B2 the
//! wire carries `k` claims `Q_0(z) .. Q_{k-1}(z)` and phase 2 still checks ONE
//! equation — on the RECOMBINATION `SUM_j z^(jn) Q_j(z)`. That leaves `k-1`
//! dimensions of lie about the split that phase 2 is structurally blind to.
//!
//! `GenericCompactProof::ood_quotient_recombined` says so in its own doc:
//!
//! > Recombining here rather than shipping `Q(z)` is what keeps the segments
//! > bound: a prover who could publish `Q(z)` directly would be free to choose
//! > any split consistent with it AFTER seeing gamma, and the DEEP composition
//! > would stop binding the individual columns.
//!
//! and `deep_composition_lde` says:
//!
//! > [B2] Every segment carries its OWN gamma power. Batching them into a single
//! > value first, or reusing a power across two segments, leaves every existing
//! > test green while un-binding the segments.
//!
//! Both are claims about a mechanism that nothing in the tree exercised. Every
//! B1 forgery perturbs `ood_current` and RE-SOLVES `ood_quotient`, so it is
//! caught by the trace half of the DEEP composition and would still be caught if
//! all `k` segments shared one gamma power. This file drives the segment half on
//! its own.
//!
//! # The adversary
//!
//! `OodForgery::SegmentSplit` is strictly stronger than `Coordinated` in every
//! respect except which claim it lies about:
//!
//! * the trace is HONEST and every `ood_current` / `ood_next` word is HONEST, so
//!   the trace half of the DEEP composition contributes ZERO residue;
//! * every committed quotient column is HONEST;
//! * `SUM_j z^(jn) Q_j(z)` is preserved EXACTLY, so phase 2 holds with equality
//!   and needs no re-solve — it is not "still satisfiable", it is untouched;
//! * `SUM_j Q_j(z)` is ALSO preserved exactly, so a verifier that collapsed the
//!   segments onto a single shared gamma power would see zero residue too;
//! * everything downstream — gamma, every alpha, every layer root, the grinding
//!   nonce, every query position — is derived by the prover from the lying split.
//!
//! The only thing in the entire pipeline that can reject it is
//! `SUM_j gamma^(w+1+j) * (Q_j(x) - q_j) != 0` at `x = z`, i.e. the per-segment
//! gamma powers. That is the acceptance criterion for B2 and this is the file
//! that measures it.
//!
//! # The other leg, MEASURED, and what it corrected
//!
//! A rejection test proves nothing unless the same input is ACCEPTED with the
//! mechanism disabled. Collapsing the segment powers onto one shared
//! `gamma^(w+1)` in all three places they are built — `deep_composition_lde`,
//! `verify_fri_generic`, `verify_fri_legacy` — was run against this file and
//! MEASURED on 2026-08-01:
//!
//! * all seven HONEST proofs still verify, so the collapsed verifier is not
//!   merely broken;
//! * the segment-split forgery is ACCEPTED on C0, C1, C2, C3, C4 and C5, in both
//!   terminal variants — 12 of 14 cases;
//! * C6 alone rejected, and NOT by FRI: `TransitionConstraintFailed`, a
//!   trace-only step-4 check that has nothing to do with the split.
//!
//! That measurement also falsifies half of what `deep_composition_lde`'s own doc
//! says about this failure mode. It claims reusing a power across two segments
//! "leaves every existing test green while un-binding the segments and returning
//! `deg(D)` to `8n`". The first half is exactly right and is why this file exists.
//! The second half is WRONG: `SUM_j Q_j(x)` still has degree `< n`, so `deg(D)`
//! stays `n - 2`, the terminal degree bound stays 1 of 16, and the honest
//! terminal-bound assert in both prover pipelines stays green. A collapsed
//! implementation is INVISIBLE to the degree bound. There is no second line of
//! defence behind the per-segment powers.

use p01_stark::compact::{OodForgery, TerminalPoly};
use p01_stark_verifier::compact_proof::{
    get_circuit_config, CircuitConfig, CompactStarkProof, GenericCompactProof,
    CONFIG_BALANCE_PROOF, CONFIG_CONFIDENTIAL_BALANCE, CONFIG_MERKLE_PATH, CONFIG_MERKLE_UPDATE,
    CONFIG_POOL_COMMITMENT, CONFIG_TRANSFER, LEGACY_QUOTIENT_SEGMENTS,
};
use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::{
    verify_deep_ali_circuit_1, verify_deep_ali_circuit_2, verify_deep_ali_circuit_3,
    verify_deep_ali_circuit_4, verify_deep_ali_circuit_5, verify_deep_ali_circuit_6,
    verify_generic, verify_subscriber_ownership, VerifyError,
};

/// C0's trace length. `CONFIG_SUBSCRIBER_OWNERSHIP` carries it but the legacy
/// parser hard-codes the constant, so the recombination helper takes it as an
/// argument and C0 passes 32 explicitly.
const TRACE_LENGTH_C0: usize = 32;

// ============================================================================
// Wire readers. Header: trace_root 32 | quotient_root 32 | ood_current 8w |
// ood_next 8w | ood_z 8 | ood_quotient 8k | ...
// ============================================================================

fn felt_at(bytes: &[u8], off: usize) -> Felt {
    Felt::from_le_bytes(bytes[off..off + 8].try_into().unwrap())
}

fn ood_z_of(bytes: &[u8], w: usize) -> Felt {
    felt_at(bytes, 64 + 16 * w)
}

fn ood_quotient_of(bytes: &[u8], w: usize, k: usize) -> Vec<Felt> {
    let base = 64 + 16 * w + 8;
    (0..k).map(|j| felt_at(bytes, base + j * 8)).collect()
}

fn ood_current_of(bytes: &[u8], w: usize) -> Vec<Felt> {
    (0..w).map(|c| felt_at(bytes, 64 + c * 8)).collect()
}

fn ood_next_of(bytes: &[u8], w: usize) -> Vec<Felt> {
    (0..w).map(|c| felt_at(bytes, 64 + w * 8 + c * 8)).collect()
}

/// `SUM_j z^(jn) * Q_j(z)` — the ONE functional phase 2 sees.
fn recombine(qs: &[Felt], z: Felt, trace_length: usize) -> Felt {
    let zn = z.exp(trace_length as u64);
    let mut acc = Felt::ZERO;
    let mut zp = Felt::ONE;
    for &q in qs {
        acc = acc.add(zp.mul(q));
        zp = zp.mul(zn);
    }
    acc
}

/// `SUM_j Q_j(z)` — what a verifier that shared ONE gamma power across all
/// segments would see instead.
fn plain_sum(qs: &[Felt]) -> Felt {
    qs.iter().fold(Felt::ZERO, |a, &q| a.add(q))
}

fn phase2(
    circuit_id: u8,
    parsed: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    match circuit_id {
        1 => verify_deep_ali_circuit_1(parsed, public_inputs),
        2 => verify_deep_ali_circuit_2(parsed, public_inputs),
        3 => verify_deep_ali_circuit_3(parsed, public_inputs),
        4 => verify_deep_ali_circuit_4(parsed, public_inputs),
        5 => verify_deep_ali_circuit_5(parsed, public_inputs),
        6 => verify_deep_ali_circuit_6(parsed, public_inputs),
        other => panic!("no phase-2 entry point for circuit {other}"),
    }
}

// ============================================================================
// The six generic witnesses, one place.
// ============================================================================

fn merkle_witness() -> (Vec<u64>, Vec<u8>) {
    // [C3-D12] 12, not 15. C3 took the depth cut on 2026-08-29, the same day as
    // C6 (`merkle_update_witness` below).
    ((0..12u64).map(|i| 1000 + i).collect(), (0..12u8).map(|i| i % 2).collect())
}

fn merkle_update_witness() -> (Vec<u64>, Vec<u8>) {
    // [C6-D12] 12, not 15. `merkle_witness` above stays at 15: that is C3, and
    // only C6 took the depth cut.
    ((0..12).map(|i| 100u64 + i * 13).collect(), (0..12).map(|i| (i % 2) as u8).collect())
}

fn generic_case(
    id: u8,
    ood: OodForgery,
    term: TerminalPoly,
) -> p01_stark::compact::GenericCompactProofData {
    use p01_stark::compact as c;
    match id {
        1 => c::generate_pool_commitment_proof_with_forgery(111, 222, 333, 444, ood, term),
        2 => c::generate_balance_compact_proof_with_forgery(42, 1000, 777, 999, ood, term),
        3 => {
            let (pe, pi) = merkle_witness();
            c::generate_merkle_path_compact_proof_with_forgery(777, &pe, &pi, &c::c3_deterministic_probe_mask(pe.len()), ood, term)
        }
        4 => c::generate_confidential_balance_compact_proof_with_forgery(
            42, 1000, 111, 800, 222, 200, 333, 999, ood, term,
        ),
        5 => c::generate_transfer_compact_proof_with_forgery(
            13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50, ood, term,
        ),
        6 => {
            let (pe, pi) = merkle_update_witness();
            c::generate_merkle_update_compact_proof_with_forgery(111, 222, &pe, &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len()), ood, term)
        }
        other => panic!("no generic pipeline for circuit {other}"),
    }
}

fn config_for(id: u8) -> &'static CircuitConfig {
    match id {
        1 => &CONFIG_POOL_COMMITMENT,
        2 => &CONFIG_BALANCE_PROOF,
        3 => &CONFIG_MERKLE_PATH,
        4 => &CONFIG_CONFIDENTIAL_BALANCE,
        5 => &CONFIG_TRANSFER,
        6 => &CONFIG_MERKLE_UPDATE,
        other => panic!("no config for circuit {other}"),
    }
}

// ============================================================================
// S0 — the forgery IS the forgery. Without this the rejections below could be
// rejections of a proof that is simply broken.
// ============================================================================

/// Every invariant the adversary claims to preserve, checked on the wire, on all
/// seven circuits.
///
/// Failing any of these does not mean the verifier is weak; it means the probe
/// is not the attack this file says it is, and every other assertion here would
/// be measuring the wrong thing.
#[test]
fn s0_the_segment_split_forgery_preserves_everything_except_the_split() {
    // C0, legacy path.
    {
        let honest = p01_stark::compact::generate_compact_proof(42);
        let forged = p01_stark::compact::generate_compact_proof_with_forgery(
            42,
            OodForgery::SegmentSplit,
            TerminalPoly::Honest,
        );
        check_invariants(
            "C0",
            &honest.proof_bytes,
            &forged.proof_bytes,
            3,
            LEGACY_QUOTIENT_SEGMENTS,
            TRACE_LENGTH_C0,
        );
        assert_eq!(honest.commitment, forged.commitment, "C0: same public input");
    }

    for id in 1u8..=6 {
        let cfg = config_for(id);
        let honest = generic_case(id, OodForgery::None, TerminalPoly::Honest);
        let forged = generic_case(id, OodForgery::SegmentSplit, TerminalPoly::Honest);
        assert_eq!(
            honest.public_inputs, forged.public_inputs,
            "C{id}: the forgery must keep the SAME public inputs",
        );
        check_invariants(
            &format!("C{id}"),
            &honest.proof_bytes,
            &forged.proof_bytes,
            cfg.trace_width,
            cfg.quotient_segments,
            cfg.trace_length,
        );
    }
}

fn check_invariants(
    label: &str,
    honest: &[u8],
    forged: &[u8],
    w: usize,
    k: usize,
    trace_length: usize,
) {
    assert_eq!(
        honest.len(),
        forged.len(),
        "{label}: the segment-split forgery is zero-wire-delta",
    );

    // The OOD point is derived from the two roots and the public inputs ONLY, so
    // an honest trace and an honest quotient give the same z. If this ever
    // differs the two proofs are not comparable and nothing below means anything.
    let z = ood_z_of(honest, w);
    assert_eq!(
        z.as_u64(),
        ood_z_of(forged, w).as_u64(),
        "{label}: z must be identical — the forgery does not touch either root",
    );

    // The trace half of the DEEP composition must contribute ZERO residue.
    assert_eq!(
        ood_current_of(honest, w).iter().map(|f| f.as_u64()).collect::<Vec<_>>(),
        ood_current_of(forged, w).iter().map(|f| f.as_u64()).collect::<Vec<_>>(),
        "{label}: ood_current must be HONEST — if it moved, this is a Coordinated \
         forgery wearing a different name and the trace terms would carry the rejection",
    );
    assert_eq!(
        ood_next_of(honest, w).iter().map(|f| f.as_u64()).collect::<Vec<_>>(),
        ood_next_of(forged, w).iter().map(|f| f.as_u64()).collect::<Vec<_>>(),
        "{label}: ood_next must be HONEST",
    );

    let qh = ood_quotient_of(honest, w, k);
    let qf = ood_quotient_of(forged, w, k);

    // The split really is a lie, on at least two segments (one moved segment
    // cannot preserve either invariant).
    let moved: Vec<usize> =
        (0..k).filter(|&j| qh[j].as_u64() != qf[j].as_u64()).collect();
    assert!(
        moved.len() >= 2,
        "{label}: only {} segment claim(s) moved ({moved:?}) — a forgery that moves \
         fewer than two cannot preserve the recombination and is not this attack",
        moved.len(),
    );

    // INVARIANT 1 — phase 2 is blind to it.
    assert_eq!(
        recombine(&qh, z, trace_length).as_u64(),
        recombine(&qf, z, trace_length).as_u64(),
        "{label}: SUM_j z^(jn) Q_j(z) must be IDENTICAL. Phase 2 checks exactly this \
         functional, so if it moved, phase 2 would catch the forgery and the FRI \
         rejection below would prove nothing about segment binding",
    );

    // INVARIANT 2 — a shared-gamma verifier is blind to it.
    assert_eq!(
        plain_sum(&qh).as_u64(),
        plain_sum(&qf).as_u64(),
        "{label}: SUM_j Q_j(z) must be IDENTICAL. This is what a verifier that reused \
         one gamma power across the segments would see; if it moved, the rejection \
         below would not isolate the PER-SEGMENT powers",
    );

    println!(
        "[S0 {label}] w={w} k={k} n={trace_length} moved segments {moved:?}, \
         recombination and plain sum both preserved, {} B",
        forged.len(),
    );
}

// ============================================================================
// S1 — the rejection leg, all seven circuits.
// ============================================================================

/// A segment-split forgery must be REJECTED, by FRI, on every circuit.
///
/// `verify_generic` runs ood_range -> ood_z -> positions -> merkle -> FRI ->
/// constraints -> boundary in that order, so a FRI-specific variant proves the
/// positions and every Merkle opening passed and that the rejection came from the
/// DEEP composition. `DeepAliFailed` here would mean phase 2 caught it, which
/// would contradict S0's invariant 1.
#[test]
fn s1_a_segment_split_forgery_is_rejected_on_every_circuit() {
    // C0, legacy path. DEEP-ALI runs INSIDE phase 1 and BEFORE FRI here, so a
    // FRI variant out of one `verify_subscriber_ownership` call is itself the
    // proof that the identity accepted.
    let forged = p01_stark::compact::generate_compact_proof_with_forgery(
        42,
        OodForgery::SegmentSplit,
        TerminalPoly::Honest,
    );
    let parsed = CompactStarkProof::from_bytes(&forged.proof_bytes)
        .expect("forged C0 proof still parses");
    let err = verify_subscriber_ownership(&parsed, Felt::new(forged.commitment))
        .expect_err("C0: a segment-split forgery must be REJECTED");
    assert!(
        matches!(
            err,
            VerifyError::FriTerminalCheckFailed
                | VerifyError::FriFoldCheckFailed
                | VerifyError::FriFinalPolyDegreeTooHigh
        ),
        "C0 must be rejected by the FRI-on-D binding. Got {err:?} — `DeepAliFailed` \
         would contradict S0 (the recombination is untouched), `InvalidQueryPosition` \
         would mean the transcript was inconsistent (it is not: the prover built it).",
    );
    println!("[S1 C0] rejected with {err:?}");

    for id in 1u8..=6 {
        let cfg = config_for(id);
        let forged = generic_case(id, OodForgery::SegmentSplit, TerminalPoly::Honest);
        let parsed = GenericCompactProof::from_bytes(&forged.proof_bytes, cfg)
            .unwrap_or_else(|| panic!("C{id}: forged proof still parses"));

        let err = match verify_generic(&parsed, id, &forged.public_inputs, cfg) {
            Ok(()) => panic!(
                "C{id} S1: a segment-split forgery was ACCEPTED. The per-segment gamma \
                 powers are the ONLY mechanism that can see this lie — phase 2 is blind \
                 to it by S0 invariant 1 — so acceptance means the segments are \
                 committed but NOT bound, and `deg(D) = n-2` is an over-claim."
            ),
            Err(e) => e,
        };
        assert!(
            matches!(
                err,
                VerifyError::FriTerminalCheckFailed
                    | VerifyError::FriFoldCheckFailed
                    | VerifyError::FriFinalPolyDegreeTooHigh
            ),
            "C{id} S1 must be rejected inside verify_fri_generic, got {err:?}",
        );
        println!("[S1 C{id}] rejected with {err:?}");

        // The control that makes S1 mean something: phase 2 ACCEPTS, with no
        // re-solve anywhere. If this ever fails, the forgery moved something it
        // was not supposed to move.
        phase2(id, &parsed, &forged.public_inputs).unwrap_or_else(|e| {
            panic!(
                "C{id} S1 control: phase 2 must ACCEPT the segment-split forgery, got \
                 {e:?}. The recombination is preserved EXACTLY (S0 invariant 1), so a \
                 rejection here means `ood_quotient_recombined` and the prover's \
                 `recombine_ood_quotient` disagree about the segment weights."
            )
        });
        println!("[S1 C{id}] phase 2 accepted the forgery, as designed");
    }
}

// ============================================================================
// S2 — the rejection has to happen IN THE FOLD CHAIN, not at the degree check.
// ============================================================================

/// With the honest terminal polynomial every B1 and B2 forgery now dies at
/// `FriFinalPolyDegreeTooHigh`, which is a ONE-SHOT check that runs BEFORE any
/// per-query DEEP arithmetic. That is a real rejection but it does not exercise
/// the per-segment gamma powers at all.
///
/// This test publishes the aliased terminal polynomial, which is INSIDE the
/// degree bound by construction, so the degree check cannot fire and the proof
/// must run the entire per-query DEEP composition — `k` gamma powers, `k`
/// segment openings per query, both halves of every coset — before the terminal
/// comparison rejects it. Pinning the variant EXACTLY is what proves the fold
/// chain was reached.
#[test]
fn s2_the_segment_split_rejection_reaches_the_per_query_fold_chain() {
    // C0's bound is 1 of 16 and `AliasedFold` reduces mod x^k with
    // k = largest power of two <= bound = 1, i.e. a constant — same construction
    // as `SubgroupAlias` at this bound.
    let forged = p01_stark::compact::generate_compact_proof_with_forgery(
        42,
        OodForgery::SegmentSplit,
        TerminalPoly::SubgroupAlias,
    );
    let parsed = CompactStarkProof::from_bytes(&forged.proof_bytes)
        .expect("aliased forged C0 proof still parses");
    let err = verify_subscriber_ownership(&parsed, Felt::new(forged.commitment))
        .expect_err("C0: aliased segment-split forgery must be REJECTED");
    assert_eq!(
        err,
        VerifyError::FriTerminalCheckFailed,
        "C0 S2 must be rejected by the TERMINAL comparison specifically — anything \
         else (and especially FriFinalPolyDegreeTooHigh) means the per-query DEEP \
         arithmetic was never reached and the per-segment gamma powers were never \
         exercised",
    );
    println!("[S2 C0] rejected with {err:?}");

    for id in 1u8..=6 {
        let cfg = config_for(id);
        let forged = generic_case(id, OodForgery::SegmentSplit, TerminalPoly::AliasedFold);
        let parsed = GenericCompactProof::from_bytes(&forged.proof_bytes, cfg)
            .unwrap_or_else(|| panic!("C{id}: aliased forged proof still parses"));

        // The published poly really is inside the bound, so the degree check is
        // structurally unable to fire.
        let poly = final_poly_of(&forged.proof_bytes, cfg.trace_width, cfg.quotient_segments);
        for (i, &c) in poly.iter().enumerate().skip(cfg.fri_final_poly_degree_bound) {
            assert_eq!(c, 0, "C{id} S2: aliased poly must be WITHIN the bound (coeff {i})");
        }

        // Post-B2 the aliased polynomial agrees with the true final layer at
        // terminal index 0 ALONE, so rejection needs one query at ANY non-zero
        // terminal index — not merely an odd one, which is what the B1 harness
        // still counts.
        let nonzero = parsed
            .queries
            .iter()
            .filter(|q| (q.position as usize) % cfg.fri_final_poly_size != 0)
            .count();
        assert!(
            nonzero > 0,
            "C{id} S2 needs at least one query at a non-zero terminal index; got \
             0/{}. At bound 1 that is a 16^-{} accident on a fixed witness.",
            parsed.queries.len(),
            parsed.queries.len(),
        );
        println!(
            "[S2 C{id}] terminal indices: {}/{} non-zero",
            nonzero,
            parsed.queries.len(),
        );

        let err = match verify_generic(&parsed, id, &forged.public_inputs, cfg) {
            Ok(()) => panic!("C{id} S2: the aliased segment-split forgery was ACCEPTED"),
            Err(e) => e,
        };
        assert_eq!(
            err,
            VerifyError::FriTerminalCheckFailed,
            "C{id} S2 must be rejected by the TERMINAL comparison specifically — \
             FriFinalPolyDegreeTooHigh would mean the per-query DEEP arithmetic, and \
             therefore the per-segment gamma powers, were never reached",
        );
        println!("[S2 C{id}] rejected with {err:?}");
    }
}

fn final_poly_of(bytes: &[u8], w: usize, k: usize) -> Vec<u64> {
    let mut c = 32 + 32 + w * 8 * 2 + 8 + k * 8;
    let num_layers = bytes[c] as usize;
    c += 1 + num_layers * 32;
    let fps = u16::from_le_bytes([bytes[c], bytes[c + 1]]) as usize;
    c += 2;
    (0..fps)
        .map(|i| u64::from_le_bytes(bytes[c + i * 8..c + i * 8 + 8].try_into().unwrap()))
        .collect()
}

// ============================================================================
// S3 — the terminal index distribution, MEASURED on the wire.
// ============================================================================

/// `pos mod fri_final_poly_size` is what the whole 4.000 bits/query figure rests
/// on: a query is worth `-log2(bound / fps)` ONLY if the terminal index it lands
/// on is uniform. A prover who could steer his queries onto index 0 would pay
/// nothing for the aliased terminal polynomial.
///
/// The grinding nonce is the ONLY knob a prover has over the positions, and it
/// buys `GRINDING_BITS` of search against `4 * num_queries` bits of target. This
/// records the distribution actually observed on honest proofs of every circuit
/// and asserts the two properties the figure needs: no query count concentrated
/// on index 0, and every terminal index reachable.
#[test]
fn s3_terminal_index_distribution_on_honest_proofs() {
    for id in 1u8..=6 {
        let cfg = config_for(id);
        let mut hist = vec![0usize; cfg.fri_final_poly_size];
        let mut total = 0usize;
        for seed in 0..4u64 {
            let honest = honest_variant(id, seed);
            let parsed = GenericCompactProof::from_bytes(&honest.proof_bytes, cfg)
                .unwrap_or_else(|| panic!("C{id} seed {seed} parses"));
            for q in parsed.queries.iter() {
                hist[(q.position as usize) % cfg.fri_final_poly_size] += 1;
                total += 1;
            }
        }
        let share = total as f64 / cfg.fri_final_poly_size as f64;
        println!("[S3 C{id}] n={total} over {} indices: {hist:?}", cfg.fri_final_poly_size);
        assert!(
            hist[0] as f64 <= 3.0 * share,
            "C{id}: {} of {total} queries landed on terminal index 0, more than 3x its \
             {share:.1} share. Index 0 is the ONE index where the aliased terminal \
             polynomial agrees with the true final layer, so a bias towards it is a \
             direct discount on the 4.000 bits/query figure.",
            hist[0],
        );
        assert!(
            hist.iter().all(|&c| c > 0),
            "C{id}: some terminal index was never reached in {total} draws — the \
             uniformity `log2(fps/bound)` assumes does not hold and the per-query \
             figure is not measured, it is assumed",
        );
    }
}

fn honest_variant(id: u8, seed: u64) -> p01_stark::compact::GenericCompactProofData {
    use p01_stark::compact as c;
    match id {
        1 => c::generate_pool_commitment_proof(111 + seed, 222, 333, 444),
        2 => c::generate_balance_compact_proof(42 + seed, 1000, 777, 999),
        3 => {
            let (mut pe, pi) = merkle_witness();
            pe[0] += seed;
            c::generate_merkle_path_compact_proof(777, &pe, &pi, &c::c3_deterministic_probe_mask(pe.len()))
        }
        4 => c::generate_confidential_balance_compact_proof(
            42 + seed,
            1000,
            111,
            800,
            222,
            200,
            333,
            999,
        ),
        5 => c::generate_transfer_compact_proof(
            13 + seed,
            500,
            77,
            400,
            88,
            100,
            150,
            1234,
            555,
            65,
            2222,
            333,
            50,
        ),
        6 => {
            let (mut pe, pi) = merkle_update_witness();
            pe[0] += seed;
            c::generate_merkle_update_compact_proof(111, 222, &pe, &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len()))
        }
        other => panic!("no honest pipeline for circuit {other}"),
    }
}

// ============================================================================
// S4 — the segment count really is off the wire, on EVERY circuit.
// ============================================================================

/// `a_proof_parsed_with_the_wrong_segment_count_is_refused` drives C1 only, and
/// C1 is the WIDEST-margin case: `k` appears in three separate length terms so
/// almost any wrong `k` desynchronises the cursor. C0 is the interesting one —
/// it is the sole circuit at `k = 7` and it is the sole verifier for four shipped
/// instructions — and C4 is the interesting generic one, because
/// `16*trace_width - 64 == 0` makes it the sharpest version-skew case in the tree.
///
/// This drives all six generic circuits against every other circuit's `k`, plus
/// the neighbours of the real value.
#[test]
fn s4_no_circuit_accepts_another_circuits_segment_count() {
    for id in 1u8..=6 {
        let real = config_for(id);
        let bytes = generic_case(id, OodForgery::None, TerminalPoly::Honest);
        let ok = GenericCompactProof::from_bytes(&bytes.proof_bytes, real)
            .unwrap_or_else(|| panic!("C{id} parses under its own config"));
        assert_eq!(ok.ood_quotient_len(), real.quotient_segments);
        verify_generic(&ok, id, &bytes.public_inputs, real)
            .unwrap_or_else(|e| panic!("C{id} honest control must verify, got {e:?}"));

        for wrong in [1usize, 2, 3, 4, 5, 6, 7, 9, 10, 16, 64] {
            if wrong == real.quotient_segments {
                continue;
            }
            let cfg = CircuitConfig { quotient_segments: wrong, ..copy_config(real) };
            match GenericCompactProof::from_bytes(&bytes.proof_bytes, &cfg) {
                None => {}
                Some(proof) => {
                    let err = verify_generic(&proof, id, &bytes.public_inputs, &cfg)
                        .expect_err(&format!(
                            "C{id} parsed under k={wrong} (real {}) and VERIFIED. The \
                             segment count never travels on the wire, so two parties \
                             disagreeing about it must not be able to agree on a proof.",
                            real.quotient_segments,
                        ));
                    println!("[S4 C{id}] k={wrong} parsed but rejected with {err:?}");
                }
            }
        }
    }
}

/// `CircuitConfig` has no `Clone`; spelled out so a new field is a compile error
/// here rather than a silently-defaulted value.
fn copy_config(c: &CircuitConfig) -> CircuitConfig {
    CircuitConfig {
        trace_width: c.trace_width,
        trace_length: c.trace_length,
        blowup: c.blowup,
        lde_size: c.lde_size,
        merkle_depth: c.merkle_depth,
        num_rounds: c.num_rounds,
        fri_final_poly_size: c.fri_final_poly_size,
        fri_final_poly_degree_bound: c.fri_final_poly_degree_bound,
        quotient_segments: c.quotient_segments,
        num_queries: c.num_queries,
    }
}

// ============================================================================
// S5 — WHICH mechanism actually fires, recorded rather than assumed.
// ============================================================================

/// B2 silently moved where every forgery dies.
///
/// PRE-B2 a coordinated forgery with the honest terminal polynomial was caught
/// in the fold chain on the six generic circuits, and only C0 died at the
/// one-shot `check_final_poly_degree_bound` — `b1_deep_binding.rs`'s coverage
/// table records that as a C0-SPECIFIC note. POST-B2 the terminal degree bound
/// is 1 of 16 instead of 8 of 16, so a forged `D`'s terminal interpolant spills
/// past the bound on EVERY circuit and all seven now die at the degree check,
/// before a single per-query DEEP multiplication runs. Nothing in the suite says
/// so, and `matches!(err, ...three variants...)` cannot tell the difference.
///
/// That is not vacuity — MUT-A (collapsing the segment gamma powers) makes these
/// same proofs verify, so the legs do discriminate — but it does mean the
/// honest-terminal leg no longer exercises the mechanism its own doc names.
///
/// This test asserts the invariant that actually matters and holds in both
/// eras: for EVERY circuit, the aliased-terminal leg must reject at
/// `FriTerminalCheckFailed` specifically, i.e. the per-query fold chain must be
/// reachable and load-bearing. The honest-terminal variant is PRINTED, not
/// pinned, so a future change of mechanism shows up in the log instead of as a
/// spurious red.
#[test]
fn s5_the_rejecting_mechanism_is_recorded_for_both_forgeries_on_every_circuit() {
    let mut table: Vec<String> = Vec::new();

    for (fname, ood) in [
        ("coordinated", OodForgery::Coordinated { col: 0, delta: 1 }),
        ("segment-split", OodForgery::SegmentSplit),
    ] {
        // C0, legacy: `AliasedFold` and `SubgroupAlias` coincide at bound 1.
        for (tname, term) in
            [("honest-terminal", TerminalPoly::Honest), ("aliased", TerminalPoly::SubgroupAlias)]
        {
            let f = p01_stark::compact::generate_compact_proof_with_forgery(42, ood, term);
            let p = CompactStarkProof::from_bytes(&f.proof_bytes).expect("C0 parses");
            let err = verify_subscriber_ownership(&p, Felt::new(f.commitment))
                .expect_err("C0: every forgery leg must be REJECTED");
            table.push(format!("C0 {fname:13} {tname:15} -> {err:?}"));
            if tname == "aliased" {
                assert_eq!(
                    err,
                    VerifyError::FriTerminalCheckFailed,
                    "C0 {fname}: the aliased leg must reach the TERMINAL comparison. \
                     Anything else means the per-query DEEP arithmetic was never run \
                     and this circuit has no negative coverage of the fold chain at all.",
                );
            }
        }

        for id in 1u8..=6 {
            let cfg = config_for(id);
            for (tname, term) in
                [("honest-terminal", TerminalPoly::Honest), ("aliased", TerminalPoly::AliasedFold)]
            {
                let f = generic_case(id, ood, term);
                let p = GenericCompactProof::from_bytes(&f.proof_bytes, cfg)
                    .unwrap_or_else(|| panic!("C{id} parses"));
                let err = verify_generic(&p, id, &f.public_inputs, cfg)
                    .expect_err("every forgery leg must be REJECTED");
                table.push(format!("C{id} {fname:13} {tname:15} -> {err:?}"));
                if tname == "aliased" {
                    assert_eq!(
                        err,
                        VerifyError::FriTerminalCheckFailed,
                        "C{id} {fname}: the aliased leg must reach the TERMINAL comparison",
                    );
                }
            }
        }
    }

    for row in table.iter() {
        println!("[S5] {row}");
    }
    assert_eq!(table.len(), 28, "7 circuits x 2 forgeries x 2 terminal plays");
}

// ============================================================================
// S6 — mixing segments ACROSS proofs.
// ============================================================================

/// Take one honest proof of statement A and splice segment 3 out of an honest
/// proof of statement B into it, at both places segment 3 lives on the wire.
///
/// Neither splice should get anywhere, and the two are rejected by DIFFERENT
/// mechanisms, which is the point of testing both:
///
/// * the header claim `Q_3(z)` is absorbed into `build_base_seed`, so replacing
///   it moves gamma, every alpha, the grinding target and every query position —
///   the transcript check catches it and the DEEP composition is never asked;
/// * the per-query opened values are NOT absorbed anywhere. They are bound only
///   by the quotient pair leaf, which is where `b4_pair_leaf.rs`'s 16 mutations
///   live. Splicing them is the case that would survive if the leaf preimage
///   ever narrowed again.
#[test]
fn s6_segments_cannot_be_mixed_across_proofs() {
    let cfg = &CONFIG_POOL_COMMITMENT;
    let a = p01_stark::compact::generate_pool_commitment_proof(111, 222, 333, 444);
    let b = p01_stark::compact::generate_pool_commitment_proof(555, 666, 777, 888);
    assert_ne!(a.public_inputs, b.public_inputs, "two DIFFERENT statements");
    assert_eq!(a.proof_bytes.len(), b.proof_bytes.len(), "same circuit, same length");

    let w = cfg.trace_width;
    let k = cfg.quotient_segments;
    const SEG: usize = 3;

    // Control: both verify on their own.
    for (label, p) in [("A", &a), ("B", &b)] {
        let parsed = GenericCompactProof::from_bytes(&p.proof_bytes, cfg)
            .unwrap_or_else(|| panic!("{label} parses"));
        verify_generic(&parsed, 1, &p.public_inputs, cfg)
            .unwrap_or_else(|e| panic!("{label} honest control must verify, got {e:?}"));
    }

    let nq = GenericCompactProof::from_bytes(&a.proof_bytes, cfg).unwrap().queries.len();
    let tail = a.proof_bytes.len() - nq * k * 8;

    // --- Splice 1: the header claim Q_3(z).
    let mut h = a.proof_bytes.clone();
    let off = 64 + 16 * w + 8 + SEG * 8;
    h[off..off + 8].copy_from_slice(&b.proof_bytes[off..off + 8]);
    assert_ne!(h, a.proof_bytes, "the header splice must actually change bytes");
    let err = match GenericCompactProof::from_bytes(&h, cfg) {
        None => "rejected at parse".to_string(),
        Some(p) => format!(
            "{:?}",
            verify_generic(&p, 1, &a.public_inputs, cfg)
                .expect_err("header splice of Q_3(z) must be REJECTED")
        ),
    };
    println!("[S6] header Q_{SEG}(z) from another statement -> {err}");

    // --- Splice 2: every opened value of segment 3, in the tail.
    let mut t = a.proof_bytes.clone();
    for q in 0..nq {
        let o = tail + (q * k + SEG) * 8;
        t[o..o + 8].copy_from_slice(&b.proof_bytes[o..o + 8]);
    }
    assert_ne!(t, a.proof_bytes, "the tail splice must actually change bytes");
    let parsed = GenericCompactProof::from_bytes(&t, cfg).expect("tail splice still parses");
    let err = verify_generic(&parsed, 1, &a.public_inputs, cfg).expect_err(
        "splicing segment 3's opened values out of another statement's proof must be \
         REJECTED. These values are absorbed into NO transcript — the quotient pair \
         leaf is the only thing that binds them, and it must cover every segment.",
    );
    println!("[S6] tail Q_{SEG}(x) openings from another statement -> {err:?}");
    assert_eq!(
        err,
        VerifyError::MerkleProofFailed,
        "the tail splice must die at the QUOTIENT PAIR LEAF. Any later variant would \
         mean the spliced values were authenticated by something weaker than the \
         commitment, and any earlier one that the transcript caught it — which it \
         cannot, because these bytes are absorbed nowhere.",
    );

    // --- Splice 3: both at once, which is what a naive "take segment 3 from the
    // other proof" actually looks like.
    let mut both = t.clone();
    both[off..off + 8].copy_from_slice(&b.proof_bytes[off..off + 8]);
    let err = match GenericCompactProof::from_bytes(&both, cfg) {
        None => "rejected at parse".to_string(),
        Some(p) => format!(
            "{:?}",
            verify_generic(&p, 1, &a.public_inputs, cfg)
                .expect_err("full segment-3 splice must be REJECTED")
        ),
    };
    println!("[S6] header + tail segment {SEG} from another statement -> {err}");
}

/// C0's `LEGACY_QUOTIENT_SEGMENTS` and `CONFIG_SUBSCRIBER_OWNERSHIP.quotient_segments`
/// are two independent constants for one number, on the path that verifies four
/// shipped instructions. They are also the only `k = 7` in the tree, so a
/// confusion with the generic `k = 8` is the one cross-circuit shape mismatch
/// that could go unnoticed.
#[test]
fn s4b_c0_is_the_only_k_seven_and_its_two_constants_agree() {
    let c0 = get_circuit_config(0).expect("C0 config");
    assert_eq!(
        c0.quotient_segments, LEGACY_QUOTIENT_SEGMENTS,
        "C0's config and the legacy parser's constant must be the same number — the \
         legacy parser hard-codes LEGACY_QUOTIENT_SEGMENTS and never reads the config",
    );
    assert_eq!(LEGACY_QUOTIENT_SEGMENTS, 7);
    for id in 1u8..=6 {
        assert_eq!(
            get_circuit_config(id).unwrap().quotient_segments,
            8,
            "C{id}: every generic circuit is k=8; C0 alone is 7",
        );
    }
}
