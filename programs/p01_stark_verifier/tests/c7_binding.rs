//! [C7] What binds a spend proof to the spend it is paying for.
//!
//! # Why this file exists, and why it could not exist a week ago
//!
//! `C7_SPEND_CIRCUIT_PLAN.md` Step 5 lists ten mandatory forgeries. Five of them
//! are properties of the QUOTIENT and were written prover-side in
//! `stark/src/compact.rs`: forge a trace, run the real quotient builder over it,
//! require the DEEP-ALI identity to fail.
//!
//! Forgeries 6, 7 and 9 are not like that. They are properties of
//! **serialisation and of Fiat-Shamir** — of what the verifier re-derives and
//! what it merely trusts — and `compact.rs:5136` records that they were left
//! out because they "cannot be asserted against a verifier that does not exist
//! yet". The verifier exists now (`verify_deep_ali_circuit_7`), so they land
//! here, against the real thing.
//!
//! Forgery 8 of the plan — "a query landing in rows 96-511 must not be treated
//! as an active round" — is deliberately ABSENT, and its absence is guarded
//! elsewhere rather than here. The plan assumed C7 would carry a per-query
//! `active_rows` check like C3's. It must not: rows 384..510 are the blinding
//! region, and any per-query constraint there forces the prover to write a
//! constant across them, which collapses col 9's unknown count from ~138 to
//! ~12 against the R = 90 evaluations the wire publishes. That is the
//! underdetermination depth 12 was adopted to buy.
//! `verify::tests::c7_phase1_arm_is_retired_post_b7` is the pin on that, and it
//! is a stronger statement than the forgery the plan asked for.
//!
//! # The shape every negative here follows
//!
//! A negative test is worth nothing without the positive control beside it: if
//! the honest proof did not verify, every rejection below would be vacuous and
//! the file would be green for the wrong reason. So
//! `an_honest_spend_proof_passes_both_phases` runs first in spirit, and each
//! forgery is a ONE-FIELD mutation away from it.
//!
//! # MEASURED BY MUTATION 2026-08-25 — every guard here is load-bearing
//!
//! A file of green negative tests proves nothing until each one has been seen
//! to go red. Three guards in `verify.rs` were disabled one at a time and the
//! suite re-run:
//!
//! ```text
//!   guard disabled                              tests that went red
//!   ─────────────────────────────────────────   ──────────────────────────────
//!   get_boundary_assertions' arity check        a_public_input_count_…   (1)
//!   the OOD-z re-derivation (verify.rs:1159)    changing_any_limb_…      (1)
//!   the DEEP-ALI identity for circuit 7         a_tampered_ood_current_… (2)
//!                                               a_tampered_ood_quotient_…
//! ```
//!
//! Each mutation reddens exactly the test that names it, and no other.
//!
//! 🧠 Two results worth keeping. First, disabling the OOD-z re-derivation left
//! `substituting_a_different_recipient_is_rejected` GREEN — the four-limb swap
//! is caught a second time by the phase-2 boundary fold. That is real defence in
//! depth, and it is also why the limb-by-limb test asserts the EXACT error:
//! without that, one guard could rot behind the other indefinitely. Second, the
//! belt-and-braces arity pair is not symmetric — see the note on the arity test.
//!
//! Run: `cargo test --release -p p01_stark_verifier --test c7_binding`

mod common;

use p01_stark_verifier::compact_proof::{get_circuit_config, GenericCompactProof};
use p01_stark_verifier::verify::{verify_deep_ali_circuit_7, verify_generic, VerifyError};

const CIRCUIT_SPEND: u8 = 7;

/// One honest C7 proof, parsed, with its public inputs.
///
/// Witness index is a parameter so a test that needs two DIFFERENT honest
/// proofs can have them — `common::w7` varies the nullifier preimage, the
/// secret, the path and the mask with `i`.
fn honest(i: usize) -> (Vec<u8>, Vec<u64>) {
    let w = common::w7(i);
    let data = common::prove7(&w);
    assert_eq!(data.circuit_id, CIRCUIT_SPEND, "the generator returned the wrong circuit");
    assert_eq!(data.public_inputs.len(), 6, "C7 publishes exactly six felts");
    (data.proof_bytes, data.public_inputs)
}

fn parse(bytes: &[u8]) -> GenericCompactProof {
    let config = get_circuit_config(CIRCUIT_SPEND).expect("circuit 7 must have a config");
    GenericCompactProof::from_bytes(bytes, config).expect("an honest C7 proof must parse")
}

/// Both phases, the way `lib.rs` sequences them for a real spend.
fn verify_both(bytes: &[u8], public_inputs: &[u64]) -> Result<(), VerifyError> {
    let config = get_circuit_config(CIRCUIT_SPEND).expect("config");
    let proof = GenericCompactProof::from_bytes(bytes, config).ok_or(VerifyError::UnsupportedCircuit)?;
    verify_generic(&proof, CIRCUIT_SPEND, public_inputs, config)?;
    verify_deep_ali_circuit_7(&proof, public_inputs)
}

// ============================================================================
// THE POSITIVE CONTROL — without this the whole file is vacuous
// ============================================================================

/// 🚨 READ THIS BEFORE TRUSTING ANY REJECTION BELOW.
///
/// Every other test in this file asserts that something is REFUSED. A verifier
/// that refuses everything passes all of them. This is the test that says the
/// refusals are discriminating.
#[test]
fn an_honest_spend_proof_passes_both_phases() {
    for i in 0..4 {
        let (bytes, pi) = honest(i);
        verify_both(&bytes, &pi)
            .unwrap_or_else(|e| panic!("honest C7 witness {i} was rejected: {e:?}"));
    }
}

/// [Plan forgery 10] A blinding that is a real, small epoch value must still
/// prove and verify.
///
/// ⛔ This is not hygiene. The pool holds an unspent note at leaf 30 whose
/// blinding IS a small epoch, from before blinding was randomised. Any range
/// check added to the blinding slot — "a blinding should look random" — bricks
/// that note permanently, and the money is not recoverable by any other path.
#[test]
fn a_legacy_small_blinding_still_proves_and_verifies() {
    use p01_stark::air::spend::{CANONICAL_DEPTH, MASK_LEN, TRACE_WIDTH};
    const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;

    let path_elements: Vec<u64> = (0..CANONICAL_DEPTH as u64).map(|j| 1000 + j * 37).collect();
    let path_indices: Vec<u8> = (0..CANONICAL_DEPTH).map(|j| (j % 2) as u8).collect();
    let mut st = 0x9E37_79B9_7F4A_7C15u64;
    let mut mask = Vec::with_capacity(MASK_LEN);
    for _ in 0..(MASK_LEN) {
        st ^= st >> 12;
        st ^= st << 25;
        st ^= st >> 27;
        mask.push(st.wrapping_mul(0x2545_F491_4F6C_DD1D) % GOLDILOCKS);
    }

    // 1, 2 and 3 are epoch-shaped. 0 is included because a "must be non-zero"
    // check is the other plausible range check someone would add.
    for blinding in [0u64, 1, 2, 3, 42] {
        let data = p01_stark::compact::generate_spend_compact_proof(
            42, 999, blinding, 555, &path_elements, &path_indices, &[11, 22, 33, 44], &mask,
        );
        verify_both(&data.proof_bytes, &data.public_inputs).unwrap_or_else(|e| {
            panic!(
                "a spend with blinding {blinding} was rejected ({e:?}). If a range check was \
                 just added to the blinding slot, it has bricked the leaf-30 note."
            )
        });
    }
}

// ============================================================================
// FORGERY 6 — recipient malleability
// ============================================================================

/// 🚨 THE FORGERY THAT WOULD MAKE THE RECIPIENT BINDING DECORATIVE.
///
/// C7 publishes `sha256(recipient_pubkey)` as public inputs 2..6. They occupy
/// no trace column and no constraint — `air/spend.rs` says the binding is
/// "Fiat-Shamir-transcript-only, exactly as C3's `depth` is". A reader can
/// reasonably ask what enforces that, since nothing in the AIR mentions it.
///
/// The answer is `verify_generic`: it rebuilds `pub_bytes` from the public
/// inputs the CALLER passes and re-derives the OOD point and the query
/// positions from them (`verify.rs:1158` and `:1171`), then compares against
/// what the proof carries. So a relayer holding a valid proof cannot re-point
/// the payout: changing any limb moves `z` and the proof stops verifying.
///
/// Each limb is mutated INDEPENDENTLY. A test that only flipped all four at
/// once would stay green if three of them were dropped from `pub_bytes`.
#[test]
fn changing_any_limb_of_the_recipient_hash_is_rejected() {
    let (bytes, pi) = honest(0);
    verify_both(&bytes, &pi).expect("control: the unmutated proof must verify");

    for limb in 2..6usize {
        let mut forged = pi.clone();
        forged[limb] = forged[limb].wrapping_add(1);
        let err = verify_both(&bytes, &forged).expect_err(&format!(
            "recipient_hash limb {limb} was changed and the proof STILL verified — that limb is \
             not in `pub_bytes`, so a relayer can re-point the payout of a proof it is relaying"
        ));
        // Named, not merely "some error": the rejection has to come from the
        // transcript re-derivation, which is what the binding claim rests on.
        assert_eq!(
            err,
            VerifyError::OodConstraintFailed,
            "limb {limb} was rejected, but not by the OOD re-derivation ({err:?}). The binding \
             claim in air/spend.rs is specifically that pub_bytes moves z."
        );
    }
}

/// Swapping the whole recipient for another one — the realistic shape of the
/// attack, rather than a one-bit nudge.
#[test]
fn substituting_a_different_recipient_is_rejected() {
    let (bytes, pi) = honest(1);
    let mut forged = pi.clone();
    // A different pubkey's digest: four unrelated limbs at once.
    forged[2] = 0xDEAD_BEEF_0000_0001;
    forged[3] = 0xDEAD_BEEF_0000_0002;
    forged[4] = 0xDEAD_BEEF_0000_0003;
    forged[5] = 0xDEAD_BEEF_0000_0004;
    assert!(
        verify_both(&bytes, &forged).is_err(),
        "a proof was accepted for a recipient it was not generated for"
    );
}

// ============================================================================
// FORGERY 7 — public-input arity
// ============================================================================

/// [Plan forgery 7] `public_inputs.len() != 6` must be refused by phase 2.
///
/// The plan's reasoning: phase 1 does not enforce arity, and
/// `get_boundary_assertions` used to zero-fill missing entries, so a short
/// vector could reach the boundary fold and bind FEWER public inputs than C7
/// has. For C7 an unbound public input is not cosmetic — inputs 0 and 1 are the
/// nullifier and the subtree root, and leaving either unbound means a forged
/// nullifier and a chosen root both verify.
///
/// 🚨 MEASURED, AND THE MEASUREMENT CORRECTED THIS COMMENT. Two guards stand
/// there and they are NOT equal partners. Deleting the explicit
/// `assertions.len() != 6` check inside `verify_deep_ali_circuit_7` leaves this
/// test GREEN: `get_boundary_assertions` already refuses a wrong arity with
/// `PublicInputCountMismatch` before any arm can reach its zero-fill fallback,
/// so it is the load-bearing guard and the inner check is the belt to its
/// braces — which is exactly what its own comment claims to be.
///
/// So the assertions below name `PublicInputCountMismatch` instead of accepting
/// any error. Accepting "some error" is how a test stays green against a
/// verifier that rejects for the wrong reason — the note on `VerifyError`
/// itself says so, and this file would otherwise have been an example of it.
#[test]
fn a_public_input_count_other_than_six_is_rejected_by_phase_two() {
    let (bytes, pi) = honest(2);
    let proof = parse(&bytes);
    verify_deep_ali_circuit_7(&proof, &pi).expect("control: six inputs must verify");

    // Short: every truncation, not just one.
    for n in 0..6usize {
        let err = verify_deep_ali_circuit_7(&proof, &pi[..n]).unwrap_err();
        assert_eq!(
            err,
            VerifyError::PublicInputCountMismatch,
            "phase 2 was handed {n} public inputs instead of 6 and answered {err:?}. With fewer \
             than six bound, a forged nullifier or a chosen subtree root verifies — and the \
             rejection has to come from the arity guard, not from arithmetic that happens to \
             disagree."
        );
    }

    // Long: a surplus must not be silently ignored either.
    let mut long = pi.clone();
    long.push(0);
    let err = verify_deep_ali_circuit_7(&proof, &long).unwrap_err();
    assert_eq!(
        err,
        VerifyError::PublicInputCountMismatch,
        "phase 2 was handed 7 public inputs and answered {err:?} — a surplus that is ignored is a \
         field the caller can set freely while the proof still verifies"
    );
}

// ============================================================================
// FORGERY 9 — the standard quartet
// ============================================================================

/// A single tampered byte in the OOD trace evaluations must break DEEP-ALI.
///
/// Mirrors the six sibling tests in `verify.rs` (`*_deep_ali_fails_on_tampered_ood_current`),
/// which C7 had no counterpart to.
#[test]
fn a_tampered_ood_current_byte_is_rejected() {
    let (bytes, pi) = honest(3);
    let config = get_circuit_config(CIRCUIT_SPEND).expect("config");
    let honest_proof =
        GenericCompactProof::from_bytes(&bytes, config).expect("honest proof must parse");
    verify_deep_ali_circuit_7(&honest_proof, &pi).expect("control: the honest proof must verify");

    let offset = ood_current_offset(&bytes, &pi);
    let mut tampered = bytes.clone();
    tampered[offset] ^= 0x01;
    match GenericCompactProof::from_bytes(&tampered, config) {
        Some(p) => assert!(
            verify_deep_ali_circuit_7(&p, &pi).is_err(),
            "one flipped bit in ood_current still verified — the DEEP-ALI identity is not \
             actually reading these evaluations"
        ),
        // A parse refusal is also a rejection, and an earlier one.
        None => {}
    }
}

/// The same, on the OOD quotient segments. These are the right-hand side of the
/// identity, so a verifier that computed `c_total` correctly and then compared
/// it against nothing would pass the test above and fail this one.
#[test]
fn a_tampered_ood_quotient_byte_is_rejected() {
    let (bytes, pi) = honest(3);
    let config = get_circuit_config(CIRCUIT_SPEND).expect("config");

    let offset = ood_quotient_offset(&bytes, &pi);
    let mut tampered = bytes.clone();
    tampered[offset] ^= 0x01;
    match GenericCompactProof::from_bytes(&tampered, config) {
        Some(p) => assert!(
            verify_deep_ali_circuit_7(&p, &pi).is_err(),
            "one flipped bit in the OOD quotient still verified"
        ),
        None => {}
    }
}

/// The two public inputs that are NOT the recipient: the nullifier and the
/// subtree root. Changing either must be refused.
///
/// This is the pool-drain in its shortest form — a chosen root is "I built my
/// own twelve levels", a chosen nullifier is "I spend under a name of my
/// choosing".
#[test]
fn a_forged_nullifier_or_subtree_root_is_rejected() {
    let (bytes, pi) = honest(0);

    for (idx, what) in [(0usize, "nullifier"), (1usize, "subtree root")] {
        let mut forged = pi.clone();
        forged[idx] = forged[idx].wrapping_add(1);
        assert!(
            verify_both(&bytes, &forged).is_err(),
            "a proof verified with a forged {what} — this is the pool drain"
        );
    }
}

/// Two honest proofs must not be interchangeable: proof for witness A verified
/// against the public inputs of witness B must fail.
///
/// Distinct from the single-field mutations above, because both sides are
/// individually well-formed and internally consistent. Only the pairing is
/// wrong.
#[test]
fn one_witnesss_proof_does_not_verify_another_witnesss_public_inputs() {
    let (bytes_a, pi_a) = honest(0);
    let (bytes_b, pi_b) = honest(1);
    assert_ne!(pi_a, pi_b, "the two witnesses must differ or this test is vacuous");

    assert!(
        verify_both(&bytes_a, &pi_b).is_err(),
        "witness A's proof verified against witness B's public inputs"
    );
    assert!(
        verify_both(&bytes_b, &pi_a).is_err(),
        "witness B's proof verified against witness A's public inputs"
    );
}

// ============================================================================
// Locating the two OOD regions in the wire
// ============================================================================

/// Byte offset of the first OOD trace evaluation.
///
/// Derived from the parsed proof rather than from a hard-coded literal: the
/// layout is `stark/src/compact.rs`'s business and a literal here would rot
/// silently into "flip a byte in some field, any field", which passes for the
/// wrong reason.
fn ood_current_offset(bytes: &[u8], public_inputs: &[u64]) -> usize {
    locate_ood(bytes, public_inputs).0
}

fn ood_quotient_offset(bytes: &[u8], public_inputs: &[u64]) -> usize {
    locate_ood(bytes, public_inputs).1
}

/// `(ood_current_start, ood_quotient_start)` found by matching the parsed
/// values back into the byte string.
///
/// The proof serialises field elements as 8-byte little-endian words, so the
/// first occurrence of `ood_current[0]`'s bytes is the region's start. Asserted
/// unique-enough by requiring both regions to be found and to differ.
fn locate_ood(bytes: &[u8], _public_inputs: &[u64]) -> (usize, usize) {
    let config = get_circuit_config(CIRCUIT_SPEND).expect("config");
    let proof = GenericCompactProof::from_bytes(bytes, config).expect("must parse");

    let first_current = proof.ood_current_iter().next().expect("ood_current is empty").as_u64();
    let first_quotient =
        proof.ood_quotient_iter().next().expect("ood_quotient is empty").as_u64();

    let find = |needle: u64, label: &str| -> usize {
        let n = needle.to_le_bytes();
        bytes
            .windows(8)
            .position(|w| w == n)
            .unwrap_or_else(|| panic!("could not locate {label} in the wire — the serialisation \
                                       changed and this helper is now pointing at nothing"))
    };

    let a = find(first_current, "ood_current[0]");
    let b = find(first_quotient, "ood_quotient[0]");
    assert_ne!(a, b, "the two OOD regions resolved to the same offset");
    (a, b)
}
