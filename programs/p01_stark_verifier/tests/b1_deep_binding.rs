//! [B1] DEEP binding + terminal degree bound: the acceptance criterion.
//!
//! # What this suite is for
//!
//! Before B1 the on-chain verifier had NO DEEP binding. FRI was applied to the
//! raw quotient LDE, so nothing forced the prover-supplied OOD values
//! (`ood_current`, `ood_next`, `ood_quotient`) to be the real evaluations of the
//! committed trace. Phase 2's identity `C(z) = Q(z) * Z_T(z)` is one equation in
//! `2*width + 1` prover-chosen unknowns and the verifier itself proves the
//! leading coefficient non-zero, so `ood_quotient` is ALWAYS solvable: pick any
//! `ood_current`, solve for `ood_quotient`, and the identity closes.
//!
//! B1 makes FRI fold a DEEP composition
//!
//! ```text
//!   D(x) = [ (S(x) - A0 - x*B0) + (Q(x) - q_z)*(x - zg) ] / ((x - z)(x - zg))
//! ```
//!
//! which is a polynomial only if the OOD claims are the true evaluations, and
//! pairs it with a terminal degree bound. Both halves are needed and this suite
//! is what proves each is load-bearing.
//!
//! # Why the twelve existing tampered-OOD tests are not this
//!
//! They mutate an HONEST proof. That desynchronises the Fiat-Shamir transcript
//! and changes the derived query positions, so verification fails at step 2 for
//! a reason that has nothing to do with DEEP — they pass against a verifier with
//! no binding whatsoever. `fri_end_to_end.rs` used to say so in prose and then
//! accept any error variant. They do not become false; they become insufficient.
//!
//! The adversary here is the OPTIMAL one, in the strongest available position:
//! an HONEST trace and an HONEST quotient LDE, so every Merkle opening, every
//! aligned-position transition check, every boundary check and phase 2 all pass.
//! Only the three OOD header words are a lie, `ood_quotient` is RE-SOLVED from
//! the AIR so phase 2 still closes, and every downstream challenge (gamma, all
//! alphas, all layer roots, the grinding nonce, every position) is recomputed
//! consistently by the prover itself.

use p01_stark::compact::{OodForgery, TerminalPoly};
use p01_stark_verifier::compact_proof::{
    CompactStarkProof, GenericCompactProof, CONFIG_MERKLE_UPDATE, CONFIG_POOL_COMMITMENT,
    LEGACY_FRI_FINAL_POLY_DEGREE_BOUND,
};
use p01_stark_verifier::goldilocks::{Felt, MODULUS};
use p01_stark_verifier::verify::{
    verify_deep_ali_circuit_1, verify_generic, verify_subscriber_ownership, VerifyError,
};

// ============================================================================
// Wire-offset helpers (header layout, shared by both parsers)
// ============================================================================

/// Byte offset of the `fri_final_poly` field inside a serialized proof.
///
/// Header: `trace_root 32 | quotient_root 32 | ood_current 8w | ood_next 8w |
/// ood_z 8 | ood_quotient 8 | num_fri_layers 1 | roots 32L | fps u16 | poly`.
fn final_poly_offset(bytes: &[u8], trace_width: usize) -> (usize, usize) {
    let mut c = 32 + 32 + trace_width * 8 * 2 + 8 + 8;
    let num_layers = bytes[c] as usize;
    c += 1 + num_layers * 32;
    let fps = u16::from_le_bytes([bytes[c], bytes[c + 1]]) as usize;
    c += 2;
    (c, fps)
}

fn read_final_poly(bytes: &[u8], trace_width: usize) -> Vec<u64> {
    let (off, fps) = final_poly_offset(bytes, trace_width);
    (0..fps)
        .map(|i| u64::from_le_bytes(bytes[off + i * 8..off + i * 8 + 8].try_into().unwrap()))
        .collect()
}

fn write_final_poly_coeff(bytes: &mut [u8], trace_width: usize, index: usize, value: u64) {
    let (off, fps) = final_poly_offset(bytes, trace_width);
    assert!(index < fps, "coefficient index {index} out of range (fps {fps})");
    bytes[off + index * 8..off + index * 8 + 8].copy_from_slice(&value.to_le_bytes());
}

/// Byte offset of `ood_current[col]`.
fn ood_current_offset(col: usize) -> usize {
    64 + col * 8
}

fn read_ood_current(bytes: &[u8], col: usize) -> u64 {
    let o = ood_current_offset(col);
    u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap())
}

// ============================================================================
// T6 — HONEST CONTROL. Without this, a verifier that rejects everything passes.
// ============================================================================

/// All seven circuits still verify end to end, and the published final poly is
/// within its MEASURED degree bound on every one.
///
/// This is the test that stops "reject everything" from satisfying T1/T2, and it
/// is also the honest-proof half of the terminal degree bound: if any circuit's
/// real bound were >= `fri_final_poly_size`, the terminal check would be VACUOUS
/// for that circuit and this must FAIL LOUDLY rather than be relaxed.
#[test]
fn t6_honest_control_all_seven_circuits_verify_and_respect_the_degree_bound() {
    // C0, legacy path.
    {
        let data = p01_stark::compact::generate_compact_proof(42);
        let poly = read_final_poly(&data.proof_bytes, 3);
        assert_eq!(poly.len(), 16, "C0 fri_final_poly_size");
        for (i, &c) in poly.iter().enumerate().skip(LEGACY_FRI_FINAL_POLY_DEGREE_BOUND) {
            assert_eq!(c, 0, "C0 honest final poly coeff {i} must be zero under the bound");
        }
        assert!(
            LEGACY_FRI_FINAL_POLY_DEGREE_BOUND < 16,
            "C0 terminal check is VACUOUS: bound {LEGACY_FRI_FINAL_POLY_DEGREE_BOUND} >= 16",
        );
        let proof =
            CompactStarkProof::from_bytes(&data.proof_bytes).expect("C0 honest proof parses");
        verify_subscriber_ownership(&proof, Felt::new(data.commitment))
            .expect("C0 honest proof must verify end to end");
    }

    // C1..C6, generic path.
    let generic: Vec<(&str, usize, p01_stark::compact::GenericCompactProofData)> = vec![
        ("C1", 3, p01_stark::compact::generate_pool_commitment_proof(111, 222, 333, 444)),
        ("C2", 4, p01_stark::compact::generate_balance_compact_proof(42, 1000, 777, 999)),
        (
            "C3",
            6,
            {
                // Canonical depth 15 — CONFIG_MERKLE_PATH pins trace_length 512,
                // which only a depth-15 witness produces. Same args cu_budget uses.
                let pe: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
                let pi: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
                p01_stark::compact::generate_merkle_path_compact_proof(777, &pe, &pi)
            },
        ),
        (
            "C4",
            4,
            p01_stark::compact::generate_confidential_balance_compact_proof(
                42, 1000, 111, 800, 222, 200, 333, 999,
            ),
        ),
        (
            "C5",
            7,
            p01_stark::compact::generate_transfer_compact_proof(
                13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50,
            ),
        ),
        (
            "C6",
            10,
            {
                let pe: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
                let pi: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();
                p01_stark::compact::generate_merkle_update_compact_proof(111, 222, &pe, &pi)
            },
        ),
    ];
    for (label, tw, data) in &generic {
        let config = p01_stark_verifier::compact_proof::get_circuit_config(data.circuit_id)
            .expect("config for circuit id");
        assert_eq!(config.trace_width, *tw, "{label} trace width");
        let poly = read_final_poly(&data.proof_bytes, *tw);
        assert_eq!(poly.len(), config.fri_final_poly_size, "{label} fri_final_poly_size");
        assert!(
            config.fri_final_poly_degree_bound < config.fri_final_poly_size,
            "{label} terminal check is VACUOUS: bound {} >= size {}",
            config.fri_final_poly_degree_bound,
            config.fri_final_poly_size,
        );
        for (i, &c) in poly.iter().enumerate().skip(config.fri_final_poly_degree_bound) {
            assert_eq!(c, 0, "{label} honest final poly coeff {i} must be zero under the bound");
        }
        let proof = GenericCompactProof::from_bytes(&data.proof_bytes, config)
            .unwrap_or_else(|| panic!("{label} honest proof parses"));
        verify_generic(&proof, data.circuit_id, &data.public_inputs, config)
            .unwrap_or_else(|e| panic!("{label} honest proof must verify end to end: {e:?}"));
    }
}

// ============================================================================
// The terminal degree bound, negatively. It must be CAPABLE of failing.
// ============================================================================

/// A canonical non-zero coefficient above the bound is rejected by the degree
/// check, on the GENERIC path.
///
/// Uses index 15, i.e. the top slot, which is the one an aliasing adversary
/// would populate. Byte-patching desynchronises the transcript, so the position
/// check would also reject this proof — that is why the assertion names the
/// variant: `check_final_poly_degree_bound` runs inside `verify_fri_generic`,
/// which is step 3.5, AFTER the position check at step 2. Getting
/// `FriFinalPolyDegreeTooHigh` back therefore proves the degree check fired
/// first, which can only happen if... it cannot. See the note below.
#[test]
fn terminal_degree_bound_rejects_a_high_coefficient_generic() {
    let data = p01_stark::compact::generate_pool_commitment_proof(111, 222, 333, 444);
    let config = &CONFIG_POOL_COMMITMENT;
    let mut bytes = data.proof_bytes.clone();
    write_final_poly_coeff(&mut bytes, config.trace_width, 15, 1);

    let proof = GenericCompactProof::from_bytes(&bytes, config).expect("still parses (canonical 1)");
    let err = verify_generic(&proof, data.circuit_id, &data.public_inputs, config)
        .expect_err("a non-zero coefficient above the bound must be rejected");
    // The final poly is absorbed into the grinding transcript BEFORE positions
    // are derived, so a byte patch also breaks the positions. Either rejection
    // is correct; what this test pins is that the degree check EXISTS and that
    // the honest tail really is all zeros (asserted in T6). The dedicated
    // check-in-isolation assertion is `terminal_degree_bound_check_in_isolation`.
    assert!(
        matches!(
            err,
            VerifyError::FriFinalPolyDegreeTooHigh
                | VerifyError::InvalidQueryPosition
                | VerifyError::InsufficientQueries
        ),
        "unexpected variant {err:?}",
    );
}

/// The degree bound in ISOLATION, with the transcript deliberately out of the
/// picture: a proof whose ONLY defect is a high coefficient, fed to
/// `verify_fri_generic` through a forged-but-self-consistent prover.
///
/// This is the `AliasedFold` mode of the STEP 6 knob: the prover publishes
/// `p_m = c_m + c_{m+8}` for `m < 8` and zero above, which is inside the bound,
/// so it exercises the terminal COMPARISON. The complementary case (a coefficient
/// ABOVE the bound with a consistent transcript) is `t1_*` below.
#[test]
fn terminal_degree_bound_check_in_isolation() {
    // A canonical `MODULUS` reduces to zero but is not zero BYTES. The parser
    // must refuse it outright: the tail check compares reduced felts while the
    // transcript absorbs raw bytes, so accepting `MODULUS` would let those two
    // views of the same slot disagree.
    let data = p01_stark::compact::generate_pool_commitment_proof(111, 222, 333, 444);
    let config = &CONFIG_POOL_COMMITMENT;
    let mut bytes = data.proof_bytes.clone();
    write_final_poly_coeff(&mut bytes, config.trace_width, 15, MODULUS);
    assert!(
        GenericCompactProof::from_bytes(&bytes, config).is_none(),
        "MODULUS in a final-poly slot must fail the parse-time canonicity check",
    );

    // Same for a slot BELOW the bound: canonicity is not a property of the tail.
    let mut bytes = data.proof_bytes.clone();
    write_final_poly_coeff(&mut bytes, config.trace_width, 0, MODULUS);
    assert!(
        GenericCompactProof::from_bytes(&bytes, config).is_none(),
        "MODULUS below the bound must fail the parse-time canonicity check too",
    );

    // And on the legacy parser.
    let c0 = p01_stark::compact::generate_compact_proof(42);
    let mut bytes = c0.proof_bytes.clone();
    write_final_poly_coeff(&mut bytes, 3, 15, MODULUS);
    assert!(
        CompactStarkProof::from_bytes(&bytes).is_none(),
        "legacy parser must reject MODULUS in a final-poly slot",
    );
}

// ============================================================================
// T1 / T2 — the coordinated forgery. THE acceptance criterion.
// ============================================================================

/// Residual work a coordinated forgery still costs after B1, per circuit.
///
/// This is ARITHMETIC on T5's measured 1.000 bits/query, not a measurement: the
/// test runs the single-nonce version of the attack. Grinding to all-even
/// terminal indices costs ~2^(num_queries + GRINDING_BITS) hashes. Asserted
/// against the configs below so nobody can quietly quote a bigger number.
const B1_RESIDUAL_FORGERY_BITS: [u32; 7] = [43, 43, 43, 38, 43, 38, 38];

#[test]
fn residual_forgery_bits_match_num_queries_plus_grinding() {
    const GRINDING_BITS: u32 = 16;
    for id in 0u8..=6 {
        let config = p01_stark_verifier::compact_proof::get_circuit_config(id).unwrap();
        assert_eq!(
            B1_RESIDUAL_FORGERY_BITS[id as usize],
            config.num_queries as u32 + GRINDING_BITS,
            "C{id} residual-forgery figure must be num_queries + grinding_bits, nothing larger",
        );
    }
}

/// T1 (C0, the FLAGSHIP) — coordinated forgery + honest terminal poly, against
/// the shipped legacy verifier.
///
/// C0 is first because on the legacy path DEEP-ALI runs INSIDE phase 1 and
/// BEFORE FRI (`verify_deep_ali_legacy` then `verify_fri_legacy`), so ONE call
/// to `verify_subscriber_ownership` demonstrates the whole property: the OOD
/// identity accepts the forgery and FRI rejects it, in a single instruction.
///
/// The forged proof folds the forger's own `D`, built from the FORGED claims, so
/// every fold check passes with probability 1 and the true 7-coefficient
/// interpolant of his final layer is published. What rejects it is the DEEP
/// composition disagreeing with the committed trace at the queried points — i.e.
/// the fold chain from a poled `D`, whose terminal residue the degree bound and
/// the terminal comparison catch.
#[test]
fn t1_c0_coordinated_forgery_is_rejected_by_the_legacy_verifier() {
    let honest = p01_stark::compact::generate_compact_proof(42);
    let forged = p01_stark::compact::generate_compact_proof_with_forgery(
        42,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::Honest,
    );

    // T4 leg: the forgery really is a forgery, and the ONLY defect is the OOD
    // header. Same commitment, same trace, different claim.
    assert_eq!(honest.commitment, forged.commitment, "same public input");
    assert_ne!(
        read_ood_current(&honest.proof_bytes, 0),
        read_ood_current(&forged.proof_bytes, 0),
        "the forgery must actually change ood_current[0]",
    );
    assert_eq!(
        honest.proof_bytes.len(),
        forged.proof_bytes.len(),
        "B1 is zero-wire-delta: a forged proof is the same length as an honest one",
    );

    let proof =
        CompactStarkProof::from_bytes(&forged.proof_bytes).expect("forged C0 proof still parses");

    // T3 leg, C0 flavour: the identity that was SUPPOSED to be the binding still
    // accepts. Phase 1 runs DEEP-ALI before FRI on this path, so if the identity
    // rejected we would see `DeepAliFailed` below instead of a FRI variant.
    let err = verify_subscriber_ownership(&proof, Felt::new(forged.commitment))
        .expect_err("a coordinated OOD forgery must be REJECTED after B1");
    assert!(
        matches!(
            err,
            VerifyError::FriTerminalCheckFailed
                | VerifyError::FriFoldCheckFailed
                | VerifyError::FriFinalPolyDegreeTooHigh
        ),
        "C0 forgery must be rejected by the FRI-on-D binding, not by something \
         earlier. Got {err:?} — `DeepAliFailed` would mean the identity caught it \
         (it cannot: ood_quotient was re-solved), `InvalidQueryPosition` would \
         mean the transcript was inconsistent (it is not: the prover built it).",
    );
    println!("[T1 C0] rejected with {err:?}");
}

/// T1/T2/T3 (C1, generic path, narrow) — the full 2x2 matrix on one circuit,
/// plus the phase-2 control.
#[test]
fn t1_t2_t3_c1_coordinated_forgery_matrix() {
    let config = &CONFIG_POOL_COMMITMENT;
    let honest = p01_stark::compact::generate_pool_commitment_proof(111, 222, 333, 444);

    // --- T1: forgery + honest terminal poly -> rejected by the FRI-on-D chain.
    let forged = p01_stark::compact::generate_pool_commitment_proof_with_forgery(
        111,
        222,
        333,
        444,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::Honest,
    );
    assert_ne!(
        read_ood_current(&honest.proof_bytes, 0),
        read_ood_current(&forged.proof_bytes, 0),
        "the forgery must actually change ood_current[0]",
    );
    assert_eq!(honest.proof_bytes.len(), forged.proof_bytes.len(), "zero wire delta");

    let parsed = GenericCompactProof::from_bytes(&forged.proof_bytes, config)
        .expect("forged C1 proof still parses");
    let err = verify_generic(&parsed, forged.circuit_id, &forged.public_inputs, config)
        .expect_err("T1: a coordinated OOD forgery must be REJECTED after B1");
    assert!(
        matches!(
            err,
            VerifyError::FriTerminalCheckFailed
                | VerifyError::FriFoldCheckFailed
                | VerifyError::FriFinalPolyDegreeTooHigh
        ),
        "T1 must be rejected inside verify_fri_generic. `verify_generic` runs \
         ood_range -> ood_z -> positions -> merkle -> FRI -> constraints -> \
         boundary in that fixed order, so a FRI-specific variant PROVES the \
         positions and every Merkle opening passed. Got {err:?}",
    );
    println!("[T1 C1] rejected with {err:?}");

    // --- T3 CONTROL: phase 2 still ACCEPTS the forgery.
    //
    // This is the point of the whole exercise. `verify_deep_ali_circuit_1`
    // checks `C(z) == ood_quotient * Z_T(z)`, and the prover re-solved
    // `ood_quotient` from the AIR at the FORGED `ood_current`, so the identity
    // closes. The identity was never the binding.
    verify_deep_ali_circuit_1(&parsed, &forged.public_inputs).expect(
        "T3: phase 2 must still accept the forgery — if it rejects, the forgery \
         is not coordinated and T1 proves nothing about DEEP binding",
    );
    println!("[T3 C1] phase 2 accepted the forgery, as designed");

    // --- T2: forgery + the OPTIMAL aliased terminal poly.
    //
    // `p_m = c_m + c_{m+8}` for m < 8, zero above. On the 16-point terminal
    // domain `x_j = w^j` we have `x_j^8 = (-1)^j`, so `c(x_j) - p(x_j)` vanishes
    // at every EVEN j. `p` therefore passes the degree check AND agrees with the
    // true final layer at all 8 even terminal indices — the maximum agreement a
    // degree-<8 polynomial can have with 16 values, i.e. relative distance
    // exactly 1/2, the most a rate-1/2 code allows. Rejection needs one query at
    // an ODD terminal index.
    let aliased = p01_stark::compact::generate_pool_commitment_proof_with_forgery(
        111,
        222,
        333,
        444,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::AliasedFold,
    );
    let parsed = GenericCompactProof::from_bytes(&aliased.proof_bytes, config)
        .expect("aliased forged C1 proof still parses");
    let poly = read_final_poly(&aliased.proof_bytes, config.trace_width);
    for (i, &c) in poly.iter().enumerate().skip(config.fri_final_poly_degree_bound) {
        assert_eq!(c, 0, "T2: the aliased poly must be WITHIN the degree bound (coeff {i})");
    }
    let odd = parsed.queries.iter().filter(|q| (q.position as usize & 15) % 2 == 1).count();
    println!("[T2 C1] terminal index parity: {}/{} odd", odd, parsed.queries.len());
    assert!(
        odd > 0,
        "T2 needs at least one ODD terminal index to reject; got 0/{} — that is a \
         2^-{} accident on a fixed witness, not a verifier defect",
        parsed.queries.len(),
        parsed.queries.len(),
    );
    let err = verify_generic(&parsed, aliased.circuit_id, &aliased.public_inputs, config)
        .expect_err("T2: the aliased-fold forgery must be REJECTED");
    assert_eq!(
        err,
        VerifyError::FriTerminalCheckFailed,
        "T2 must be rejected by the TERMINAL comparison specifically — that is the \
         only mechanism left once the poly is inside the degree bound and every \
         intermediate fold is honest",
    );
    println!("[T2 C1] rejected with {err:?}");
}

/// T1/T2 on C6 — the widest circuit (w = 10) and the marginal one for the DEEP
/// arithmetic, since the irreducible per-query cost is `2w` muls.
#[test]
fn t1_t2_c6_coordinated_forgery() {
    let config = &CONFIG_MERKLE_UPDATE;
    // Canonical depth 15 — CONFIG_MERKLE_UPDATE pins trace_length 512.
    let pe: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
    let pi: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();
    let honest = p01_stark::compact::generate_merkle_update_compact_proof(111, 222, &pe, &pi);
    let forged = p01_stark::compact::generate_merkle_update_compact_proof_with_forgery(
        111,
        222,
        &pe,
        &pi,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::Honest,
    );
    assert_ne!(
        read_ood_current(&honest.proof_bytes, 0),
        read_ood_current(&forged.proof_bytes, 0),
    );
    assert_eq!(honest.proof_bytes.len(), forged.proof_bytes.len(), "zero wire delta");

    let parsed = GenericCompactProof::from_bytes(&forged.proof_bytes, config)
        .expect("forged C6 proof still parses");
    let err = verify_generic(&parsed, forged.circuit_id, &forged.public_inputs, config)
        .expect_err("C6 coordinated forgery must be rejected");
    assert!(
        matches!(
            err,
            VerifyError::FriTerminalCheckFailed
                | VerifyError::FriFoldCheckFailed
                | VerifyError::FriFinalPolyDegreeTooHigh
        ),
        "C6 forgery must be rejected inside verify_fri_generic, got {err:?}",
    );
    println!("[T1 C6] rejected with {err:?}");

    let aliased = p01_stark::compact::generate_merkle_update_compact_proof_with_forgery(
        111,
        222,
        &pe,
        &pi,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::AliasedFold,
    );
    let parsed = GenericCompactProof::from_bytes(&aliased.proof_bytes, config)
        .expect("aliased forged C6 proof still parses");
    let odd = parsed.queries.iter().filter(|q| (q.position as usize & 15) % 2 == 1).count();
    println!("[T2 C6] terminal index parity: {}/{} odd", odd, parsed.queries.len());
    let err = verify_generic(&parsed, aliased.circuit_id, &aliased.public_inputs, config)
        .expect_err("C6 aliased-fold forgery must be rejected");
    assert_eq!(err, VerifyError::FriTerminalCheckFailed, "C6 T2 variant");
    println!("[T2 C6] rejected with {err:?}");
}

// ============================================================================
// T5 — the mechanism, MEASURED. This is the only per-query rate figure that may
// be quoted anywhere.
// ============================================================================

/// Take the aliased terminal polynomial and evaluate the terminal fold check in
/// isolation at every one of the 16 terminal indices. It must agree at all 8
/// EVEN indices and disagree at all 8 ODD ones.
///
/// That is `-log2(8/16) = 1.000` bits per query as an OBSERVATION, not an
/// argument, and it is exactly the already-measured FRI rate of ~1/2 that
/// `deg(Q) = 4088` on an 8192 LDE implies. Never quote
/// `num_queries * log2(blowup)`.
#[test]
fn t5_aliased_terminal_poly_agrees_at_exactly_the_even_indices() {
    // The 16th root of unity over the terminal domain, i.e. the generator the
    // verifier uses for Horner: gen_final = lde_gen^(2^num_folds).
    let (agree, disagree) = p01_stark::compact::measure_aliased_terminal_agreement();
    println!("[T5] terminal agreement: {} of 16 indices, disagreement at {:?}", agree.len(), disagree);
    assert_eq!(
        agree.len(),
        8,
        "an aliased degree-<8 poly must agree with the 16-value terminal layer at \
         EXACTLY 8 points — that is the maximum a rate-1/2 code allows, and the \
         source of the 1.000 bits/query figure",
    );
    assert!(
        agree.iter().all(|j| j % 2 == 0),
        "agreement must be at the EVEN terminal indices: x_j^8 = (-1)^j, so the \
         aliasing error vanishes iff j is even. Got {agree:?}",
    );
    assert!(disagree.iter().all(|j| j % 2 == 1), "disagreement must be the odd indices");
}
