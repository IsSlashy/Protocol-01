//! [B4] Pair-leaf Merkle commitment — fails-closed guard, then positive tests.
//!
//! # What B4 changed
//!
//! Every mirror opening in this proof system is an MSB flip inside its own
//! layer (`pos ^ (N/2)`), because `fri_fold_layer` consumes exactly `v[j]` and
//! `v[j + N/2]`. B4 commits that coset as ONE leaf:
//!
//! ```text
//!   leaf[j] = SHA256( v[j].to_le_bytes() || v[j + N/2].to_le_bytes() )
//! ```
//!
//! over `N/2` leaves instead of `H(v[t])` over `N`. Two depth-`d` openings
//! collapse into one depth-`(d-1)` opening that yields both values. This
//! applies to the quotient tree AND to every committed FRI layer, on the
//! prover and the on-chain verifier alike.
//!
//! # Why the mismatch test is the important one
//!
//! The prover and the verifier must agree on three things that never travel on
//! the wire: the pair index `j`, the order of the two halves inside the leaf,
//! and the path depth. If they ever drift, the only acceptable outcome is a
//! LOUD rejection of honest proofs — never a silent acceptance.
//!
//! `p01_stark::compact::PairIndexing` is a test-only knob that makes the
//! prover build a **complete, internally consistent** proof under a *different*
//! pair layout. The unmodified on-chain verifier must reject every one of them,
//! and must reject them at the Merkle step (`MerkleProofFailed`) — not
//! incidentally via some transcript mismatch, which would prove nothing about
//! the pair indexing.

use p01_stark::compact::PairIndexing;
use p01_stark_verifier::compact_proof::{
    CompactStarkProof, GenericCompactProof, CONFIG_POOL_COMMITMENT,
};
use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::{verify_generic, verify_subscriber_ownership, VerifyError};

// ============================================================================
// 1. FAILS CLOSED — a prover that indexes pairs differently is rejected
// ============================================================================

/// Generic (C1) path: every non-canonical pair layout must be rejected, and
/// rejected specifically by the Merkle check.
#[test]
fn generic_rejects_every_mismatched_pair_indexing() {
    // Quotient-tree layouts (caught by `verify_merkle_proofs_generic`) and
    // FRI-layer-only layouts (caught by `verify_fri_generic`, after the
    // quotient pair check has already passed).
    let modes = [
        PairIndexing::SwappedHalves,
        PairIndexing::RotatedSlot,
        PairIndexing::SwappedHalvesFriOnly,
        PairIndexing::RotatedSlotFriOnly,
    ];

    for mode in modes {
        let data = p01_stark::compact::generate_pool_commitment_proof_with_pair_indexing(
            0xDEADBEEF_u64,
            0xCAFEBABE_u64,
            7,
            0xA55A_u64,
            mode,
        );

        // The proof must still PARSE: the byte layout is unchanged, only the
        // tree layout differs. If it failed to parse we would not be testing
        // the indexing at all.
        let proof = GenericCompactProof::from_bytes(&data.proof_bytes, &CONFIG_POOL_COMMITMENT)
            .unwrap_or_else(|| panic!("{mode:?}: proof must still parse — same wire layout"));

        let err = verify_generic(
            &proof,
            data.circuit_id,
            &data.public_inputs,
            &CONFIG_POOL_COMMITMENT,
        )
        .expect_err(
            "a prover that indexes pair leaves differently from the verifier \
             must NOT produce an accepted proof",
        );

        assert!(
            matches!(err, VerifyError::MerkleProofFailed),
            "{mode:?}: expected MerkleProofFailed (the pair-leaf check), got {err:?}",
        );
    }
}

/// Legacy (C0) path has its own serializer, parser and FRI loop — guard it
/// separately or a drift there would go unnoticed.
#[test]
fn legacy_rejects_every_mismatched_pair_indexing() {
    let modes = [
        PairIndexing::SwappedHalves,
        PairIndexing::RotatedSlot,
        PairIndexing::SwappedHalvesFriOnly,
        PairIndexing::RotatedSlotFriOnly,
    ];

    for mode in modes {
        let data = p01_stark::compact::generate_compact_proof_with_pair_indexing(42, mode);

        let proof = CompactStarkProof::from_bytes(&data.proof_bytes)
            .unwrap_or_else(|| panic!("{mode:?}: legacy proof must still parse"));

        let err = verify_subscriber_ownership(&proof, Felt::new(data.commitment)).expect_err(
            "legacy: a prover that indexes pair leaves differently must NOT be accepted",
        );

        assert!(
            matches!(err, VerifyError::MerkleProofFailed),
            "{mode:?}: expected MerkleProofFailed, got {err:?}",
        );
    }
}

/// Wire-level guard, independent of the prover knob: swapping the two halves
/// of a quotient pair on the wire must break the leaf hash.
///
/// The verifier orders `(quotient_values[q], quotient_mirror_value)` into
/// `(lo, hi)` using `position < lde_size/2`. Overwriting `quotient_mirror_value`
/// with the value at `position` (and vice versa) is exactly what a verifier
/// that got the ordering backwards would hash — and it must be rejected.
#[test]
fn generic_rejects_wire_level_pair_half_swap() {
    let data = p01_stark::compact::generate_pool_commitment_proof(1, 2, 3, 4);
    let cfg = &CONFIG_POOL_COMMITMENT;

    // Sanity: the untouched proof verifies.
    {
        let proof = GenericCompactProof::from_bytes(&data.proof_bytes, cfg).expect("parse");
        verify_generic(&proof, data.circuit_id, &data.public_inputs, cfg)
            .expect("control: honest proof verifies");
    }

    // Swap the two halves of query 0's quotient pair by exchanging the wire
    // fields the verifier reads them from.
    let mut bytes = data.proof_bytes.clone();
    let (q0_mirror_off, tail_q0_off) = quotient_pair_offsets(cfg, &bytes);

    let mirror = read_u64(&bytes, q0_mirror_off);
    let at_pos = read_u64(&bytes, tail_q0_off);
    assert_ne!(
        mirror, at_pos,
        "degenerate fixture: the two halves happen to be equal, swap is a no-op",
    );
    write_u64(&mut bytes, q0_mirror_off, at_pos);
    write_u64(&mut bytes, tail_q0_off, mirror);

    let proof = GenericCompactProof::from_bytes(&bytes, cfg).expect("swapped proof still parses");
    let err = verify_generic(&proof, data.circuit_id, &data.public_inputs, cfg)
        .expect_err("a pair with its halves swapped must be rejected");
    assert!(
        matches!(err, VerifyError::MerkleProofFailed),
        "expected MerkleProofFailed, got {err:?}",
    );
}

// ============================================================================
// 2. POSITIVE — honest proofs still verify under the new format
// ============================================================================

#[test]
fn canonical_generic_proof_verifies() {
    let data = p01_stark::compact::generate_pool_commitment_proof_with_pair_indexing(
        0xDEADBEEF_u64,
        0xCAFEBABE_u64,
        7,
        0xA55A_u64,
        PairIndexing::Canonical,
    );
    let proof = GenericCompactProof::from_bytes(&data.proof_bytes, &CONFIG_POOL_COMMITMENT)
        .expect("parse");
    verify_generic(
        &proof,
        data.circuit_id,
        &data.public_inputs,
        &CONFIG_POOL_COMMITMENT,
    )
    .expect("canonical pair indexing must verify");
}

#[test]
fn canonical_legacy_proof_verifies() {
    let data = p01_stark::compact::generate_compact_proof_with_pair_indexing(
        42,
        PairIndexing::Canonical,
    );
    let proof = CompactStarkProof::from_bytes(&data.proof_bytes).expect("parse");
    verify_subscriber_ownership(&proof, Felt::new(data.commitment))
        .expect("canonical pair indexing must verify (legacy)");
}

/// The default entry points must be byte-identical to the canonical knob —
/// i.e. nothing in production reaches a probe layout.
#[test]
fn default_entry_points_are_canonical() {
    let a = p01_stark::compact::generate_pool_commitment_proof(9, 8, 7, 6);
    let b = p01_stark::compact::generate_pool_commitment_proof_with_pair_indexing(
        9,
        8,
        7,
        6,
        PairIndexing::Canonical,
    );
    assert_eq!(a.proof_bytes, b.proof_bytes, "generic default must be canonical");

    let c = p01_stark::compact::generate_compact_proof(7);
    let d = p01_stark::compact::generate_compact_proof_with_pair_indexing(
        7,
        PairIndexing::Canonical,
    );
    assert_eq!(c.proof_bytes, d.proof_bytes, "legacy default must be canonical");
}

/// Pin the size reduction so a future refactor that quietly reintroduces the
/// second path is caught. Sizes are computed from the format, not hard-coded.
#[test]
fn pair_leaf_wire_size_matches_the_format() {
    // C1: tw=3, md=11, num_queries=27, lde=2048, final_poly=16.
    let expect = expected_wire_size(3, 11, 27, 2048, 16);
    let data = p01_stark::compact::generate_pool_commitment_proof(111, 222, 333, 444);
    assert_eq!(data.proof_bytes.len(), expect, "C1 wire size drift");

    // Pre-B4 the same circuit was 120,665 bytes (measured on this tree at
    // commit 94c5d6b3 before the change).
    assert!(
        data.proof_bytes.len() < 120_665,
        "B4 must shrink C1 below its pre-B4 120,665 bytes",
    );
}

// ============================================================================
// helpers
// ============================================================================

/// Byte offsets of (query 0's `quotient_mirror_value`, tail `quotient_values[0]`).
///
/// Mirrors the prover's serializer exactly; if this drifts the test panics
/// rather than silently probing the wrong bytes.
fn quotient_pair_offsets(
    cfg: &p01_stark_verifier::compact_proof::CircuitConfig,
    bytes: &[u8],
) -> (usize, usize) {
    let tw = cfg.trace_width;
    let md = cfg.merkle_depth;
    let num_folds = (cfg.lde_size / cfg.fri_final_poly_size).trailing_zeros() as usize;
    let num_commits = num_folds - 1;

    // header
    let mut off = 32 + 32 + tw * 8 + tw * 8 + 8 + 8;
    assert_eq!(bytes[off] as usize, num_commits, "num_fri_layers byte drift");
    off += 1 + num_commits * 32;
    off += 2 + cfg.fri_final_poly_size * 8;
    off += 8; // grinding nonce
    off += 2; // num_queries

    // query 0: position + trace + next_trace + two trace paths
    let q_start = off;
    let mirror_off = q_start + 4 + tw * 8 + tw * 8 + md * 32 + md * 32;

    // full per-query stride, to locate the tail array
    let fri_per_query: usize = (0..num_commits).map(|i| 16 + (md - i - 2) * 32).sum();
    let per_query = 4 + tw * 8 + tw * 8 + md * 32 + md * 32 + 8 + (md - 1) * 32 + fri_per_query;
    let tail = q_start + per_query * cfg.num_queries;
    assert_eq!(
        tail + cfg.num_queries * 8,
        bytes.len(),
        "serializer layout drift — offsets in this test are stale",
    );

    (mirror_off, tail)
}

fn read_u64(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}

fn write_u64(b: &mut [u8], off: usize, v: u64) {
    b[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

/// [B4] Post-change wire size, derived from the format.
fn expected_wire_size(
    tw: usize,
    md: usize,
    num_queries: usize,
    lde_size: usize,
    fri_final_poly_size: usize,
) -> usize {
    let num_folds = (lde_size / fri_final_poly_size).trailing_zeros() as usize;
    let num_commits = num_folds - 1;
    let fri_per_query: usize = (0..num_commits).map(|i| 16 + (md - i - 2) * 32).sum();
    32 + 32
        + tw * 8 + tw * 8 + 8 + 8
        + 1 + num_commits * 32
        + 2 + fri_final_poly_size * 8
        + 8 + 2
        + num_queries * (
            4 + tw * 8 + tw * 8
            + md * 32 + md * 32
            + 8 + (md - 1) * 32
            + fri_per_query
        )
        + num_queries * 8
}
