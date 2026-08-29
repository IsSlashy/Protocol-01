//! [ROUTE C] Pair-leaf TRACE commitment — fails-closed guard, then the tamper
//! gates, then the structural pins.
//!
//! # What Route C changed
//!
//! B4 committed the quotient LDE and every FRI layer as pair leaves. Route C
//! applies the same shape to the trace commitment itself:
//!
//! ```text
//!   leaf[j] = SHA256( 0x00 ‖ row[j][0..tw] ‖ row[j + N/2][0..tw] )   j in 0..N/2
//! ```
//!
//! `N/2` leaves instead of `N`, depth `log2(N) - 1` instead of `log2(N)`. One
//! opening now yields the row at `pos` AND the row at `pos ^ (N/2)`. The `0x00`
//! is the leaf domain-separation tag; internal nodes carry `0x01`.
//!
//! # What Route C did NOT change
//!
//! **No soundness property.** The mirror rows are authenticated and then never
//! read: nothing in this revision consumes `trace_mirror_values_bytes`. Route C
//! is the plumbing that makes both halves of a coset available from a single
//! opening; the check that would *use* them does not exist yet. A reader who
//! takes this file as evidence that the verifier gained a DEEP binding has
//! misread it.
//!
//! # What Route C DID make worse
//!
//! It is format-breaking **and** it doubles raw witness exposure on a
//! trace-aligned query. `blowup` divides `lde/2`, so an aligned position has an
//! aligned mirror (`mirror_is_trace_aligned_exactly_when_position_is`, below):
//! an unlucky query used to put two genuine trace rows on the wire and now puts
//! four, the extra two being DIFFERENT trace rows (`r + trace_length/2`), not
//! copies (`mirror_row_is_a_different_trace_row`, below). COMPUTED: ~82% of
//! C0/C1/C2/C4 proofs and ~76% of C3/C5/C6 proofs carry at least one aligned
//! query. Since the LDE has no coset offset yet
//! (`stark-lde-no-coset-witness-leak-2026-07-27`), that is a 2x amplification of a
//! LIVE witness leak, and the coset fix is a hard predecessor for Route C reaching
//! a deployed verifier. The proof-size and CU wins below were bought with that.
//!
//! # Why the fails-closed tests come first
//!
//! Prover and verifier must agree on four things that never travel on the wire:
//! the pair index `j`, which of the two rows is the low half, the path depth, and
//! the fact that the tree is pair-leafed at all. A version skew across that seam
//! must produce a LOUD rejection, never an accidental acceptance.
//!
//! `p01_stark::compact::TraceLeaf::LegacyRowLeaf` is a test-only knob that makes
//! the prover build a **complete, internally consistent** proof in the
//! pre-Route-C format — old row-leaf tree, two rows per query, two full-depth
//! paths. The Route C verifier must reject it. And the pre-Route-C *rule* must
//! reject a Route C opening. Both directions, below.

use p01_stark::compact::TraceLeaf;
use p01_stark_verifier::compact_proof::{
    CircuitConfig, GenericCompactProof, CONFIG_BALANCE_PROOF, CONFIG_CONFIDENTIAL_BALANCE,
    CONFIG_MERKLE_PATH, CONFIG_MERKLE_UPDATE, CONFIG_POOL_COMMITMENT, CONFIG_SUBSCRIBER_OWNERSHIP,
    CONFIG_TRANSFER,
};
use p01_stark_verifier::merkle;
use p01_stark_verifier::verify::{verify_generic, verify_subscriber_ownership, VerifyError};

const SHIPPING: [&CircuitConfig; 7] = [
    &CONFIG_SUBSCRIBER_OWNERSHIP,
    &CONFIG_POOL_COMMITMENT,
    &CONFIG_BALANCE_PROOF,
    &CONFIG_MERKLE_PATH,
    &CONFIG_CONFIDENTIAL_BALANCE,
    &CONFIG_TRANSFER,
    &CONFIG_MERKLE_UPDATE,
];

// C1 witness — one place, so every C1 test below is comparing like with like.
const C1_ARGS: (u64, u64, u64, u64) = (0xA11CE, 0xB0B, 0xC0FFEE, 0xD00D);
// C4 witness. Values from `verify.rs::c4_sample_proof`.
const C4_ARGS: (u64, u64, u64, u64, u64, u64, u64, u64) =
    (42, 1000, 111, 800, 222, 200, 333, 999);

fn c1_proof(trace_leaf: TraceLeaf) -> p01_stark::compact::GenericCompactProofData {
    let (a, b, c, d) = C1_ARGS;
    p01_stark::compact::generate_pool_commitment_proof_with_trace_leaf(a, b, c, d, trace_leaf)
}

fn c4_proof(trace_leaf: TraceLeaf) -> p01_stark::compact::GenericCompactProofData {
    let (a, b, c, d, e, f, g, h) = C4_ARGS;
    p01_stark::compact::generate_confidential_balance_compact_proof_with_trace_leaf(
        a, b, c, d, e, f, g, h, trace_leaf,
    )
}

fn c1_verify(bytes: &[u8], public_inputs: &[u64]) -> Result<(), VerifyError> {
    let proof = GenericCompactProof::from_bytes(bytes, &CONFIG_POOL_COMMITMENT)
        .expect("parse under the Route C layout");
    verify_generic(&proof, 1, public_inputs, &CONFIG_POOL_COMMITMENT)
}

/// Byte offset of query `q`'s trace block, and the per-query row stride.
///
/// Mirrors the Route C serializer and asserts the whole layout adds up, so a
/// future format change makes these tests fail loudly instead of probing stale
/// bytes and passing for the wrong reason.
fn trace_block_offsets(cfg: &CircuitConfig, bytes: &[u8], q: usize) -> (usize, usize) {
    let tw = cfg.trace_width;
    let md = cfg.merkle_depth;
    let num_folds = (cfg.lde_size / cfg.fri_final_poly_size).trailing_zeros() as usize;
    let num_commits = num_folds - 1;

    // [B2] ood_quotient is `quotient_segments` felts, and each query's quotient
    // mirror block and tail entry are too.
    let k = cfg.quotient_segments;
    let mut off = 32 + 32 + tw * 8 + tw * 8 + 8 + k * 8;
    assert_eq!(bytes[off] as usize, num_commits, "num_fri_layers byte drift");
    off += 1 + num_commits * 32;
    off += 2 + cfg.fri_final_poly_size * 8;
    off += 8 + 2; // grinding nonce + num_queries

    let fri_per_query: usize = (0..num_commits).map(|i| 16 + (md - i - 2) * 32).sum();
    // [ROUTE C] four rows + two depth-(md-1) pair paths.
    let trace_block = 4 * (tw * 8) + 2 * ((md - 1) * 32);
    let per_query = 4 + trace_block + k * 8 + (md - 1) * 32 + fri_per_query;

    assert_eq!(
        off + per_query * cfg.num_queries + cfg.num_queries * k * 8,
        bytes.len(),
        "Route C serializer layout drift — offsets in this test are stale",
    );

    (off + q * per_query + 4, tw * 8)
}

// ============================================================================
// 0a. THE AUTHENTICATION SURFACE EXISTS AT ALL
// ============================================================================

/// `src/verify.rs` as it was AT COMPILE TIME of this test binary.
///
/// `include_str!` twice over, same reasoning as `merkle_domain_sep.rs`: it makes
/// `src/verify.rs` a tracked input of this test target (so cargo rebuilds when the
/// call sites move) and it lets the test compare compile-time bytes against
/// on-disk bytes at runtime, so a stale exe announces itself instead of
/// impersonating a broken change.
const EMBEDDED_VERIFY_SRC: &str = include_str!("../src/verify.rs");

const VERIFY_SRC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/verify.rs");

/// Route C's ENTIRE trace-authentication surface, as literal source text.
///
/// Four call sites: two in `verify_merkle_proofs_generic` (queried row, next row)
/// and two in `verify_merkle_proofs_legacy` — the legacy pair being the sole
/// verifier path for four shipped instructions
/// (`zk_shielded::{pause,resume,cancel_private_stark}` and
/// `p01_quantum_wallet/src/stark.rs:42`).
///
/// [B2] The pattern now names `&proof.trace_root` explicitly. It used to be the
/// bare `if !merkle::verify_merkle_path_2seg(`, which was unambiguous only while
/// the trace tree was the sole two-segment leaf in the verifier. B2 gave the
/// quotient pair leaf `quotient_segments` felts per half, so it moved onto the
/// same helper against `&proof.quotient_root` — and the bare count went 4 -> 6.
///
/// Relaxing the count to 6 would have been the WRONG fix: it would let a future
/// edit delete a trace site and add a quotient site and keep the tripwire green.
/// Naming the root keeps this constant meaning exactly what it has always meant,
/// and the quotient sites get their own count below.
const TRACE_AUTH_CALL_SITE: &str =
    "if !merkle::verify_merkle_path_2seg(\n            &proof.trace_root,";
const TRACE_AUTH_CALL_SITES_EXPECTED: usize = 4;

/// [B2] The quotient pair-leaf openings, same rule, separate count: one in
/// `verify_merkle_proofs_generic`, one in `verify_merkle_proofs_legacy`. With
/// either gone the verifier accepts UNAUTHENTICATED quotient segment values,
/// which is the half of the DEEP composition that carries the AIR.
const QUOTIENT_AUTH_CALL_SITE: &str =
    "if !merkle::verify_merkle_path_2seg(\n            &proof.quotient_root,";
const QUOTIENT_AUTH_CALL_SITES_EXPECTED: usize = 2;

/// The pre-land assertion. If this is red, DO NOT LAND THE TREE.
///
/// # Why a source-text count and not a behavioural test
///
/// MEASURED during the round-3 review: a concurrent process rewrote
/// `programs/p01_stark_verifier/src/verify.rs` in the shared worktree and deleted
/// ALL FOUR of these blocks — both in `verify_merkle_proofs_generic` and both in
/// `verify_merkle_proofs_legacy`. For roughly three minutes the tree the founder
/// was pointed at contained a verifier that accepts UNAUTHENTICATED trace rows on
/// both paths. `git status` showed ` M verify.rs` before and after, identically:
/// nothing in the tree distinguished correct bytes from fail-open bytes.
///
/// The behavioural tests in this file would catch it — `route_c_rejects_a_corrupted_mirror_row`
/// and friends go red with the checks gone — but only if someone runs them, and
/// only against a freshly built rlib. This test additionally makes the damage
/// *legible*: it names the missing surface and the exact count, so a half-restored
/// tree cannot be landed by someone who sees green elsewhere. It is also the one
/// assertion in this file that still means something when the crate does not
/// compile for an unrelated reason, because it is pure text.
///
/// Not a substitute for the tamper gates. An addition to them.
#[test]
fn all_four_trace_authentication_call_sites_are_present() {
    let on_disk = std::fs::read_to_string(VERIFY_SRC_PATH)
        .unwrap_or_else(|e| panic!("cannot read {VERIFY_SRC_PATH}: {e}"));

    // [B2] Count on LF-normalised text. `src/verify.rs` is stored with CRLF, so a
    // pattern that spans a line break has to say which line ending it means — and
    // the answer must not be "whichever the checkout happened to produce", or the
    // tripwire silently counts zero and this file's most important assertion
    // becomes decorative. Staleness is still compared on the RAW bytes below.
    let on_disk_lf = on_disk.replace("\r\n", "\n");
    let embedded_lf = EMBEDDED_VERIFY_SRC.replace("\r\n", "\n");
    let on_disk_count = on_disk_lf.matches(TRACE_AUTH_CALL_SITE).count();
    let embedded_count = embedded_lf.matches(TRACE_AUTH_CALL_SITE).count();

    // Staleness first: a red below means nothing if the exe is not the source.
    if on_disk != EMBEDDED_VERIFY_SRC {
        assert_eq!(
            on_disk_count, TRACE_AUTH_CALL_SITES_EXPECTED,
            "\n\n  >>> TRACE AUTHENTICATION MISSING FROM THE SOURCE ON DISK <<<\
             \n  {VERIFY_SRC_PATH}\
             \n  contains {on_disk_count} `{TRACE_AUTH_CALL_SITE}` call sites, expected \
             {TRACE_AUTH_CALL_SITES_EXPECTED}.\
             \n  With these gone the verifier accepts UNAUTHENTICATED trace rows on the\
             \n  generic path AND on the legacy C0 path. DO NOT LAND OR BUILD THIS TREE.\
             \n  (This exe also predates the file on disk, so every other test in this\
             \n  file describes older bytes — but the count above is read live and is\
             \n  the number that matters.)\n"
        );
        panic!(
            "\n\n  >>> STALE TEST BINARY <<<\
             \n  {VERIFY_SRC_PATH} on disk differs from the copy compiled into this exe\
             \n  ({} bytes on disk, {} compiled in). The four authentication call sites ARE\
             \n  present on disk ({on_disk_count}), so this is a rebuild problem, not a\
             \n  regression. Rebuild and require a literal `Compiling p01_stark_verifier`\
             \n  line in the log before believing any result from this file.\n",
            on_disk.len(),
            EMBEDDED_VERIFY_SRC.len(),
        );
    }

    assert_eq!(
        on_disk_count, embedded_count,
        "source text identical but call-site counts differ — impossible; \
         re-read this test"
    );
    assert_eq!(
        on_disk_count, TRACE_AUTH_CALL_SITES_EXPECTED,
        "\n\n  >>> TRACE AUTHENTICATION MISSING <<<\
         \n  {VERIFY_SRC_PATH} contains {on_disk_count} `{TRACE_AUTH_CALL_SITE}` call\
         \n  sites, expected {TRACE_AUTH_CALL_SITES_EXPECTED} (two in verify_merkle_proofs_generic, two in\
         \n  verify_merkle_proofs_legacy). With any of them gone the verifier accepts\
         \n  UNAUTHENTICATED trace rows. DO NOT LAND THIS TREE — restore the missing\
         \n  block(s) rather than adjusting this count.\n"
    );

    // [B2] Same tripwire for the quotient tree. Read live off disk, for the same
    // reason: it is the assertion that still means something when the crate does
    // not compile.
    let q_on_disk = on_disk_lf.matches(QUOTIENT_AUTH_CALL_SITE).count();
    let q_embedded = embedded_lf.matches(QUOTIENT_AUTH_CALL_SITE).count();
    assert_eq!(
        q_on_disk, q_embedded,
        "source text identical but quotient call-site counts differ — impossible; \
         re-read this test"
    );
    assert_eq!(
        q_on_disk, QUOTIENT_AUTH_CALL_SITES_EXPECTED,
        "\n\n  >>> QUOTIENT AUTHENTICATION MISSING <<<\
         \n  {VERIFY_SRC_PATH} contains {q_on_disk} `{QUOTIENT_AUTH_CALL_SITE}` call\
         \n  sites, expected {QUOTIENT_AUTH_CALL_SITES_EXPECTED} (one in verify_merkle_proofs_generic, one in\
         \n  verify_merkle_proofs_legacy). With either gone the verifier accepts\
         \n  UNAUTHENTICATED quotient segment values. DO NOT LAND THIS TREE.\n"
    );

    // The count is necessary but not sufficient: calls that all ignore their
    // result would pass it. Pin the reject arm too — PER CALL SITE.
    //
    // [B2-A] This used to be a single global `rejects >= TRACE_AUTH_CALL_SITES_
    // EXPECTED`, i.e. `>= 4`, written when four was the total number of
    // `verify_merkle_path_2seg` call sites in the file. B2 took that total to SIX
    // by moving the quotient openings onto the same helper, and the floor stayed
    // at 4 — so verify.rs could lose BOTH quotient reject arms and still satisfy
    // it. MEASURED: deleting the `return Err(VerifyError::MerkleProofFailed);`
    // inside `verify_merkle_proofs_legacy`'s quotient block, leaving the call-site
    // string byte-identical, left this whole file at 22 passed / 0 failed and
    // `b1_deep_binding` at 26 passed / 0 failed, with C0's quotient segments
    // UNAUTHENTICATED. A `>=` floor against a stale total is not a tripwire.
    //
    // Now every call site is checked for its own reject arm, and the total is an
    // equality, so a new unguarded call site cannot hide behind an old guarded one.
    const ANY_2SEG_CALL: &str = "if !merkle::verify_merkle_path_2seg(";
    const REJECT_ARM: &str = "return Err(VerifyError::MerkleProofFailed);";
    let total_call_sites = on_disk_lf.matches(ANY_2SEG_CALL).count();
    assert_eq!(
        total_call_sites,
        TRACE_AUTH_CALL_SITES_EXPECTED + QUOTIENT_AUTH_CALL_SITES_EXPECTED,
        "\n\n  >>> UNACCOUNTED-FOR MERKLE CALL SITE <<<\
         \n  {VERIFY_SRC_PATH} has {total_call_sites} `{ANY_2SEG_CALL}` call sites but\
         \n  only {TRACE_AUTH_CALL_SITES_EXPECTED} trace + {QUOTIENT_AUTH_CALL_SITES_EXPECTED} quotient are named above. Every\
         \n  two-segment Merkle call in the verifier must be one of the two kinds this\
         \n  test knows about, or it is authenticating something nobody is counting.\n"
    );

    // The reject arm belongs to the call site, so look for it inside the call
    // site's own block rather than anywhere in the file. 400 chars covers the
    // widest of the six blocks (arguments + brace + arm) with room to spare; a
    // reformat that pushes it past that fails LOUD, which is the right direction.
    for (n, piece) in on_disk_lf.split(ANY_2SEG_CALL).skip(1).enumerate() {
        let window = &piece[..piece.len().min(400)];
        assert!(
            window.contains(REJECT_ARM),
            "\n\n  >>> MERKLE CALL SITE {n} DOES NOT REJECT <<<\
             \n  {VERIFY_SRC_PATH}: the {n}-th `{ANY_2SEG_CALL}` call is not followed by\
             \n  `{REJECT_ARM}` within its own block. A call whose result is discarded\
             \n  authenticates NOTHING, and the call-site counts above stay green through\
             \n  it. DO NOT LAND THIS TREE.\n\n  block was:\n{window}\n"
        );
    }
}

// ============================================================================
// 0. BASELINE — without this the reject tests below prove nothing
// ============================================================================

#[test]
fn route_c_canonical_proof_verifies() {
    let data = c1_proof(TraceLeaf::Canonical);
    c1_verify(&data.proof_bytes, &data.public_inputs)
        .expect("canonical Route C proof must verify");

    let d4 = c4_proof(TraceLeaf::Canonical);
    let p4 = GenericCompactProof::from_bytes(&d4.proof_bytes, &CONFIG_CONFIDENTIAL_BALANCE)
        .expect("parse C4");
    verify_generic(&p4, 4, &d4.public_inputs, &CONFIG_CONFIDENTIAL_BALANCE)
        .expect("canonical Route C C4 proof must verify");
}

// ============================================================================
// 1. FAILS CLOSED — the version-skew seam, both directions
// ============================================================================

/// **Direction 1, sharp case.** An old-format C4 proof against the new verifier.
///
/// C4 has `trace_width == 4`, so `16 * trace_width - 64 == 0`: the pre-Route-C
/// and Route C wire formats are the SAME NUMBER OF BYTES. Every length check in
/// the parser passes, every field boundary lands inside the buffer, and the
/// transcript is internally consistent (the old prover derived its OOD point and
/// query positions from its own `trace_root`). Nothing incidental rejects this
/// proof. The pair-leaf Merkle check is the only thing standing between an
/// old-format proof and acceptance — so this test pins that it is, in fact,
/// standing there.
#[test]
fn fails_closed_old_format_c4_proof_against_new_verifier() {
    let old = c4_proof(TraceLeaf::LegacyRowLeaf);
    let new = c4_proof(TraceLeaf::Canonical);

    assert_eq!(
        old.proof_bytes.len(),
        new.proof_bytes.len(),
        "C4 is the sharp case precisely because the two layouts are the same \
         size (16*tw - 64 == 0 at tw=4). If this ever differs, this test has \
         stopped being the sharp case and the assertion below proves less.",
    );
    assert_ne!(
        old.root, new.root,
        "row-leaf and pair-leaf trees must commit to different roots, or there \
         is no version skew to fail closed on",
    );

    let proof = GenericCompactProof::from_bytes(&old.proof_bytes, &CONFIG_CONFIDENTIAL_BALANCE)
        .expect("an old-format C4 proof parses — same length, same boundaries");
    let err = verify_generic(&proof, 4, &old.public_inputs, &CONFIG_CONFIDENTIAL_BALANCE)
        .expect_err("an old-format proof must NOT verify against the new verifier");
    assert!(
        matches!(err, VerifyError::MerkleProofFailed),
        "an old-format C4 proof must be rejected at the Merkle check — anything \
         else means it got past the trace commitment. got {err:?}",
    );
}

/// **Direction 1, length-mismatch case.** Same skew on C1 (`trace_width == 3`),
/// where the old layout is `27 * 16 = 432` bytes LONGER. Rejection may come from
/// the parser or from a downstream check; the property is that it comes.
#[test]
fn fails_closed_old_format_c1_proof_against_new_verifier() {
    let old = c1_proof(TraceLeaf::LegacyRowLeaf);
    let new = c1_proof(TraceLeaf::Canonical);

    assert_eq!(
        old.proof_bytes.len(),
        new.proof_bytes.len() + 432,
        "C1: nq * (16*tw - 64) = 27 * -16 = -432, so the OLD layout is 432 \
         bytes longer than Route C",
    );

    match GenericCompactProof::from_bytes(&old.proof_bytes, &CONFIG_POOL_COMMITMENT) {
        // Trailing bytes are ignored by the parser, so it may well parse. What
        // matters is that verification does not succeed.
        Some(proof) => {
            let err = verify_generic(&proof, 1, &old.public_inputs, &CONFIG_POOL_COMMITMENT)
                .expect_err("old-format C1 proof must not verify");
            println!("[ROUTE C] MEASURED: old-format C1 proof rejected with {err:?}");
        }
        None => println!("[ROUTE C] MEASURED: old-format C1 proof rejected at parse"),
    }
}

/// **Direction 2.** A Route C opening against the PRE-ROUTE-C rule.
///
/// The old verifier's trace check was, verbatim,
/// `merkle::verify_merkle_path(trace_root, row_at_pos, pos, path)` — one row per
/// leaf, index `pos`, depth `merkle_depth`. That function is still exported and
/// unchanged, so this runs the old rule itself rather than a re-implementation of
/// it. (It is the old *rule*, not the old *binary*; the two-binary check is a
/// separate manual measurement, see the session notes.)
///
/// The positive control is the half that makes this a test: the old rule must
/// still ACCEPT an old-format proof. Without that, "the old rule says no" could
/// just mean the old rule is broken.
#[test]
fn fails_closed_route_c_opening_against_the_legacy_row_leaf_rule() {
    let md = CONFIG_POOL_COMMITMENT.merkle_depth;

    // Positive control: old proof, old rule -> accepted.
    let old = c1_proof(TraceLeaf::LegacyRowLeaf);
    let old_parsed = old_layout_trace_openings(&CONFIG_POOL_COMMITMENT, &old.proof_bytes);
    let mut controls = 0;
    for (pos, row, path) in &old_parsed {
        assert_eq!(path.len(), md * 32, "old layout carries a full-depth path");
        assert!(
            merkle::verify_merkle_path(&old.trace_root_bytes(), row, *pos, path),
            "the pre-Route-C rule must accept a pre-Route-C opening at pos={pos} \
             — otherwise the negative half of this test is vacuous",
        );
        controls += 1;
    }
    assert_eq!(controls, CONFIG_POOL_COMMITMENT.num_queries);

    // The real direction: Route C proof, old rule -> rejected.
    let data = c1_proof(TraceLeaf::Canonical);
    let proof = GenericCompactProof::from_bytes(&data.proof_bytes, &CONFIG_POOL_COMMITMENT)
        .expect("parse Route C proof");
    let root = data.trace_root_bytes();
    let mut checked = 0;
    for query in &proof.queries {
        let pos = query.position as usize;
        let path = query.merkle_path();
        assert_eq!(path.len(), (md - 1) * 32, "Route C path is one level shallower");

        // (a) as-is: the old rule walks md-1 levels and lands nowhere.
        assert!(
            !merkle::verify_merkle_path(&root, query.trace_values_bytes(), pos, path),
            "the pre-Route-C rule accepted a Route C opening at pos={pos}",
        );
        // (b) generously padded to the old depth, so the failure is not merely a
        //     length accident.
        let mut padded = path.to_vec();
        padded.extend_from_slice(&[0u8; 32]);
        assert!(
            !merkle::verify_merkle_path(&root, query.trace_values_bytes(), pos, &padded),
            "the pre-Route-C rule accepted a zero-padded Route C opening at pos={pos}",
        );
        checked += 1;
    }
    assert_eq!(checked, CONFIG_POOL_COMMITMENT.num_queries);
}

/// Read `(position, row_at_pos, full_depth_path)` for every query out of a
/// PRE-Route-C proof buffer. Only used by the positive control above; the layout
/// is asserted against the buffer length so it cannot silently rot.
fn old_layout_trace_openings(
    cfg: &CircuitConfig,
    bytes: &[u8],
) -> Vec<(usize, Vec<u8>, Vec<u8>)> {
    let tw = cfg.trace_width;
    let md = cfg.merkle_depth;
    let num_folds = (cfg.lde_size / cfg.fri_final_poly_size).trailing_zeros() as usize;
    let num_commits = num_folds - 1;

    // [B2] The proof this walks is built by `*_with_trace_leaf(LegacyRowLeaf)`,
    // which is CURRENT in every respect except the trace-leaf rule — so it
    // carries the k-wide quotient fields like any other proof of this tree.
    let k = cfg.quotient_segments;
    let mut off = 32 + 32 + tw * 8 + tw * 8 + 8 + k * 8;
    assert_eq!(bytes[off] as usize, num_commits, "num_fri_layers byte drift");
    off += 1 + num_commits * 32;
    off += 2 + cfg.fri_final_poly_size * 8;
    off += 8 + 2;

    let fri_per_query: usize = (0..num_commits).map(|i| 16 + (md - i - 2) * 32).sum();
    // Pre-Route-C: TWO rows + TWO depth-md paths.
    let per_query =
        4 + 2 * (tw * 8) + 2 * (md * 32) + k * 8 + (md - 1) * 32 + fri_per_query;
    assert_eq!(
        off + per_query * cfg.num_queries + cfg.num_queries * k * 8,
        bytes.len(),
        "pre-Route-C layout drift in this test's offsets",
    );

    (0..cfg.num_queries)
        .map(|q| {
            let base = off + q * per_query;
            let pos = u32::from_le_bytes(bytes[base..base + 4].try_into().unwrap()) as usize;
            let row = bytes[base + 4..base + 4 + tw * 8].to_vec();
            let path_start = base + 4 + 2 * (tw * 8);
            let path = bytes[path_start..path_start + md * 32].to_vec();
            (pos, row, path)
        })
        .collect()
}

/// `GenericCompactProofData.root` is the trace root; give it a name that says so.
trait TraceRootBytes {
    fn trace_root_bytes(&self) -> [u8; 32];
}
impl TraceRootBytes for p01_stark::compact::GenericCompactProofData {
    fn trace_root_bytes(&self) -> [u8; 32] {
        self.root
    }
}

// ============================================================================
// 2. TAMPER — the mirror rows are genuinely authenticated
// ============================================================================

/// THE test that distinguishes "the mirror row rides along unauthenticated" from
/// "the mirror row is bound to `trace_root`". Pre-Route-C the mirror row did not
/// exist on the wire at all; the entire point of the route is that it arrives
/// already authenticated. Flip one byte of it and the root check must fail.
#[test]
fn route_c_rejects_a_corrupted_mirror_row() {
    let data = c1_proof(TraceLeaf::Canonical);
    for q in 0..3 {
        let (base, row_len) = trace_block_offsets(&CONFIG_POOL_COMMITMENT, &data.proof_bytes, q);
        let mut bytes = data.proof_bytes.clone();
        // trace_mirror_values sits immediately after trace_values.
        bytes[base + row_len] ^= 0x01;
        let err = c1_verify(&bytes, &data.public_inputs)
            .expect_err("a corrupted trace MIRROR row must be rejected");
        assert!(
            matches!(err, VerifyError::MerkleProofFailed),
            "corrupted mirror row must fail at the Merkle check, got {err:?} (query {q})",
        );
    }
}

/// Same for the mirror of `next_pos` — the fourth row, the one that exists only
/// because the pair leaf forces it onto the wire.
#[test]
fn route_c_rejects_a_corrupted_next_mirror_row() {
    let data = c1_proof(TraceLeaf::Canonical);
    for q in 0..3 {
        let (base, row_len) = trace_block_offsets(&CONFIG_POOL_COMMITMENT, &data.proof_bytes, q);
        let mut bytes = data.proof_bytes.clone();
        bytes[base + 3 * row_len] ^= 0x01;
        let err = c1_verify(&bytes, &data.public_inputs)
            .expect_err("a corrupted next-mirror row must be rejected");
        assert!(
            matches!(err, VerifyError::MerkleProofFailed),
            "corrupted next-mirror row must fail at the Merkle check, got {err:?} (query {q})",
        );
    }
}

/// Swapping the two halves inside the leaf must fail. Trace analogue of B4's
/// `generic_rejects_wire_level_pair_half_swap`: the verifier picks the (lo, hi)
/// order from `position`, which is itself transcript-bound, so a prover cannot
/// choose which side of the mirror its row lands on.
#[test]
fn route_c_rejects_a_wire_level_trace_half_swap() {
    let data = c1_proof(TraceLeaf::Canonical);
    let mut swapped = 0;
    for q in 0..CONFIG_POOL_COMMITMENT.num_queries {
        let (base, row_len) = trace_block_offsets(&CONFIG_POOL_COMMITMENT, &data.proof_bytes, q);
        let at_pos = data.proof_bytes[base..base + row_len].to_vec();
        let mirror = data.proof_bytes[base + row_len..base + 2 * row_len].to_vec();
        if at_pos == mirror {
            continue; // degenerate; a swap would be a no-op
        }
        let mut bytes = data.proof_bytes.clone();
        bytes[base..base + row_len].copy_from_slice(&mirror);
        bytes[base + row_len..base + 2 * row_len].copy_from_slice(&at_pos);
        let err = c1_verify(&bytes, &data.public_inputs)
            .expect_err("a trace half swap must be rejected");
        assert!(
            matches!(err, VerifyError::MerkleProofFailed),
            "trace half swap must fail at the Merkle check, got {err:?} (query {q})",
        );
        swapped += 1;
        if swapped == 3 {
            break;
        }
    }
    assert!(swapped > 0, "no query had distinct halves — test proved nothing");
}

// ============================================================================
// 3. THE LEGACY C0 PATH — its own parser, its own verifier, same tamper gates
// ============================================================================

/// C0 is not a variant of the generic path; it has a separate parser
/// (`CompactStarkProof`) and a separate verifier (`verify_subscriber_ownership`).
/// Route C touched both, so both need the gates.
#[test]
fn route_c_legacy_c0_honest_proof_still_verifies() {
    for secret in [42u64, 7, 0xDEAD_BEEF] {
        let pd = p01_stark::compact::generate_compact_proof(secret);
        let parsed = p01_stark_verifier::compact_proof::CompactStarkProof::from_bytes(
            &pd.proof_bytes,
        )
        .expect("parse legacy C0 proof under the Route C layout");
        verify_subscriber_ownership(
            &parsed,
            p01_stark_verifier::goldilocks::Felt::new(pd.commitment),
        )
        .unwrap_or_else(|e| panic!("honest C0 proof must verify (secret={secret}): {e:?}"));
    }
}

/// C0's wire size is fixed, so pin it: `47,641` bytes.
///
/// Two closed-form terms, kept separate because they came from different changes
/// and a single lumped delta would let one absorb a regression in the other:
///
/// * Route C: `nq * (16*tw - 64) = 27 * (48 - 64) = -432`
/// * [B2]:    `8 * (k-1) * (2*nq + 1) = 8 * 6 * 55 = +2,640`
///
/// so `45,433 - 432 + 2,640 = 47,641` against the pre-Route-C baseline.
#[test]
fn route_c_legacy_c0_wire_size_matches_the_closed_form() {
    let pd = p01_stark::compact::generate_compact_proof(42);
    let cfg = &CONFIG_SUBSCRIBER_OWNERSHIP;
    let tw = cfg.trace_width;
    let md = cfg.merkle_depth;
    let nq = cfg.num_queries;
    let k = cfg.quotient_segments;
    let num_commits = (cfg.lde_size / cfg.fri_final_poly_size).trailing_zeros() as usize - 1;
    let fri_per_query: usize = (0..num_commits).map(|i| 16 + (md - i - 2) * 32).sum();

    let expected = 32 + 32 + tw * 8 + tw * 8 + 8 + 8 * k
        + 1 + num_commits * 32
        + 2 + cfg.fri_final_poly_size * 8
        + 8 + 2
        + nq * (4 + 4 * (tw * 8) + 2 * ((md - 1) * 32) + 8 * k + (md - 1) * 32 + fri_per_query)
        + nq * 8 * k;

    assert_eq!(pd.proof_bytes.len(), expected, "C0 wire size drift");
    assert_eq!(pd.proof_bytes.len(), 47_641, "C0 must be 47,641 bytes post-B2");
    let route_c_delta = nq as i64 * (16 * tw as i64 - 64);
    let b2_delta = 8 * (k as i64 - 1) * (2 * nq as i64 + 1);
    assert_eq!(route_c_delta, -432, "Route C's C0 term is nq*(16*tw-64)");
    assert_eq!(b2_delta, 2_640, "B2's C0 term is 8*(k-1)*(2*nq+1)");
    assert_eq!(
        pd.proof_bytes.len() as i64 - 45_433,
        route_c_delta + b2_delta,
        "C0 delta must be Route C's term plus B2's term, each pinned separately",
    );
}

/// **C0 version skew, direction 1: an OLD-FORMAT C0 proof against the NEW
/// verifier.** This is the highest-consequence seam in Route C.
///
/// C0 is the only verifier for four SHIPPED instructions
/// (`zk_shielded::{pause,resume,cancel_private_stark}` and
/// `p01_quantum_wallet/src/stark.rs:42` all hard-require `circuit_id == 0`), and it
/// reaches them through its own parser (`CompactStarkProof`) and its own entry
/// point (`verify_subscriber_ownership`) — neither shared with the generic path.
/// Until `generate_compact_proof_with_trace_leaf` existed there was no way to build
/// an old-format C0 proof at all, so this direction was covered only by wire-level
/// tamper tests, which prove binding and say nothing about skew.
///
/// Note what the legacy parser does NOT do: it length-checks with
/// `data.len() < cursor + N` at every field and never checks for an exact total.
/// The old format is 432 bytes LONGER (`nq * (16*tw - 64) = 27 * -16`), so the
/// trailing bytes are simply ignored and the buffer parses fine. Rejection has to
/// come from a real check.
///
/// # Which check rejects it, and why that is not the Merkle check
///
/// MEASURED: `InvalidQueryPosition`, not `MerkleProofFailed`. That is a structural
/// property of C0, not a weakness, and it is worth stating plainly because the
/// first draft of this test asserted `MerkleProofFailed` and was WRONG:
///
///   * `verify_subscriber_ownership` runs `verify_query_positions_legacy` BEFORE
///     `verify_merkle_proofs_legacy` (verify.rs, steps 31 and 34 of that function).
///   * C0 has `trace_width == 3`, so `16*tw - 64 = -16 != 0`: the two formats have
///     DIFFERENT per-query block sizes. Query 0's block starts at the same offset in
///     both (the header is identical), but from query 1 on the new parser reads
///     positions 16 bytes early per preceding query and sees garbage.
///
/// So on C0 the position check always fires first and the Merkle check is never
/// reached end-to-end. The zero-delta circuits are the only ones where an
/// end-to-end old proof can reach the Merkle check, and that case is covered by
/// `fails_closed_old_format_c4_proof_against_new_verifier` (`tw == 4`, same length).
/// The load-bearing role of the C0 trace Merkle check is pinned separately, by the
/// three C0 tamper tests below and by the rule-level assertion at the end of this
/// test.
#[test]
fn fails_closed_old_format_c0_proof_against_new_verifier() {
    let old = p01_stark::compact::generate_compact_proof_with_trace_leaf(
        42,
        TraceLeaf::LegacyRowLeaf,
    );
    let new = p01_stark::compact::generate_compact_proof(42);

    assert_eq!(
        old.proof_bytes.len(),
        new.proof_bytes.len() + 432,
        "C0: nq * (16*tw - 64) = 27 * -16 = -432, so the OLD layout must be 432 \
         bytes longer than Route C. If not, LegacyRowLeaf is not reproducing the \
         pre-Route-C wire format and this test proves nothing.",
    );
    assert_ne!(
        old.root, new.root,
        "the row-leaf and pair-leaf trace trees must commit to DIFFERENT roots, or \
         there is no version skew to fail closed on",
    );
    assert_eq!(
        old.commitment, new.commitment,
        "same witness, so the same public commitment — the ONLY difference between \
         these two proofs must be the trace commitment layout",
    );

    let parsed = p01_stark_verifier::compact_proof::CompactStarkProof::from_bytes(
        &old.proof_bytes,
    )
    .expect(
        "the legacy parser min-length-checks each field and ignores trailing bytes, \
         so an old-format buffer parses — the Merkle check is what has to reject it",
    );
    let err = verify_subscriber_ownership(
        &parsed,
        p01_stark_verifier::goldilocks::Felt::new(old.commitment),
    )
    .expect_err(
        "an OLD-FORMAT C0 proof must NOT verify against the Route C verifier. If it \
         does, every already-issued C0 proof still passes and the trace commitment \
         is not actually part of the decision.",
    );
    println!("[ROUTE C] MEASURED: old-format C0 proof rejected with {err:?}");
    assert!(
        matches!(
            err,
            VerifyError::InvalidQueryPosition | VerifyError::MerkleProofFailed
        ),
        "an old-format C0 proof must be rejected by the query-position check (what is \
         MEASURED today, because the format is length-changing) or by the trace Merkle \
         check. Got {err:?}, which means it got past BOTH and was stopped by something \
         downstream and incidental.",
    );

    // Isolate the trace Merkle check itself, since the end-to-end path above cannot
    // reach it on C0. Query 0's block starts at the SAME offset in both formats, so
    // the new pair-leaf rule can be applied to the old buffer's query-0 bytes
    // directly. Under the old layout those bytes are
    // `row(pos) | row(next_pos) | first 48 B of the depth-9 path | ...`, so the new
    // rule is hashing a leaf that the row-leaf tree never contained.
    let cfg = &CONFIG_SUBSCRIBER_OWNERSHIP;
    let half = cfg.lde_size / 2;
    let (base, row_len) = legacy_c0_trace_block_offsets(cfg, &new.proof_bytes, 0);
    let q0_pos = u32::from_le_bytes(old.proof_bytes[base - 4..base].try_into().unwrap()) as usize;
    let (lo, hi) = if q0_pos < half {
        (
            &old.proof_bytes[base..base + row_len],
            &old.proof_bytes[base + row_len..base + 2 * row_len],
        )
    } else {
        (
            &old.proof_bytes[base + row_len..base + 2 * row_len],
            &old.proof_bytes[base..base + row_len],
        )
    };
    let route_c_path_len = (cfg.merkle_depth - 1) * 32;
    let path_start = base + 4 * row_len;
    assert!(
        !merkle::verify_merkle_path_2seg(
            &old.root,
            lo,
            hi,
            q0_pos & (half - 1),
            &old.proof_bytes[path_start..path_start + route_c_path_len],
        ),
        "the Route C pair-leaf rule accepted an OLD-FORMAT C0 query-0 opening against \
         the old row-leaf root — the trace commitment would not distinguish the two \
         formats at all",
    );
}

/// **C0 version skew, direction 2: a NEW-FORMAT C0 opening against the OLD RULE.**
///
/// The pre-Route-C C0 trace check was, verbatim,
/// `merkle::verify_merkle_path(trace_root, row_at_pos, pos, path)` — one row per
/// leaf, index `pos`, depth `MERKLE_DEPTH`. That function is still exported and
/// unchanged, so this runs the old rule itself, not a re-implementation of it.
///
/// The positive control is what makes this a test: the old rule must still ACCEPT
/// an old-format C0 opening. Without it, "the old rule says no" could just mean the
/// old rule is broken.
#[test]
fn fails_closed_route_c_c0_opening_against_the_legacy_row_leaf_rule() {
    let cfg = &CONFIG_SUBSCRIBER_OWNERSHIP;
    let md = cfg.merkle_depth;

    // Positive control: old C0 proof, old rule -> accepted.
    let old = p01_stark::compact::generate_compact_proof_with_trace_leaf(
        42,
        TraceLeaf::LegacyRowLeaf,
    );
    let openings = old_layout_trace_openings(cfg, &old.proof_bytes);
    assert_eq!(openings.len(), cfg.num_queries);
    for (pos, row, path) in &openings {
        assert_eq!(path.len(), md * 32, "old C0 layout carries a full-depth path");
        assert!(
            merkle::verify_merkle_path(&old.root, row, *pos, path),
            "the pre-Route-C rule must accept a pre-Route-C C0 opening at pos={pos} \
             — otherwise the negative half below is vacuous",
        );
    }

    // The real direction: Route C C0 proof, old rule -> rejected.
    let pd = p01_stark::compact::generate_compact_proof(42);
    let parsed =
        p01_stark_verifier::compact_proof::CompactStarkProof::from_bytes(&pd.proof_bytes)
            .expect("parse Route C C0 proof");
    let mut checked = 0;
    for query in &parsed.queries {
        let pos = query.position as usize;
        let path = query.merkle_path();
        assert_eq!(path.len(), (md - 1) * 32, "Route C C0 path is one level shallower");
        assert!(
            !merkle::verify_merkle_path(&pd.root, query.trace_values_bytes(), pos, path),
            "the pre-Route-C rule accepted a Route C C0 opening at pos={pos}",
        );
        // Zero-padded to the old depth, so the failure is not a length accident.
        let mut padded = path.to_vec();
        padded.extend_from_slice(&[0u8; 32]);
        assert!(
            !merkle::verify_merkle_path(&pd.root, query.trace_values_bytes(), pos, &padded),
            "the pre-Route-C rule accepted a zero-padded Route C C0 opening at pos={pos}",
        );
        checked += 1;
    }
    assert_eq!(checked, cfg.num_queries);
}

/// Tamper the legacy C0 mirror row. Same claim as the generic case, different
/// parser — a fix applied to one and not the other would slip past every other
/// test in the suite.
#[test]
fn route_c_legacy_c0_rejects_a_corrupted_mirror_row() {
    let pd = p01_stark::compact::generate_compact_proof(42);
    let cfg = &CONFIG_SUBSCRIBER_OWNERSHIP;
    let (base, row_len) = legacy_c0_trace_block_offsets(cfg, &pd.proof_bytes, 0);

    for (label, slot) in [("mirror", 1usize), ("next-mirror", 3)] {
        let mut bytes = pd.proof_bytes.clone();
        bytes[base + slot * row_len] ^= 0x01;
        let parsed =
            p01_stark_verifier::compact_proof::CompactStarkProof::from_bytes(&bytes)
                .expect("still parses — only a value byte changed");
        let err = verify_subscriber_ownership(
            &parsed,
            p01_stark_verifier::goldilocks::Felt::new(pd.commitment),
        )
        .expect_err("a corrupted C0 mirror row must be rejected");
        assert!(
            matches!(err, VerifyError::MerkleProofFailed),
            "corrupted C0 {label} row must fail at the Merkle check, got {err:?}",
        );
    }
}

/// Swap the two halves of a legacy C0 leaf.
#[test]
fn route_c_legacy_c0_rejects_a_wire_level_trace_half_swap() {
    let pd = p01_stark::compact::generate_compact_proof(42);
    let cfg = &CONFIG_SUBSCRIBER_OWNERSHIP;
    let mut swapped = 0;
    for q in 0..cfg.num_queries {
        let (base, row_len) = legacy_c0_trace_block_offsets(cfg, &pd.proof_bytes, q);
        let at_pos = pd.proof_bytes[base..base + row_len].to_vec();
        let mirror = pd.proof_bytes[base + row_len..base + 2 * row_len].to_vec();
        if at_pos == mirror {
            continue;
        }
        let mut bytes = pd.proof_bytes.clone();
        bytes[base..base + row_len].copy_from_slice(&mirror);
        bytes[base + row_len..base + 2 * row_len].copy_from_slice(&at_pos);
        let parsed =
            p01_stark_verifier::compact_proof::CompactStarkProof::from_bytes(&bytes)
                .expect("still parses");
        let err = verify_subscriber_ownership(
            &parsed,
            p01_stark_verifier::goldilocks::Felt::new(pd.commitment),
        )
        .expect_err("a C0 trace half swap must be rejected");
        assert!(
            matches!(err, VerifyError::MerkleProofFailed),
            "C0 half swap must fail at the Merkle check, got {err:?} (query {q})",
        );
        swapped += 1;
        if swapped == 3 {
            break;
        }
    }
    assert!(swapped > 0, "no C0 query had distinct halves — test proved nothing");
}

fn legacy_c0_trace_block_offsets(
    cfg: &CircuitConfig,
    bytes: &[u8],
    q: usize,
) -> (usize, usize) {
    // The legacy header layout is byte-identical to the generic one for tw=3,
    // md=9, so the generic helper's asserted arithmetic applies unchanged.
    trace_block_offsets(cfg, bytes, q)
}

// ============================================================================
// 4. THE C0 DISPATCH DECISION
// ============================================================================

/// [C0 GATE] The generic dispatch refuses `circuit_id == 0` by name.
///
/// Four shipped instructions hard-require `circuit_id == 0`
/// (`zk_shielded::{pause,resume,cancel_private_stark}` and
/// `p01_quantum_wallet/src/stark.rs:42`), and the generic path cannot verify an
/// honest C0 proof anyway. So the legacy path stays and the generic path says no
/// — out loud, with its own error, before doing any work.
#[test]
fn c0_is_hard_gated_off_the_generic_dispatch() {
    let pd = p01_stark::compact::generate_compact_proof(42);
    let cfg = &CONFIG_SUBSCRIBER_OWNERSHIP;
    let parsed = GenericCompactProof::from_bytes(&pd.proof_bytes, cfg)
        .expect("an honest C0 proof DOES parse as generic — the gate is what stops it");
    let err = verify_generic(&parsed, 0, &[pd.commitment], cfg)
        .expect_err("the generic dispatch must refuse circuit 0");
    assert!(
        matches!(err, VerifyError::CircuitZeroIsLegacyOnly),
        "circuit 0 must be refused explicitly, not fail incidentally: got {err:?}",
    );
}

/// [C0 GATE] The refusal must be a refusal, not a silent mis-verification: a
/// TAMPERED C0 proof handed to the generic path must fail too, and with the same
/// named error — the gate cannot be a path that "happens to work" for good proofs
/// and leaks for bad ones.
#[test]
fn c0_gate_refuses_tampered_proofs_the_same_way() {
    let pd = p01_stark::compact::generate_compact_proof(42);
    let cfg = &CONFIG_SUBSCRIBER_OWNERSHIP;
    let mut bytes = pd.proof_bytes.clone();
    bytes[64] ^= 0x01; // ood_current[0]
    let parsed = GenericCompactProof::from_bytes(&bytes, cfg).expect("parses");
    let err = verify_generic(&parsed, 0, &[pd.commitment], cfg).expect_err("must refuse");
    assert!(
        matches!(err, VerifyError::CircuitZeroIsLegacyOnly),
        "the C0 gate must fire before any proof-dependent check: got {err:?}",
    );
}

// ============================================================================
// 5. STRUCTURAL — the access pattern actually permits pair-leafing
// ============================================================================

/// `next_pos` is never the mirror of `pos`, so the two trace openings are always
/// two DISTINCT pair leaves. If `lde_size/2` ever divided `blowup` the pair index
/// would alias and the format would be ambiguous. Pin it on all seven configs.
#[test]
fn next_pos_is_never_the_mirror_and_never_aliases_the_pair_index() {
    for cfg in SHIPPING {
        let n = cfg.lde_size;
        let half = n / 2;
        let b = cfg.blowup;
        assert!(half % b == 0, "lde/2 must be a multiple of blowup for cfg lde={n}");
        assert!(half > b, "lde/2 must exceed blowup for cfg lde={n}");
        for pos in 0..n {
            let next = (pos + b) % n;
            assert_ne!(next, pos ^ half, "next_pos is the mirror at pos={pos}, lde={n}");
            assert_ne!(
                next & (half - 1),
                pos & (half - 1),
                "pair index aliases at pos={pos}, lde={n}",
            );
        }
    }
}

/// THE identity that makes Route C over-deliver: the mirror of `next_pos` is the
/// same point as the next row of the mirror of `pos`.
///
/// ```text
///   mirror(next(pos)) = (pos + blowup + lde/2) mod lde = next(mirror(pos))
/// ```
///
/// So the four rows a query carries are two COMPLETE transition frames:
/// `(pos, pos+blowup)` and `(pos^half, pos^half+blowup)`. Nothing extra must be
/// opened to spot-check the transition constraint at the mirror position — which
/// is what makes this plumbing worth landing ahead of the check that uses it.
#[test]
fn mirror_of_next_equals_next_of_mirror() {
    for cfg in SHIPPING {
        let n = cfg.lde_size;
        let half = n / 2;
        let b = cfg.blowup;
        for pos in 0..n {
            let next = (pos + b) % n;
            let mirror = pos ^ half;
            assert_eq!(
                next ^ half,
                (mirror + b) % n,
                "mirror/next identity broken at pos={pos}, lde={n}",
            );
        }
    }
}

/// The trace-alignment leak surface does not widen in PROBABILITY, only in
/// VOLUME: because `blowup | lde/2`, `pos` is trace-aligned iff its mirror is. So
/// Route C never makes a proof leak a raw trace row at a position the baseline
/// would not also have leaked — but when a query does land trace-aligned it now
/// exposes FOUR raw rows instead of two.
///
/// This matters because the LDE has no coset offset (see
/// `stark-lde-no-coset-witness-leak-2026-07-27`): raw trace rows in a proof are a
/// live witness leak, and Route C doubles the volume per unlucky query. The coset
/// fix is a separate, still-outstanding change.
#[test]
fn mirror_is_trace_aligned_exactly_when_position_is() {
    for cfg in SHIPPING {
        let n = cfg.lde_size;
        let half = n / 2;
        let b = cfg.blowup;
        for pos in 0..n {
            assert_eq!(
                pos % b == 0,
                (pos ^ half) % b == 0,
                "alignment parity differs at pos={pos}, lde={n}",
            );
            assert_eq!(
                ((pos + b) % n) % b == 0,
                (((pos + b) % n) ^ half) % b == 0,
            );
        }
    }
}

/// The other half of the amplification claim: the mirror row is not a copy of the
/// row at `pos`, it is a DIFFERENT trace row. Together with
/// `mirror_is_trace_aligned_exactly_when_position_is` this pins "an unlucky query
/// exposes four genuine trace rows instead of two" as arithmetic rather than
/// commentary.
///
/// For an aligned `pos = r * blowup`, the mirror is `pos ^ (lde/2)`. Because
/// `lde/2 = (trace_length/2) * blowup`, that is trace row
/// `(r + trace_length/2) mod trace_length` — the maximally distant row, half the
/// trace away. On C1 (`trace_length == 128`) it is `r + 64`.
#[test]
fn mirror_row_is_a_different_trace_row() {
    for cfg in SHIPPING {
        let n = cfg.lde_size;
        let half = n / 2;
        let b = cfg.blowup;
        let tl = cfg.trace_length;

        assert_eq!(half % b, 0, "blowup must divide lde/2 for the mirror to be aligned");
        assert_eq!(half / b, tl / 2, "mirror offset in trace rows must be trace_length/2");

        for r in 0..tl {
            let pos = r * b;
            let mirror = pos ^ half;
            assert_eq!(mirror % b, 0, "mirror of an aligned position must be aligned");
            let mirror_row = mirror / b;
            assert_eq!(
                mirror_row,
                (r + tl / 2) % tl,
                "mirror of trace row {r} must be row {} (lde={n}, blowup={b})",
                (r + tl / 2) % tl,
            );
            assert_ne!(
                mirror_row, r,
                "the mirror row must be a DIFFERENT trace row, or there is no \
                 amplification to report",
            );
        }
    }
}

// ============================================================================
// 6. POSITIVE — the mirror slot really holds the row at the mirror position
// ============================================================================

/// The tamper tests show the mirror row is bound to `trace_root`. They do NOT by
/// themselves show it is the row at `pos ^ (lde/2)` rather than some other
/// committed row. This does.
///
/// Search seeds until some proof has two queries `a`, `b` with
/// `pos_b == pos_a ^ half`. When that happens `row(pos_b)` is on the wire twice:
/// once as query `b`'s own trace row, once as query `a`'s mirror row. They must be
/// byte-identical. The test panics rather than silently skipping if it never
/// occurs.
#[test]
fn mirror_slot_holds_the_row_at_the_mirror_position() {
    let cfg = &CONFIG_POOL_COMMITMENT;
    let half = cfg.lde_size / 2;
    let mut checked = 0usize;

    for seed in 0..40u64 {
        let data = p01_stark::compact::generate_pool_commitment_proof(
            seed.wrapping_mul(0x9E37_79B9_7F4A_7C15),
            seed + 1,
            seed + 2,
            seed + 3,
        );
        let (_, row_len) = trace_block_offsets(cfg, &data.proof_bytes, 0);
        let proof = GenericCompactProof::from_bytes(&data.proof_bytes, cfg).expect("parse");

        for a in 0..proof.queries.len() {
            for b in 0..proof.queries.len() {
                let pa = proof.queries[a].position as usize;
                let pb = proof.queries[b].position as usize;
                if pb != pa ^ half {
                    continue;
                }
                let (base_a, _) = trace_block_offsets(cfg, &data.proof_bytes, a);
                let (base_b, _) = trace_block_offsets(cfg, &data.proof_bytes, b);
                let mirror_of_a = &data.proof_bytes[base_a + row_len..base_a + 2 * row_len];
                let row_of_b = &data.proof_bytes[base_b..base_b + row_len];
                assert_eq!(
                    mirror_of_a, row_of_b,
                    "query {a}'s mirror slot (pos {pa}) must equal query {b}'s own row (pos {pb})",
                );
                checked += 1;
            }
        }
        if checked >= 4 {
            break;
        }
    }

    assert!(
        checked > 0,
        "no mirror-pair collision found in 40 seeds — this test proved nothing",
    );
}

// ============================================================================
// 7. WIRE SIZE — the closed form, on every shipping circuit
// ============================================================================

/// Route C's byte delta is `nq * (16*trace_width - 64)` per circuit: two extra
/// rows (`+2 * tw * 8`) minus two Merkle levels (`-2 * 32`) per query. Pin the
/// absolute post-Route-C size of ALL SEVEN shipping circuits against that form,
/// from the pre-Route-C measured baseline.
///
/// All seven, not four. A first cut of this test covered C0, C1, C2 and C4 only —
/// which happens to be exactly the set whose size shrank or stayed put. C3
/// (+704), C5 (+1,056) and C6 (+2,112) are the circuits that GREW, and they had
/// no committed size or format pin at all. The `cu_budget` harness prints their
/// sizes but asserts nothing about them, so a Route C layout drift on the three
/// largest circuits was caught by nothing.
///
/// Witness args match `tests/cu_budget.rs` so the numbers here and the numbers the
/// harness prints are the same measurement. (Proof size is witness-independent —
/// every field is fixed-width and every path is fixed-depth — but keeping the args
/// aligned means a reader can diff the two files directly.)
#[test]
fn route_c_wire_sizes_match_the_closed_form() {
    // (label, pre-Route-C measured bytes, config, actual bytes)
    let cases: Vec<(&str, usize, &CircuitConfig, usize)> = vec![
        ("C0", 45_433, &CONFIG_SUBSCRIBER_OWNERSHIP,
            p01_stark::compact::generate_compact_proof(42).proof_bytes.len()),
        ("C1", 66_233, &CONFIG_POOL_COMMITMENT,
            p01_stark::compact::generate_pool_commitment_proof(42, 17, 7, 11).proof_bytes.len()),
        ("C2", 66_681, &CONFIG_BALANCE_PROOF,
            p01_stark::compact::generate_balance_compact_proof(42, 1000, 777, 999)
                .proof_bytes.len()),
        ("C3", 74_933, &CONFIG_MERKLE_PATH, {
            let pe: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
            let pi: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
            p01_stark::compact::generate_merkle_path_compact_proof(777, &pe, &pi)
                .proof_bytes
                .len()
        }),
        ("C4", 78_377, &CONFIG_CONFIDENTIAL_BALANCE, {
            let (a, b, c, d, e, f, g, h) = C4_ARGS;
            p01_stark::compact::generate_confidential_balance_compact_proof(
                a, b, c, d, e, f, g, h,
            )
            .proof_bytes
            .len()
        }),
        ("C5", 75_301, &CONFIG_TRANSFER,
            p01_stark::compact::generate_transfer_compact_proof(
                13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50,
            )
            .proof_bytes
            .len()),
        ("C6", 76_405, &CONFIG_MERKLE_UPDATE, {
            let pe: Vec<u64> = (0..12).map(|i| 100u64 + i * 13).collect();
            let pi: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();
            p01_stark::compact::generate_merkle_update_compact_proof(111, 222, &pe, &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len()))
                .proof_bytes
                .len()
        }),
    ];

    assert_eq!(cases.len(), SHIPPING.len(), "one case per shipping circuit, or this test is partial");

    // Absolute post-Route-C sizes, MEASURED with the `cu_budget` harness. Pinned
    // as literals as well as via the closed form: the closed form alone would stay
    // green if BOTH the baseline and the actual size drifted by the same amount.
    // [B2] Post-segmentation absolute sizes, MEASURED with `cross_language_fixture_digests`.
    let absolute: [usize; 7] = [47_641, 68_881, 69_761, 78_157, 81_457, 78_877, 81_037];

    for (i, (label, baseline, cfg, actual)) in cases.into_iter().enumerate() {
        // Two independent terms against the SAME pre-Route-C baseline. Keeping
        // them apart is the point: a lumped delta would let a Route C regression
        // hide inside a B2 gain.
        let route_c_delta = cfg.num_queries as i64 * (16 * cfg.trace_width as i64 - 64);
        let b2_delta =
            8 * (cfg.quotient_segments as i64 - 1) * (2 * cfg.num_queries as i64 + 1);
        let expected_delta = route_c_delta + b2_delta;
        let measured_delta = actual as i64 - baseline as i64;
        assert_eq!(
            measured_delta, expected_delta,
            "{label}: byte delta {measured_delta} != closed form \
             nq*(16*tw-64) + 8*(k-1)*(2*nq+1) = {route_c_delta} + {b2_delta} \
             (baseline {baseline}, actual {actual})",
        );
        assert_eq!(
            actual, absolute[i],
            "{label}: absolute post-B2 size drifted (expected {}, got {actual})",
            absolute[i],
        );

        // And re-derive the size from the config independently of the generator, so
        // a serializer change that happens to preserve the delta still trips.
        let tw = cfg.trace_width;
        let md = cfg.merkle_depth;
        let nq = cfg.num_queries;
        let ks = cfg.quotient_segments;
        let num_commits = (cfg.lde_size / cfg.fri_final_poly_size).trailing_zeros() as usize - 1;
        let fri_per_query: usize = (0..num_commits).map(|k| 16 + (md - k - 2) * 32).sum();
        let from_config = 32 + 32 + tw * 8 + tw * 8 + 8 + 8 * ks
            + 1 + num_commits * 32
            + 2 + cfg.fri_final_poly_size * 8
            + 8 + 2
            + nq * (4 + 4 * (tw * 8) + 2 * ((md - 1) * 32) + 8 * ks + (md - 1) * 32
                + fri_per_query)
            + nq * 8 * ks;
        assert_eq!(
            actual, from_config,
            "{label}: generator size {actual} != wire layout re-derived from config \
             {from_config}",
        );
    }
}
