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
    CompactStarkProof, GenericCompactProof, CONFIG_BALANCE_PROOF, CONFIG_CONFIDENTIAL_BALANCE,
    CONFIG_MERKLE_PATH, CONFIG_MERKLE_UPDATE, CONFIG_POOL_COMMITMENT, CONFIG_TRANSFER,
    LEGACY_FRI_FINAL_POLY_DEGREE_BOUND,
};
use p01_stark_verifier::goldilocks::{Felt, MODULUS};
use p01_stark_verifier::verify::{
    verify_deep_ali_circuit_1, verify_deep_ali_circuit_2, verify_deep_ali_circuit_3,
    verify_deep_ali_circuit_4, verify_deep_ali_circuit_5, verify_deep_ali_circuit_6,
    verify_generic, verify_subscriber_ownership, VerifyError,
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
/// # Where the rejection actually fires, MEASURED
///
/// The forged proof folds the forger's own `D`, built from the FORGED claims, so
/// every per-query fold identity WOULD pass and the true interpolant of his final
/// layer is published honestly. But `D`'s numerator no longer vanishes at `z` or
/// `z*g` once the OOD header is a lie, so `D` is a rational function with poles
/// rather than a polynomial, and the interpolant of its terminal layer spills
/// past C0's degree bound of 7. `check_final_poly_degree_bound` sees that spill.
/// It runs ONCE per proof at the top of `verify_fri_legacy`, BEFORE the
/// transcript, the inverse table, the DEEP setup, PASS 1 and PASS 2 — so this
/// proof never reaches a single per-query fold check.
///
/// That is measured, not argued. `eprintln!` probes in
/// `check_final_poly_degree_bound` and at the head of the legacy PASS 1 and
/// PASS 2 loops, in a throwaway worktree, on this exact test:
///
/// ```text
/// running 1 test
/// test t1_c0_coordinated_forgery_is_rejected_by_the_legacy_verifier ...
/// [verify] final poly coeff 7 non-zero, bound is 7
/// [INSTR] check_final_poly_degree_bound REJECT coeff 7 bound 7
/// [T1 C0] rejected with FriFinalPolyDegreeTooHigh
/// ok
/// ```
///
/// Zero `PASS 1` lines, zero `PASS 2` lines. The same probes on
/// `t2_legacy_c0_subgroup_alias_reaches_the_terminal_check` print 27 `PASS 1`
/// lines and one `PASS 2` line before `FriTerminalCheckFailed`. That test, not
/// this one, is what puts the legacy per-query fold chain under negative
/// coverage; the coverage table at the end of this file records the split and
/// this block used to contradict it.
///
/// The `matches!` below therefore accepts three variants on purpose. Which of
/// them fires is a property of how far past the bound a given circuit's forged
/// terminal interpolant spills, not of the binding, and pinning one variant here
/// would make an unrelated change to `deg(D)` read as a soundness regression.
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

/// T1/T2/T3 on C6 — the widest circuit (w = 10) and the marginal one for the
/// DEEP arithmetic, since the irreducible per-query cost is `2w` muls.
///
/// C6 does not go through `run_generic_forgery_case` because its witness is a
/// path rather than a scalar tuple, which is exactly how it ended up as the one
/// generic circuit with NO phase-2 control: the shared helper carries the T3 leg
/// and this test did not. The leg is written out inline below, and the coverage
/// table now has a phase-2 column so the same gap cannot reopen silently.
#[test]
fn t1_t2_t3_c6_coordinated_forgery() {
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

    // --- T3 CONTROL: phase 2 still ACCEPTS the forgery.
    //
    // Without this leg the T1 assertion above only says that SOMETHING rejected
    // the proof. `verify_deep_ali_circuit_6` is the identity the DEEP fold
    // replaced as the binding, and `solve_ood_quotient_for_spec`'s C6 arm is the
    // widest of the seven (w = 10, so the solve carries 20 OOD unknowns). A
    // wrong solve surfaces HERE as `DeepAliFailed` and NOWHERE else, because the
    // honest trace and honest quotient satisfy every other check in the
    // pipeline — which would make T1 a rejection of a broken proof rather than
    // of a coordinated forgery.
    phase2(forged.circuit_id, &parsed, &forged.public_inputs).unwrap_or_else(|e| {
        panic!(
            "C6 T3: phase 2 must STILL ACCEPT the forgery, got {e:?}. That means \
             solve_ood_quotient_for_spec's C6 arm is WRONG — the forgery is not \
             coordinated and the T1 leg above proves nothing about DEEP binding."
        )
    });
    println!("[T3 C6] phase 2 accepted the forgery, as designed");

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
// T1 / T2 / T3 on the remaining generic circuits — C2, C3, C4, C5.
// ============================================================================

/// Phase 2 for a generic circuit, by id. Phase 2 is the identity that was
/// SUPPOSED to be the binding; every generic T3 leg in this file requires it to
/// still ACCEPT the forgery — C6 above, C2..C5 through
/// `run_generic_forgery_case` below. C1 calls `verify_deep_ali_circuit_1`
/// directly because its matrix test predates this dispatcher.
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

/// One circuit's two-legged acceptance case, in the shape
/// `t1_t2_t3_c1_coordinated_forgery_matrix` already uses, so adding a circuit
/// costs a witness and one call.
///
/// **T4 preamble.** The forgery is a forgery and its ONLY defect is the OOD
/// header: same public inputs, different `ood_current[0]`, identical length.
///
/// **T1.** Coordinated forgery + HONEST terminal poly, which must be REJECTED.
/// `verify_generic` runs ood_range -> ood_z -> positions -> merkle -> FRI ->
/// constraints -> boundary in that fixed order, so a FRI-specific variant proves
/// the positions and every Merkle opening passed and the rejection came from the
/// DEEP binding rather than from a desynchronised transcript.
///
/// **T3 control**, between the legs. Phase 2 must STILL ACCEPT the forgery. This
/// is what makes T1 mean anything: a forgery phase 2 rejects is not coordinated.
/// It is also the ONLY check on a freshly written `solve_ood_quotient_for_spec`
/// arm — a wrong solve surfaces here as `DeepAliFailed` and nowhere else, because
/// every other check in the pipeline is satisfied by the honest trace.
///
/// **T2.** The same forgery with the aliased terminal poly, which is INSIDE the
/// degree bound, so the degree check cannot fire and the only mechanism left is
/// the terminal comparison. The variant is pinned exactly, not by `matches!`.
fn run_generic_forgery_case(
    label: &str,
    config: &p01_stark_verifier::compact_proof::CircuitConfig,
    honest: &p01_stark::compact::GenericCompactProofData,
    forged: &p01_stark::compact::GenericCompactProofData,
    aliased: &p01_stark::compact::GenericCompactProofData,
) {
    // --- T4 preamble.
    assert_eq!(
        honest.public_inputs, forged.public_inputs,
        "{label}: the forgery must keep the SAME public inputs — a different \
         statement is not a forgery",
    );
    assert_ne!(
        read_ood_current(&honest.proof_bytes, 0),
        read_ood_current(&forged.proof_bytes, 0),
        "{label}: the forgery must actually change ood_current[0]",
    );
    assert_eq!(
        honest.proof_bytes.len(),
        forged.proof_bytes.len(),
        "{label}: B1 is zero-wire-delta — a forged proof is the same length as an \
         honest one",
    );

    // --- T1.
    let parsed = GenericCompactProof::from_bytes(&forged.proof_bytes, config)
        .unwrap_or_else(|| panic!("{label}: forged proof still parses"));
    let err = match verify_generic(&parsed, forged.circuit_id, &forged.public_inputs, config) {
        Ok(()) => panic!(
            "{label} T1: a coordinated OOD forgery must be REJECTED after B1. It was \
             ACCEPTED, which is the PRE-B1 behaviour: FRI folding the raw quotient \
             binds nothing, so the OOD claims can be anything."
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
        "{label} T1 must be rejected inside verify_fri_generic. Got {err:?} — \
         `DeepAliFailed` would mean phase 2 caught it (it cannot: ood_quotient was \
         re-solved), `InvalidQueryPosition` would mean the transcript was \
         inconsistent (it is not: the prover built it).",
    );
    println!("[T1 {label}] rejected with {err:?}");

    // --- T3 control.
    phase2(forged.circuit_id, &parsed, &forged.public_inputs).unwrap_or_else(|e| {
        panic!(
            "{label} T3: phase 2 must STILL ACCEPT the forgery, got {e:?}. That means \
             solve_ood_quotient_for_spec's arm for this circuit is WRONG — the \
             forgery is not coordinated and T1 above proves nothing about DEEP \
             binding."
        )
    });
    println!("[T3 {label}] phase 2 accepted the forgery, as designed");

    // --- T2.
    let parsed = GenericCompactProof::from_bytes(&aliased.proof_bytes, config)
        .unwrap_or_else(|| panic!("{label}: aliased forged proof still parses"));
    let poly = read_final_poly(&aliased.proof_bytes, config.trace_width);
    for (i, &c) in poly.iter().enumerate().skip(config.fri_final_poly_degree_bound) {
        assert_eq!(c, 0, "{label} T2: the aliased poly must be WITHIN the bound (coeff {i})");
    }
    let odd = parsed.queries.iter().filter(|q| (q.position as usize & 15) % 2 == 1).count();
    println!("[T2 {label}] terminal index parity: {}/{} odd", odd, parsed.queries.len());
    assert!(
        odd > 0,
        "{label} T2 needs at least one ODD terminal index to reject; got 0/{} — that \
         is a 2^-{} accident on a fixed witness, not a verifier defect",
        parsed.queries.len(),
        parsed.queries.len(),
    );
    let err = match verify_generic(&parsed, aliased.circuit_id, &aliased.public_inputs, config) {
        Ok(()) => panic!("{label} T2: the aliased-fold forgery must be REJECTED, it was ACCEPTED"),
        Err(e) => e,
    };
    assert_eq!(
        err,
        VerifyError::FriTerminalCheckFailed,
        "{label} T2 must be rejected by the TERMINAL comparison specifically — that \
         is the only mechanism left once the poly is inside the degree bound and \
         every intermediate fold is honest",
    );
    println!("[T2 {label}] rejected with {err:?}");
}

/// T1/T2/T3 on C2 (balance_proof).
///
/// C2 is one of the two circuits with NO boundary fold at the OOD point
/// (`boundary_spec_for_quotient` returns `None`), so `boundary_c_at_ood_impl`
/// contributes nothing to the solve and the public inputs bind the trace least
/// well of the seven. That makes the DEEP composition the only thing standing
/// between a forged OOD header and acceptance here.
#[test]
fn t1_t2_t3_c2_coordinated_forgery() {
    let config = &CONFIG_BALANCE_PROOF;
    let honest = p01_stark::compact::generate_balance_compact_proof(42, 1000, 777, 999);
    let forged = p01_stark::compact::generate_balance_compact_proof_with_forgery(
        42,
        1000,
        777,
        999,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::Honest,
    );
    let aliased = p01_stark::compact::generate_balance_compact_proof_with_forgery(
        42,
        1000,
        777,
        999,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::AliasedFold,
    );
    run_generic_forgery_case("C2", config, &honest, &forged, &aliased);
}

/// T1/T2/T3 on C3 (merkle_path).
///
/// Canonical depth 15 — `CONFIG_MERKLE_PATH` pins trace_length 512, which only a
/// depth-15 witness produces, and `depth` is the 3rd public input, folded into
/// the transcript. `solve_ood_quotient_for_spec` reads it back out of
/// `QuotientSpec::Circuit3 { depth }` to rebuild the periodic columns, so a depth
/// mismatch would show up as a T3 failure.
#[test]
fn t1_t2_t3_c3_coordinated_forgery() {
    let config = &CONFIG_MERKLE_PATH;
    let pe: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
    let pi: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
    let honest = p01_stark::compact::generate_merkle_path_compact_proof(777, &pe, &pi);
    let forged = p01_stark::compact::generate_merkle_path_compact_proof_with_forgery(
        777,
        &pe,
        &pi,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::Honest,
    );
    let aliased = p01_stark::compact::generate_merkle_path_compact_proof_with_forgery(
        777,
        &pe,
        &pi,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::AliasedFold,
    );
    run_generic_forgery_case("C3", config, &honest, &forged, &aliased);
}

/// T1/T2/T3 on C4 (confidential_balance) — the CU-binding circuit.
///
/// C4 carries the highest measured phase-1 base of the seven and, like C2, has no
/// boundary fold. It is also the sharpest version-skew case (`trace_width == 4`,
/// so `16 * trace_width - 64 == 0`), which is why it is worth having both the
/// Route C probe and the B1 probe pointed at it.
#[test]
fn t1_t2_t3_c4_coordinated_forgery() {
    let config = &CONFIG_CONFIDENTIAL_BALANCE;
    let honest = p01_stark::compact::generate_confidential_balance_compact_proof(
        42, 1000, 111, 800, 222, 200, 333, 999,
    );
    let forged = p01_stark::compact::generate_confidential_balance_compact_proof_with_forgery(
        42,
        1000,
        111,
        800,
        222,
        200,
        333,
        999,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::Honest,
    );
    let aliased = p01_stark::compact::generate_confidential_balance_compact_proof_with_forgery(
        42,
        1000,
        111,
        800,
        222,
        200,
        333,
        999,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::AliasedFold,
    );
    run_generic_forgery_case("C4", config, &honest, &forged, &aliased);
}

/// T1/T2/T3 on C5 (transfer) — the widest boundary fold.
///
/// C5 has 26 boundary assertions, including the two value-conservation terms on
/// col 6, and it is the only circuit whose periodic columns come back at MIXED
/// lengths (four period-32, 24 full-length). The solve has to tile the short ones
/// onto the trace domain before interpolating, exactly as
/// `compute_quotient_lde_circuit_5` does; if it did not, the T3 leg would reject.
#[test]
fn t1_t2_t3_c5_coordinated_forgery() {
    let config = &CONFIG_TRANSFER;
    let honest = p01_stark::compact::generate_transfer_compact_proof(
        13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50,
    );
    let forged = p01_stark::compact::generate_transfer_compact_proof_with_forgery(
        13,
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
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::Honest,
    );
    let aliased = p01_stark::compact::generate_transfer_compact_proof_with_forgery(
        13,
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
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::AliasedFold,
    );
    run_generic_forgery_case("C5", config, &honest, &forged, &aliased);
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

// ============================================================================
// [DEFECT 4] The LEGACY fold chain, negatively.
// ============================================================================

/// A C0 forgery that gets PAST the once-per-proof degree check and is therefore
/// forced through the whole legacy fold chain.
///
/// Every C0 negative case in the repo before this one rejected at
/// `check_final_poly_degree_bound`, which `verify_fri_legacy` calls ONCE per
/// proof and BEFORE the transcript, the inverse table, the DEEP setup, PASS 1 and
/// PASS 2. MEASURED, printed by
/// `t1_c0_coordinated_forgery_is_rejected_by_the_legacy_verifier` itself:
/// `[T1 C0] rejected with FriFinalPolyDegreeTooHigh`. So the legacy per-query
/// DEEP arithmetic — the SOLE verifier for four shipped instructions
/// (`zk_shielded::{pause,resume,cancel_private_stark}` and `p01_quantum_wallet`)
/// — was reached by honest proofs only, and the two implementation details the
/// design pass named as most likely to be wrong there had no negative coverage:
///
///   * the `(lo, hi)` swap at `pos >= LDE_SIZE/2`, at two sites (the quotient
///     pair, and the trace/mirror pair inside the gamma loop);
///   * `y = -inv_gen_0_powers[half - j]` and its `j == 0` special case, which
///     exists because index `half` is one past the end of a 256-entry table and
///     would be a BPF panic rather than a clean `VerifyError`.
///
/// `TerminalPoly::AliasedFold` cannot be built on this path at all: it asserts
/// `bound * 2 == fps`, and C0 is bound 7 of fps 16, so the prover panics.
/// `SubgroupAlias` publishes `c mod (x^4 - 1)` — degree < 4, comfortably inside
/// the bound of 7 — so the degree check PASSES and the verifier has to run the
/// whole chain.
///
/// # What this leg does and does not prove
///
/// `FriTerminalCheckFailed` is returned at exactly ONE place in
/// `verify_fri_legacy`: the `i == num_fri_layers` arm of the fold loop. Getting it
/// back proves PASS 1 ran for every query and PASS 2 ran the entire fold chain for
/// at least one. It is NOT independent evidence of DEEP binding: the terminal
/// comparison would reject an aliased terminal poly with or without the DEEP fold,
/// because the prover published a polynomial that is not the interpolant of the
/// layer he committed to. C0's DEEP-binding evidence is the T1 leg above, and the
/// coverage table at the end of this file keeps the two claims apart.
#[test]
fn t2_legacy_c0_subgroup_alias_reaches_the_terminal_check() {
    let honest = p01_stark::compact::generate_compact_proof(42);
    let forged = p01_stark::compact::generate_compact_proof_with_forgery(
        42,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::SubgroupAlias,
    );
    assert_eq!(honest.commitment, forged.commitment, "same public input");
    assert_ne!(
        read_ood_current(&honest.proof_bytes, 0),
        read_ood_current(&forged.proof_bytes, 0),
        "the forgery must actually change ood_current[0]",
    );
    assert_eq!(honest.proof_bytes.len(), forged.proof_bytes.len(), "zero wire delta");

    // The published poly is INSIDE the bound, so the degree check CANNOT be what
    // rejects this proof. Assert that directly instead of inferring it from the
    // returned variant.
    let poly = read_final_poly(&forged.proof_bytes, 3);
    assert_eq!(poly.len(), 16, "C0 fri_final_poly_size");
    for (i, &c) in poly.iter().enumerate().skip(LEGACY_FRI_FINAL_POLY_DEGREE_BOUND) {
        assert_eq!(c, 0, "SubgroupAlias must be within C0's bound of 7 (coeff {i})");
    }
    // ...and it really is the k = 4 reduction, not some degree-6 polynomial.
    for (i, &c) in poly.iter().enumerate().skip(4) {
        assert_eq!(c, 0, "SubgroupAlias on C0 reduces mod x^4 - 1, so coeff {i} must be zero");
    }
    assert!(
        poly[..4].iter().any(|&c| c != 0),
        "a degenerate all-zero terminal poly would reject for the wrong reason",
    );

    let proof = CompactStarkProof::from_bytes(&forged.proof_bytes)
        .expect("subgroup-aliased forged C0 proof still parses");

    // Rejection needs one query whose terminal index is NOT 0 mod 4 — those four
    // of sixteen are exactly where the aliased poly agrees with the true layer.
    let outside = proof.queries.iter().filter(|q| (q.position as usize & 15) % 4 != 0).count();
    println!(
        "[T2 C0-legacy] terminal index residues: {}/{} outside the k=4 subgroup",
        outside,
        proof.queries.len(),
    );
    assert!(
        outside > 0,
        "needs at least one terminal index outside {{0,4,8,12}} to reject; got 0/{} — \
         that is a 4^-{} accident on a fixed witness, not a verifier defect",
        proof.queries.len(),
        proof.queries.len(),
    );

    // What PASS 1 actually covers on this proof. PASS 1 computes `y` for EVERY
    // query before PASS 2 runs, so the whole position set drives the y lookup even
    // though PASS 2 returns on the first failing query.
    let j_zero = proof.queries.iter().filter(|q| (q.position as usize & 255) == 0).count();
    let high_half = proof.queries.iter().filter(|q| (q.position as usize) >= 256).count();
    println!(
        "[T2 C0-legacy] PASS 1 y-lookup coverage on {} queries: {j_zero} at j == 0, \
         {high_half} in the high half",
        proof.queries.len(),
    );

    let err = verify_subscriber_ownership(&proof, Felt::new(forged.commitment))
        .expect_err("a subgroup-aliased C0 forgery must be REJECTED");
    assert_eq!(
        err,
        VerifyError::FriTerminalCheckFailed,
        "the rejection must come from the TERMINAL comparison, which is the only \
         thing left once the poly is inside the degree bound and every intermediate \
         fold was built honestly by the forger. `FriFinalPolyDegreeTooHigh` would \
         mean the proof never entered the fold chain, which is the exact gap this \
         test exists to close.",
    );
    println!("[T2 C0-legacy] rejected with {err:?}");
}

/// MEASURE what `SubgroupAlias` is worth per query on the LEGACY path.
///
/// This is a SEPARATE figure from T5's 1.000 bits/query and must never be quoted
/// as one. T5 measures the `bound == fps/2` case on the generic path: 8 agreeing
/// indices of 16. C0's bound is 7 of 16, so the largest usable subgroup is k = 4
/// and the agreement is 4 of 16, i.e. 2.000 bits per query. Higher is WORSE for
/// the adversary, so this neither improves nor weakens anything B2 will have to
/// say about the generic path; it is a second, independent number.
#[test]
fn t5b_subgroup_alias_terminal_agreement_on_the_legacy_path() {
    let (agree, disagree) = p01_stark::compact::measure_subgroup_alias_terminal_agreement_c0();
    println!(
        "[T5b] legacy terminal agreement: {} of 16 indices, agreement at {:?}, \
         disagreement at {:?}",
        agree.len(),
        agree,
        disagree,
    );
    assert_eq!(
        agree.len(),
        4,
        "c mod (x^4 - 1) agrees with the true 16-value terminal layer at exactly the \
         4 points where x^4 = 1",
    );
    assert!(agree.iter().all(|j| j % 4 == 0), "agreement must be at j = 0 mod 4, got {agree:?}");
    assert!(disagree.iter().all(|j| j % 4 != 0), "disagreement must be everything else");
}

/// `SubgroupAlias` and `AliasedFold` are the SAME play when the bound is exactly
/// half the published size: `k == fps/2`, and `c mod (x^8 - 1)` is precisely
/// `p_m = c_m + c_{m+8}`.
///
/// Asserted on C1 so the generalisation cannot silently diverge from the variant
/// T5 measures. If these two ever produce different bytes, one of them has been
/// changed and T5's 1.000 bits/query no longer describes what `SubgroupAlias`
/// does on the generic path.
#[test]
fn subgroup_alias_equals_aliased_fold_when_the_bound_is_half_the_size() {
    let a = p01_stark::compact::generate_pool_commitment_proof_with_forgery(
        111,
        222,
        333,
        444,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::AliasedFold,
    );
    let b = p01_stark::compact::generate_pool_commitment_proof_with_forgery(
        111,
        222,
        333,
        444,
        OodForgery::Coordinated { col: 0, delta: 1 },
        TerminalPoly::SubgroupAlias,
    );
    assert_eq!(
        a.proof_bytes, b.proof_bytes,
        "on C1 (bound 8 of fps 16) the two terminal plays are the same polynomial, \
         so the two proofs must be byte-identical",
    );
}

/// The legacy per-query DEEP arithmetic, POSITIVELY, at the two query positions
/// that separate a correct implementation from the two most likely wrong ones.
///
/// Neither is reachable through a FORGED proof: PASS 2 returns on the first query
/// that fails the terminal comparison, so a rejection exercises one query's fold
/// chain, not the whole position set. An HONEST proof runs PASS 2 to completion
/// for every query, so the honest side is what pins these.
///
///   * `pos & 255 == 0` drives the `j == 0` branch of the `y` lookup. Without the
///     branch the index would be `half_lde`, one past the end of a 256-entry
///     table — an out-of-bounds panic on chain, not a `VerifyError`. Only 2 of
///     512 positions qualify, so roughly 90% of C0 proofs never touch it. The
///     seed is SEARCHED rather than assumed, and the search bound is asserted.
///   * `pos >= 256` drives both `(lo, hi)` swaps. Inverting either verifies for
///     the low half and fails for the high half, which reads as a ~50% prover
///     flake; this assertion is what turns it into a test failure.
#[test]
fn legacy_c0_honest_proofs_cover_the_j_zero_and_high_half_query_positions() {
    const SEARCH_LIMIT: u64 = 400;
    let mut found: Option<(u64, usize, usize)> = None;
    for seed in 1..=SEARCH_LIMIT {
        let data = p01_stark::compact::generate_compact_proof(seed);
        let proof = CompactStarkProof::from_bytes(&data.proof_bytes)
            .unwrap_or_else(|| panic!("honest C0 proof for seed {seed} must parse"));
        let j_zero = proof.queries.iter().filter(|q| (q.position as usize & 255) == 0).count();
        let high = proof.queries.iter().filter(|q| (q.position as usize) >= 256).count();
        if j_zero > 0 && high > 0 {
            verify_subscriber_ownership(&proof, Felt::new(data.commitment)).unwrap_or_else(|e| {
                panic!(
                    "seed {seed}: an HONEST C0 proof with a query at position 0 or 256 \
                     must verify, got {e:?}. That is the j == 0 branch of the y lookup \
                     or one of the two (lo, hi) swaps being wrong."
                )
            });
            found = Some((seed, j_zero, high));
            break;
        }
    }
    let (seed, j_zero, high) = found.expect(
        "no seed in 1..=400 produced a C0 proof with a query at position 0 or 256. \
         Each proof has roughly a 10% chance, so 400 consecutive misses is about \
         2^-60 — that is position derivation having changed, not a flake.",
    );
    println!(
        "[LEGACY POS] seed {seed}: {j_zero} queries with (pos & 255) == 0, {high} in the \
         high half"
    );
}

// ============================================================================
// One-sided-fix tripwire, in the style of `route_c_trace_pair.rs`.
// ============================================================================

const VERIFY_SRC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/verify.rs");
const EMBEDDED_VERIFY_SRC: &str = include_str!("../src/verify.rs");

/// The DEEP derivation, as literal source text. TWO call sites, one per FRI
/// function: `verify_fri_generic` and `verify_fri_legacy`.
const DEEP_CALL_SITE: &str = "let gamma = derive_deep_coeff(&base_seed);";
const DEEP_CALL_SITES_EXPECTED: usize = 2;

/// The terminal degree bound, likewise. TWO call sites.
const BOUND_CALL_SITE: &str = "check_final_poly_degree_bound(";
/// One definition plus two call sites.
const BOUND_OCCURRENCES_EXPECTED: usize = 3;

/// A generic-only B1 must not be able to land silently.
///
/// The legacy C0 path is the SOLE verifier for four shipped instructions
/// (`zk_shielded::{pause,resume,cancel_private_stark}` and
/// `p01_quantum_wallet/src/stark.rs`). If the DEEP derivation were removed from
/// it — or never added — those four would stay exactly as forgeable as they were
/// before B1, and every honest-proof test in this repo would still be green,
/// because the prover and verifier would simply agree to fold the quotient.
///
/// Same rationale as `all_four_trace_authentication_call_sites_are_present` in
/// `route_c_trace_pair.rs`, which was MEASURED to catch a concurrent process
/// deleting all four trace-authentication blocks: a source-text count is the one
/// assertion that still means something when the crate does not compile, and it
/// makes a half-restored tree legible rather than merely broken.
#[test]
fn both_fri_paths_derive_the_deep_coefficient_and_check_the_degree_bound() {
    let on_disk = std::fs::read_to_string(VERIFY_SRC_PATH)
        .unwrap_or_else(|e| panic!("cannot read {VERIFY_SRC_PATH}: {e}"));

    assert_eq!(
        on_disk, EMBEDDED_VERIFY_SRC,
        "\n\n  >>> STALE TEST BINARY <<<\n  {VERIFY_SRC_PATH} on disk differs from the \
         copy compiled into this exe ({} bytes on disk, {} compiled in). Rebuild and \
         require a literal `Compiling p01_stark_verifier` line before believing any \
         result from this file.\n",
        on_disk.len(),
        EMBEDDED_VERIFY_SRC.len(),
    );

    let deep = on_disk.matches(DEEP_CALL_SITE).count();
    assert_eq!(
        deep, DEEP_CALL_SITES_EXPECTED,
        "\n\n  >>> DEEP BINDING MISSING FROM A FRI PATH <<<\n  {VERIFY_SRC_PATH} contains \
         {deep} `{DEEP_CALL_SITE}` call sites, expected {DEEP_CALL_SITES_EXPECTED} (one in \
         verify_fri_generic, one in verify_fri_legacy).\n  With one gone, that path folds \
         the raw quotient again and a coordinated OOD forgery is ACCEPTED there. The \
         legacy path is the sole verifier for four shipped instructions.\n",
    );

    let bound = on_disk.matches(BOUND_CALL_SITE).count();
    assert_eq!(
        bound, BOUND_OCCURRENCES_EXPECTED,
        "\n\n  >>> TERMINAL DEGREE BOUND MISSING <<<\n  {VERIFY_SRC_PATH} contains {bound} \
         `{BOUND_CALL_SITE}` occurrences, expected {BOUND_OCCURRENCES_EXPECTED} (the \
         definition plus one call per FRI path).\n  Without it the DEEP binding buys \
         EXACTLY ZERO bits: an adversary folds his own composition honestly and publishes \
         its true 16-coefficient interpolant, and every check passes.\n",
    );
}

// ============================================================================
// [B1 STEP 10] CROSS-LANGUAGE FIXTURE DIGEST — the merge blocker.
// ============================================================================

/// SHA-256 of the serialized proof bytes for two fixed witnesses.
///
/// # Why no existing gate can substitute for this
///
/// `packages/stark-prover/wasm/p01_stark_bg.wasm` is a git-tracked,
/// npm-published, PREBUILT binary — the prover every client actually runs,
/// inlined as base64 into four more tracked files. It is built from `stark/`,
/// which B1 modifies, and nothing in the repo regenerates it automatically.
///
/// B1 is LENGTH-PRESERVING. So against a stale blob:
///   * `stark-wasm-twins.mjs --check` stays green — it only proves the five
///     copies agree with each other;
///   * `wireFormat.test.ts` stays green — it only pins proof LENGTHS, and those
///     are byte-identical before and after B1;
///   * every Rust-side test stays green — they drive the Rust prover.
///
/// Meanwhile every client-generated proof is rejected by the new verifier with
/// `FriFoldCheckFailed`. That is not a parse error and not a length mismatch: the
/// layout is byte-identical while the CONTENT is semantically incompatible,
/// because post-B1 layer roots and the final poly commit folds of `D` rather than
/// of `Q`. This is the same failure the repo already suffered pre-Route-C
/// (MEASURED: the blob emitted 79,993 B for C0 against a Rust prover emitting
/// 45,001, undetected because the only assertion was `toBeGreaterThan(1024)`).
///
/// A content digest is the only check that catches prover/verifier semantic skew
/// at constant length. The SEVEN constants below are the same seven pinned on
/// the TypeScript side in `packages/stark-prover/src/wireFormat.test.ts`
/// (`Pin.sha256`), driving the checked-in WASM, over the same seven witnesses.
/// If the two languages disagree, one of them is stale.
///
/// Until this round the Rust side pinned only C0 and C1 while the TypeScript
/// side pinned all seven. A `stark/src/compact.rs` change that moved C2 through
/// C6 proof bytes therefore broke nothing on the Rust side, and the only thing
/// standing between that and a shipped skew was a TypeScript suite that has to
/// be run against a freshly built WASM blob to mean anything.
///
/// # Why a digest is legitimate here
///
/// Proof generation is fully deterministic: `grind_nonce` starts at nonce 0 and
/// increments, and there is no `rand`, `thread_rng` or `SystemTime` anywhere in
/// `stark/src/compact.rs`. `fixture_proofs_are_deterministic` asserts that
/// directly rather than assuming it, on all seven.
///
/// `FIXTURE_C0_SHA256` and `FIXTURE_C1_SHA256` keep their names because
/// `wireFormat.test.ts` cites both by name.
const FIXTURE_C0_SHA256: &str =
    "e4aad1058b8cdb5aa7fd488e0e7dce29820566d934e8b9cf56ef2e09a397efa7";
const FIXTURE_C1_SHA256: &str =
    "935d918c0a6f06691b24568de75fc174586e02c09dc0ac27f2f14537bdef4e9b";
const FIXTURE_C2_SHA256: &str =
    "063d86a18071ae369132c12a69c5af0e3c2efbe82f6340e6d7ec910be80fd49f";
const FIXTURE_C3_SHA256: &str =
    "2d97f56ffc3157fe7c644679d2945130efed8ea39c890a24c6c16022e78d5d9c";
const FIXTURE_C4_SHA256: &str =
    "f877836723d0711e7190c2fd5c8a5c6d0476f21794d39ffd47a075f57d53e3e7";
const FIXTURE_C5_SHA256: &str =
    "78afe9bbd533913771d5c2438e279934114fe4c6db934b67b43c0644376ea125";
const FIXTURE_C6_SHA256: &str =
    "8e1166f5d08bd948bc70a407d9261d6b88c1de5b257c4545918d9c36d94524fc";

fn hex32(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

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
    let pe: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
    let pi: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
    p01_stark::compact::generate_merkle_path_compact_proof(777, &pe, &pi).proof_bytes
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
    let pe: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
    let pi: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();
    p01_stark::compact::generate_merkle_update_compact_proof(111, 222, &pe, &pi).proof_bytes
}

/// One row per circuit. `len` is the same literal `wireFormat.test.ts` pins as
/// `Pin.absolute` and `route_c_trace_pair.rs` pins for C0; `sha256` is the same
/// literal it pins as `Pin.sha256`.
struct Fixture {
    label: &'static str,
    len: usize,
    sha256: &'static str,
    build: fn() -> Vec<u8>,
}

const FIXTURES: [Fixture; 7] = [
    Fixture { label: "C0", len: 45_001, sha256: FIXTURE_C0_SHA256, build: fixture_c0 },
    Fixture { label: "C1", len: 65_801, sha256: FIXTURE_C1_SHA256, build: fixture_c1 },
    Fixture { label: "C2", len: 66_681, sha256: FIXTURE_C2_SHA256, build: fixture_c2 },
    Fixture { label: "C3", len: 75_637, sha256: FIXTURE_C3_SHA256, build: fixture_c3 },
    Fixture { label: "C4", len: 78_377, sha256: FIXTURE_C4_SHA256, build: fixture_c4 },
    Fixture { label: "C5", len: 76_357, sha256: FIXTURE_C5_SHA256, build: fixture_c5 },
    Fixture { label: "C6", len: 78_517, sha256: FIXTURE_C6_SHA256, build: fixture_c6 },
];

#[test]
fn fixture_proofs_are_deterministic() {
    for f in FIXTURES.iter() {
        assert_eq!(
            (f.build)(),
            (f.build)(),
            "{} proof generation must be deterministic",
            f.label,
        );
    }
}

#[test]
fn cross_language_fixture_digests() {
    for f in FIXTURES.iter() {
        let bytes = (f.build)();
        let digest = hex32(&solana_sha256_hasher::hashv(&[&bytes]).to_bytes());
        println!("[FIXTURE] {} {} bytes sha256 {digest}", f.label, bytes.len());
        assert_eq!(bytes.len(), f.len, "{} fixture length pin", f.label);
        assert_eq!(
            digest, f.sha256,
            "\n\n  >>> {} FIXTURE DIGEST DRIFT <<<\n  The Rust prover's output changed. If \
             that was deliberate, RESHIP THE WASM PROVER and update BOTH this constant and \
             the `Pin.sha256` twin in packages/stark-prover/src/wireFormat.test.ts. Do not \
             update one of them.\n",
            f.label,
        );
    }
}

// ============================================================================
// [B1] PER-CIRCUIT COVERAGE TABLE
// ============================================================================

/// What is and is not covered, per circuit, for the coordinated-forgery
/// acceptance case. It lives HERE rather than only in a session report, so that
/// a gap is visible to the next reader of the tree.
///
/// The four claims are deliberately kept apart, because they are not the same
/// claim and two of them have been conflated before:
///
///   * `t1_forgery_rejected` — the coordinated forgery with an HONEST terminal
///     poly is rejected. This is the acceptance criterion.
///   * `t3_phase2_still_accepts` — phase 2, the identity that was SUPPOSED to be
///     the binding, still ACCEPTS the same forgery. Without it a T1 rejection
///     could just be a mis-built forgery: `solve_ood_quotient_for_spec`'s arm
///     for the circuit is the only thing that can be wrong, and a wrong solve
///     surfaces as `DeepAliFailed` and nowhere else.
///   * `t1_accepted_when_deep_disabled` — the SAME forgery is ACCEPTED once the
///     DEEP fold is reverted on both sides. Without this column the first one is
///     worthless: a test that passes before and after the revert proves nothing.
///     MEASURED, not argued; see the two experiments below.
///   * `t2_terminal_play_reaches_fold_chain` — a terminal play that is INSIDE
///     the degree bound, so the verifier is forced past the once-per-proof
///     `check_final_poly_degree_bound` and through the per-query fold chain to
///     the terminal comparison. This is NOT evidence of DEEP binding. MEASURED:
///     with the DEEP fold reverted, `t2_legacy_c0_subgroup_alias_reaches_the_terminal_check`
///     still PASSES, because an aliased terminal poly is rejected by the terminal
///     comparison whether FRI folded `D` or `Q`. Its value is that it puts the
///     legacy `(lo, hi)` swaps and the `-inv_table[half - j]` lookup under test.
///
/// # The two reverts behind the middle column, ONE variable each
///
/// An earlier version of this block recorded a single revert that moved the DEEP
/// fold AND the terminal degree bound together. That experiment cannot establish
/// the column it names: with two variables moved, an acceptance says only that at
/// least one of the two halves was load-bearing. Both experiments below were
/// re-run isolated, in a throwaway worktree at this commit, from a
/// `CARGO_TARGET_DIR` that did not exist yet, with a `Compiling p01_stark_verifier`
/// line in the same output.
///
/// **A. DEEP fold OFF, terminal degree bound fully ON.** Prover
/// (`stark/src/compact.rs`): both `fri_commit_phase(&deep_felts, ..)` call sites
/// back to `&quotient_felts`. Verifier
/// (`programs/p01_stark_verifier/src/verify.rs`): both
/// `let mut f_lo = brk_lo.add(qt_lo).mul(inv_lo) / f_hi = ..` back to
/// `f_lo = q_lo / f_hi = q_hi`. NOTHING else: `check_final_poly_degree_bound`
/// untouched with both call sites live, and both prover-side degree asserts
/// untouched.
///
/// ```text
/// test result: FAILED. 10 passed; 10 failed; 0 ignored; 0 measured; 0 filtered out
/// C2 T1: a coordinated OOD forgery must be REJECTED after B1. It was ACCEPTED, which
/// is the PRE-B1 behaviour: FRI folding the raw quotient binds nothing, so the OOD
/// claims can be anything.
/// ```
///
/// All seven T1 legs ACCEPTED: C0 and C1 and C6 as an `expect_err` on `Ok(())`
/// (`b1_deep_binding.rs:334`, `:376`, `:473`), C2 through C5 with the explicit
/// message above (`:576`). Two other results make that acceptance mean
/// something: `t6_honest_control_all_seven_circuits_verify_and_respect_the_degree_bound
/// ... ok`, so honest proofs still verified AND still satisfied the bound, and
/// `terminal_degree_bound_check_in_isolation ... ok`, so the bound was still
/// capable of failing. The forgeries were not accepted because the bound was
/// gone; they were accepted because folding `Q` binds nothing.
///
/// **B. DEEP fold ON, terminal degree bound OFF.** Verifier only, one hunk:
///
/// ```text
/// @@ fn check_final_poly_degree_bound(
///      degree_bound: usize,
///  ) -> Result<(), VerifyError> {
/// +    if true {
/// +        let _ = (final_poly_bytes, degree_bound);
/// +        return Ok(());
/// +    }
/// ```
///
/// The prover is untouched, so honest proofs still fold `D` and still satisfy the
/// bound they are no longer checked against.
///
/// ```text
/// test result: FAILED. 13 passed; 7 failed; 0 ignored; 0 measured; 0 filtered out
/// ```
///
/// The seven failures are EXACTLY the seven T1 legs, again all ACCEPTED.
/// `cross_language_fixture_digests ... ok` (the prover never moved) and
/// `t6_honest_control_all_seven_circuits_verify_and_respect_the_degree_bound ... ok`.
///
/// The pair is the whole claim: neither half rejects the coordinated forgery on
/// its own, on any of the seven circuits, and both together reject it on all
/// seven. The DEEP fold makes the forger commit to a function with poles; the
/// degree bound is what refuses to let him publish its terminal interpolant.
///
/// Note that `both_fri_paths_derive_the_deep_coefficient_and_check_the_degree_bound`
/// stayed GREEN under BOTH reverts. It counts SOURCE TEXT, so it catches a
/// deletion, not a behavioural neutering — which is exactly why this column is
/// measured by hand and written down rather than inferred from a green suite.
struct Coverage {
    id: u8,
    label: &'static str,
    /// Verifier entry point the negative case drives.
    path: &'static str,
    /// The prover can BUILD a coordinated forgery: `solve_ood_quotient_for_spec`
    /// has an arm (C1..C6), or the pipeline has an inline solve (C0).
    solve_implemented: bool,
    t1_forgery_rejected: bool,
    /// Phase 2 STILL ACCEPTS the same forgery, so the T1 rejection is a
    /// rejection of a COORDINATED forgery and not of a broken one.
    ///
    /// C1 through C6 establish this with a DIRECT call to
    /// `verify_deep_ali_circuit_N` on the forged proof. C0 establishes it
    /// STRUCTURALLY and cannot do otherwise: `verify_deep_ali_legacy` is private,
    /// and `verify_subscriber_ownership` calls it at step 4 and `verify_fri_legacy`
    /// at step 5, so getting a FRI variant back is itself proof that phase 2
    /// returned `Ok(())` first. The distinction is recorded in C0's note rather
    /// than hidden in a `true`.
    t3_phase2_still_accepts: bool,
    t1_accepted_when_deep_disabled: bool,
    t2_terminal_play_reaches_fold_chain: bool,
    /// Test names, checked against this file's own source text below, so
    /// deleting a test breaks the table instead of leaving it lying.
    t1_test: &'static str,
    t3_test: &'static str,
    t2_test: &'static str,
    note: &'static str,
}

const COVERAGE: [Coverage; 7] = [
    Coverage {
        id: 0,
        label: "C0 subscriber_ownership",
        path: "verify_subscriber_ownership (legacy)",
        solve_implemented: true,
        t1_forgery_rejected: true,
        t3_phase2_still_accepts: true,
        t1_accepted_when_deep_disabled: true,
        t2_terminal_play_reaches_fold_chain: true,
        t1_test: "t1_c0_coordinated_forgery_is_rejected_by_the_legacy_verifier",
        t3_test: "t1_c0_coordinated_forgery_is_rejected_by_the_legacy_verifier",
        t2_test: "t2_legacy_c0_subgroup_alias_reaches_the_terminal_check",
        note: "T1 rejects at FriFinalPolyDegreeTooHigh, i.e. BEFORE the fold chain \
               (instrumented: zero PASS 1 and zero PASS 2 lines). SubgroupAlias \
               (bound 7 of 16, k = 4) is what reaches it; AliasedFold cannot be \
               built here at all. T3 is STRUCTURAL, not a direct call: \
               verify_deep_ali_legacy is private and runs at step 4, FRI at step 5.",
    },
    Coverage {
        id: 1,
        label: "C1 pool_commitment",
        path: "verify_generic",
        solve_implemented: true,
        t1_forgery_rejected: true,
        t3_phase2_still_accepts: true,
        t1_accepted_when_deep_disabled: true,
        t2_terminal_play_reaches_fold_chain: true,
        t1_test: "t1_t2_t3_c1_coordinated_forgery_matrix",
        t3_test: "t1_t2_t3_c1_coordinated_forgery_matrix",
        t2_test: "t1_t2_t3_c1_coordinated_forgery_matrix",
        note: "Carries the T5 rate measurement and the SubgroupAlias / AliasedFold \
               equivalence check.",
    },
    Coverage {
        id: 2,
        label: "C2 balance_proof",
        path: "verify_generic",
        solve_implemented: true,
        t1_forgery_rejected: true,
        t3_phase2_still_accepts: true,
        t1_accepted_when_deep_disabled: true,
        t2_terminal_play_reaches_fold_chain: true,
        t1_test: "t1_t2_t3_c2_coordinated_forgery",
        t3_test: "t1_t2_t3_c2_coordinated_forgery",
        t2_test: "t1_t2_t3_c2_coordinated_forgery",
        note: "No boundary fold at the OOD point, so the public inputs bind least well.",
    },
    Coverage {
        id: 3,
        label: "C3 merkle_path",
        path: "verify_generic",
        solve_implemented: true,
        t1_forgery_rejected: true,
        t3_phase2_still_accepts: true,
        t1_accepted_when_deep_disabled: true,
        t2_terminal_play_reaches_fold_chain: true,
        t1_test: "t1_t2_t3_c3_coordinated_forgery",
        t3_test: "t1_t2_t3_c3_coordinated_forgery",
        t2_test: "t1_t2_t3_c3_coordinated_forgery",
        note: "Depth-carrying; the solve rebuilds periodic columns from QuotientSpec.",
    },
    Coverage {
        id: 4,
        label: "C4 confidential_balance",
        path: "verify_generic",
        solve_implemented: true,
        t1_forgery_rejected: true,
        t3_phase2_still_accepts: true,
        t1_accepted_when_deep_disabled: true,
        t2_terminal_play_reaches_fold_chain: true,
        t1_test: "t1_t2_t3_c4_coordinated_forgery",
        t3_test: "t1_t2_t3_c4_coordinated_forgery",
        t2_test: "t1_t2_t3_c4_coordinated_forgery",
        note: "The CU-binding circuit, and the second with no boundary fold.",
    },
    Coverage {
        id: 5,
        label: "C5 transfer",
        path: "verify_generic",
        solve_implemented: true,
        t1_forgery_rejected: true,
        t3_phase2_still_accepts: true,
        t1_accepted_when_deep_disabled: true,
        t2_terminal_play_reaches_fold_chain: true,
        t1_test: "t1_t2_t3_c5_coordinated_forgery",
        t3_test: "t1_t2_t3_c5_coordinated_forgery",
        t2_test: "t1_t2_t3_c5_coordinated_forgery",
        note: "Mixed-length periodic columns; the solve tiles them before interpolating.",
    },
    Coverage {
        id: 6,
        label: "C6 merkle_update",
        path: "verify_generic",
        solve_implemented: true,
        t1_forgery_rejected: true,
        t3_phase2_still_accepts: true,
        t1_accepted_when_deep_disabled: true,
        t2_terminal_play_reaches_fold_chain: true,
        t1_test: "t1_t2_t3_c6_coordinated_forgery",
        t3_test: "t1_t2_t3_c6_coordinated_forgery",
        t2_test: "t1_t2_t3_c6_coordinated_forgery",
        note: "Widest trace (w = 10) and the marginal case for the DEEP arithmetic. \
               Does not use run_generic_forgery_case, which is how it spent a whole \
               round as the one generic circuit with no phase-2 control.",
    },
];

const SELF_SRC: &str = include_str!("b1_deep_binding.rs");

/// The source text of one function in this file, from its `fn` line to the first
/// closing brace at column 0. Used to check that a row's claimed coverage is a
/// call this file really makes, not just a name that happens to exist.
fn test_body(name: &str) -> &'static str {
    let start = SELF_SRC
        .find(&format!("fn {name}("))
        .unwrap_or_else(|| panic!("no function named `{name}` in this file"));
    let rest = &SELF_SRC[start..];
    let end = rest.find("\n}\n").map(|e| e + 3).unwrap_or(rest.len());
    &rest[..end]
}

/// The coverage table must describe this file, not an aspiration.
///
/// Every claimed test name is checked against this file's own source text, and a
/// row that claims coverage without naming a test fails. That is the same
/// source-text technique the tripwire above uses, for the same reason: it is the
/// one assertion that still means something when someone deletes a test and the
/// suite goes green because there is less of it.
#[test]
fn coverage_table_describes_the_tests_that_actually_exist() {
    // The indirection C2..C5 rely on. If the shared helper ever loses its T3
    // leg, four rows would keep claiming a phase-2 control they no longer have.
    assert!(
        test_body("run_generic_forgery_case").contains("phase2("),
        "run_generic_forgery_case no longer calls `phase2(`, so C2..C5 claim a \
         phase-2 control that does not run",
    );

    println!(
        "\n  id  circuit                  path                                  solve  T1 rej  \
         T3 ph2 acc  T1 acc/no-DEEP  T2 fold-chain"
    );
    for (i, row) in COVERAGE.iter().enumerate() {
        assert_eq!(row.id as usize, i, "COVERAGE must be indexed by circuit id");
        println!(
            "  C{}  {:<24} {:<37} {:<6} {:<7} {:<11} {:<15} {}",
            row.id,
            row.label,
            row.path,
            row.solve_implemented,
            row.t1_forgery_rejected,
            row.t3_phase2_still_accepts,
            row.t1_accepted_when_deep_disabled,
            row.t2_terminal_play_reaches_fold_chain,
        );

        if row.t1_forgery_rejected {
            assert!(
                row.solve_implemented,
                "C{}: cannot reject a forgery the prover cannot build",
                row.id,
            );
            assert!(
                !row.t1_test.is_empty(),
                "C{}: claims the forgery is rejected but names no test",
                row.id,
            );
            assert!(
                SELF_SRC.contains(&format!("fn {}(", row.t1_test)),
                "C{}: names T1 test `{}`, which does not exist in this file",
                row.id,
                row.t1_test,
            );
        } else {
            assert!(row.t1_test.is_empty(), "C{}: names a T1 test but claims no coverage", row.id);
        }

        // The phase-2 column. C6 had a T1 leg and no T3 leg for a whole round;
        // this is the assertion that would have made that visible.
        if row.t3_phase2_still_accepts {
            assert!(
                row.t1_forgery_rejected,
                "C{}: 'phase 2 still accepts' is only meaningful next to a T1 rejection",
                row.id,
            );
            assert!(
                !row.t3_test.is_empty(),
                "C{}: claims phase 2 still accepts the forgery but names no test",
                row.id,
            );
            assert!(
                SELF_SRC.contains(&format!("fn {}(", row.t3_test)),
                "C{}: names T3 test `{}`, which does not exist in this file",
                row.id,
                row.t3_test,
            );
        } else {
            assert!(row.t3_test.is_empty(), "C{}: names a T3 test but claims no coverage", row.id);
        }

        // Every GENERIC row must actually run phase 2 in the test it names —
        // directly, through the `phase2` dispatcher, or through
        // `run_generic_forgery_case`, which carries the leg for C2..C5. Naming a
        // test that never calls it is precisely the C6 gap this column exists to
        // catch, and a `true` in the table cannot substitute for the call.
        //
        // C0 is exempt and says so in its own note: `verify_deep_ali_legacy` is
        // private, so C0's phase-2 evidence is the ORDER inside
        // `verify_subscriber_ownership`, not a call this file can make.
        if row.id != 0 && row.t3_phase2_still_accepts {
            let body = test_body(row.t3_test);
            assert!(
                body.contains("phase2(")
                    || body.contains("run_generic_forgery_case(")
                    || body.contains("verify_deep_ali_circuit_"),
                "C{}: `{}` claims a phase-2 control but never reaches phase 2. That is \
                 exactly the C6 gap this column exists to catch.",
                row.id,
                row.t3_test,
            );
        }

        if row.t2_terminal_play_reaches_fold_chain {
            assert!(
                !row.t2_test.is_empty(),
                "C{}: claims the fold chain is reached but names no test",
                row.id,
            );
            assert!(
                SELF_SRC.contains(&format!("fn {}(", row.t2_test)),
                "C{}: names T2 test `{}`, which does not exist in this file",
                row.id,
                row.t2_test,
            );
        } else {
            assert!(row.t2_test.is_empty(), "C{}: names a T2 test but claims no coverage", row.id);
        }

        // The middle column is the one that can only be produced by hand. It may
        // never be claimed for a circuit whose forgery is not even rejected.
        if row.t1_accepted_when_deep_disabled {
            assert!(
                row.t1_forgery_rejected,
                "C{}: 'accepted with DEEP disabled' is meaningless without a rejection \
                 to compare it against",
                row.id,
            );
        }
    }

    for row in COVERAGE.iter() {
        println!("  C{} note: {}", row.id, row.note);
    }
    let covered = COVERAGE.iter().filter(|r| r.t1_forgery_rejected).count();
    let phase2_ok = COVERAGE.iter().filter(|r| r.t3_phase2_still_accepts).count();
    let confirmed = COVERAGE.iter().filter(|r| r.t1_accepted_when_deep_disabled).count();
    let chain = COVERAGE.iter().filter(|r| r.t2_terminal_play_reaches_fold_chain).count();
    println!(
        "  acceptance coverage: {covered}/7 forgeries rejected, {phase2_ok}/7 with phase 2 \
         still ACCEPTING the same forgery, {confirmed}/7 confirmed ACCEPTED with the DEEP \
         fold reverted, {chain}/7 reaching the per-query fold chain\n"
    );
}
