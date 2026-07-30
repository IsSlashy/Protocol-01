//! Merkle domain separation — the two tests that must be RED before tags exist.
//!
//! # The hole
//!
//! Without tags, this tree hashes a leaf as `SHA256(preimage)` and an internal
//! node as `SHA256(left ‖ right)`. Those are the SAME function. For any 64-byte
//! string `X` the tree cannot tell whether `SHA256(X)` was meant as
//!
//!   * a leaf whose 64-byte preimage happens to be `X`, or
//!   * the parent of the two 32-byte children `X[..32]`, `X[32..]`.
//!
//! `verify_merkle_path` picks the interpretation the *prover* wants: it hashes
//! whatever bytes it is handed as a leaf, then walks the supplied siblings. So a
//! prover can take a GENUINE internal node `N = H(L0 ‖ L1)`, present the 64-byte
//! string `L0 ‖ L1` as a leaf preimage, hand over the siblings from `N`'s level
//! upward, and the walk lands on the real root. The tree accepts a node that was
//! never a leaf, at an index that was never that node's index.
//!
//! # Why this is not theoretical for THIS repo
//!
//! Pre-Route-C the collision needed a trace row of exactly 64 bytes
//! (`trace_width == 8` — no shipping circuit has that) or a 64-byte pair leaf
//! (pair leaves are 16 bytes). Route C HAS NOW LANDED: trace leaves are
//! `H(row[j] ‖ row[j + lde/2])`, i.e. `2 * trace_width * 8` bytes — exactly 64 at
//! `trace_width == 4`, which is C2 and C4. So the colliding shape is reachable
//! with two shipping configs as of today, not hypothetically. These tags are what
//! stops it; they landed one step ahead of the leaf shape that needs them, and
//! removing them now would re-open the hole on live circuits.
//!
//! # These tests are gates, not decoration
//!
//! Both assertions FAIL on the untagged tree. That red run is the proof that
//! they can fail at all; a domain-separation test that is green before the
//! domain separation exists is measuring nothing.

use p01_stark_verifier::merkle::{
    hash_leaf, hash_leaf_2seg, hash_pair, verify_merkle_path, verify_merkle_path_2seg,
    MERKLE_LEAF_TAG, MERKLE_NODE_TAG,
};

// ============================================================================
// STALENESS — a red here must never be mistaken for "the tags are broken"
// ============================================================================

/// `src/merkle.rs` as it was AT COMPILE TIME of this test binary.
///
/// This `include_str!` is load-bearing twice over, and is not documentation:
///
///  1. It makes `src/merkle.rs` a tracked input of THIS test target (rustc
///     emits it into the dep-info cargo fingerprints on), so cargo must rebuild
///     the test whenever the tags move. Round 2 of this step was rejected
///     because a reviewer ran the gate against a test exe that predated the
///     rlib it linked — exe 02:48:32, rlib 02:49:13 — and collected two
///     spurious REDs on the one gate this step exists to add.
///  2. It lets the test compare compile-time source against on-disk source at
///     RUNTIME, so a stale binary announces itself by name instead of
///     impersonating a broken change and inviting the next agent to revert it.
const EMBEDDED_MERKLE_SRC: &str = include_str!("../src/merkle.rs");

const MERKLE_SRC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/merkle.rs");

/// The three call sites that actually hash, as literal source text. Matched as
/// substrings against the on-disk file so [`diagnosis`] can tell "someone
/// reverted the tags" apart from "this binary is stale". Matching the doc
/// comment instead would match even after a revert, which is the whole failure
/// mode being guarded against.
const TAGGED_IMPL_SITES: [&str; 3] = [
    "hashv(&[&[MERKLE_LEAF_TAG], leaf_data])",
    "hashv(&[&[MERKLE_LEAF_TAG], a, b])",
    "hashv(&[&[MERKLE_NODE_TAG], left, right])",
];

/// Verdict on WHY a domain-separation assertion just failed, appended to every
/// assertion in this file whose failure would otherwise be ambiguous.
///
/// Distinguishes three states that look identical in a bare assert output:
///
/// | on-disk source vs compiled-in | tagged sites on disk | verdict            |
/// |-------------------------------|----------------------|--------------------|
/// | differ                        | (not consulted)      | stale test binary  |
/// | same                          | all present          | stale linked rlib  |
/// | same                          | missing              | genuine regression |
fn diagnosis() -> String {
    let on_disk = match std::fs::read_to_string(MERKLE_SRC_PATH) {
        Ok(s) => s,
        Err(e) => {
            return format!("\n\n  [diagnosis unavailable: cannot read {MERKLE_SRC_PATH}: {e}]")
        }
    };

    if on_disk != EMBEDDED_MERKLE_SRC {
        return format!(
            "\n\n  >>> STALE TEST BINARY -- DO NOT REVERT THE TAGS <<<\
             \n  {MERKLE_SRC_PATH}\
             \n  on disk differs from the copy compiled into this exe, so the\
             \n  failure above describes the OLD bytes and says nothing about\
             \n  the current source. Rebuild, and require a literal\
             \n  `Compiling p01_stark_verifier` line in the log before believing\
             \n  any result from this file."
        );
    }

    let missing: Vec<&str> = TAGGED_IMPL_SITES
        .iter()
        .copied()
        .filter(|site| !on_disk.contains(site))
        .collect();

    if missing.is_empty() {
        format!(
            "\n\n  >>> LIKELY STALE LINKED rlib -- DO NOT REVERT THE TAGS <<<\
             \n  All three tagged hash sites ARE present in\
             \n  {MERKLE_SRC_PATH},\
             \n  so the source is right and this test is linked against an older\
             \n  libp01_stark_verifier.rlib. `cargo clean -p` does not reliably\
             \n  clear it; hand-delete target/release/deps/libp01_stark_verifier.rlib\
             \n  and target/release/.fingerprint/p01_stark_verifier-* and rebuild."
        )
    } else {
        format!(
            "\n\n  >>> GENUINE REGRESSION: the tags are gone from the source <<<\
             \n  missing from {MERKLE_SRC_PATH}:\
             \n  {missing:#?}"
        )
    }
}

/// The gate's own precondition: this exe was built from the source now on disk.
///
/// Every other test in this file is a statement about the compiled verifier. If
/// the compiled verifier is not the source on disk, none of them mean what they
/// appear to mean — in either direction. Red here invalidates the whole file
/// rather than any one assertion, which is why it is a separate test.
#[test]
fn this_test_binary_was_built_from_the_source_on_disk() {
    let on_disk = std::fs::read_to_string(MERKLE_SRC_PATH)
        .unwrap_or_else(|e| panic!("cannot read {MERKLE_SRC_PATH}: {e}"));

    assert_eq!(
        on_disk.len(),
        EMBEDDED_MERKLE_SRC.len(),
        "{MERKLE_SRC_PATH} is {} bytes on disk but {} bytes as compiled into \
         this test exe -- the binary is STALE and every other result in this \
         file is meaningless. Rebuild.",
        on_disk.len(),
        EMBEDDED_MERKLE_SRC.len(),
    );
    assert!(
        on_disk == EMBEDDED_MERKLE_SRC,
        "{MERKLE_SRC_PATH} has the same length as the copy compiled into this \
         test exe but different bytes -- still STALE. Rebuild."
    );

    // Cheap independent confirmation that the source really is the tagged one,
    // so a green run of this file is a claim about tagged code specifically.
    for site in TAGGED_IMPL_SITES {
        assert!(
            on_disk.contains(site),
            "tagged hash site missing from {MERKLE_SRC_PATH}: {site}"
        );
    }
}

/// A 64-byte payload with no structure — the point is only that it is 64 bytes,
/// so it is simultaneously a legal leaf preimage and a legal (left ‖ right).
fn payload_64() -> [u8; 64] {
    let mut x = [0u8; 64];
    for (i, b) in x.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(7).wrapping_add(3);
    }
    x
}

// ============================================================================
// (a) COLLISION — leaf and internal node must not be the same function
// ============================================================================

/// The same 64 bytes hashed as a leaf and as an internal node must differ.
///
/// RED before the tags: both sides are `SHA256(x)` and the assert fires.
#[test]
fn leaf_and_node_hashes_of_the_same_64_bytes_differ() {
    let x = payload_64();
    let left: [u8; 32] = x[..32].try_into().unwrap();
    let right: [u8; 32] = x[32..].try_into().unwrap();

    let as_leaf = hash_leaf(&x);
    let as_node = hash_pair(&left, &right);

    assert_ne!(
        as_leaf,
        as_node,
        "leaf hash and internal-node hash of the SAME 64 bytes are identical — \
         the tree has no domain separation, so a genuine internal node can be \
         replayed as a leaf preimage{}",
        diagnosis()
    );
}

/// The two-segment leaf entry point must agree with the one-segment one.
///
/// Route C hashes `row_lo` and `row_hi` as separate borrowed slices; if that
/// path ever drifted from the contiguous form the prover uses, honest proofs
/// would fail — and if it drifted by *dropping* the tag, the collision would
/// come back through a side door.
#[test]
fn two_segment_leaf_matches_contiguous_leaf() {
    let x = payload_64();
    assert_eq!(
        hash_leaf(&x),
        hash_leaf_2seg(&x[..32], &x[32..]),
        "hash_leaf_2seg must be bit-identical to hash_leaf over the concatenation"
    );
}

/// The two-segment leaf must also differ from the internal node over the same
/// bytes — the tag has to be on the 2-seg path too, not only the 1-seg one.
#[test]
fn two_segment_leaf_differs_from_node() {
    let x = payload_64();
    let left: [u8; 32] = x[..32].try_into().unwrap();
    let right: [u8; 32] = x[32..].try_into().unwrap();

    assert_ne!(
        hash_leaf_2seg(&x[..32], &x[32..]),
        hash_pair(&left, &right),
        "two-segment leaf hash collides with the internal-node hash{}",
        diagnosis()
    );
}

// ============================================================================
// (b) STRUCTURAL — a genuine internal node presented in a leaf position
// ============================================================================

/// A 4-leaf tree, returned as (root, leaf hashes, level-1 nodes).
///
/// ```text
///            root = P(N01, N23)
///           /                  \
///     N01 = P(L0,L1)      N23 = P(L2,L3)
///      /      \             /      \
///    L0       L1          L2       L3
/// ```
///
/// Leaves are hashes of arbitrary 24-byte preimages, matching the shape of a
/// real 3-column trace row. Nothing about the attack depends on the leaf
/// preimage length — only on the fact that an internal node's preimage
/// (64 bytes) is also a legal leaf preimage.
fn four_leaf_tree() -> ([u8; 32], [[u8; 32]; 4], [[u8; 32]; 2]) {
    let leaf_preimages: [[u8; 24]; 4] = [[0xA1; 24], [0xB2; 24], [0xC3; 24], [0xD4; 24]];
    let mut leaves = [[0u8; 32]; 4];
    for (i, p) in leaf_preimages.iter().enumerate() {
        leaves[i] = hash_leaf(p);
    }

    let n01 = hash_pair(&leaves[0], &leaves[1]);
    let n23 = hash_pair(&leaves[2], &leaves[3]);
    let root = hash_pair(&n01, &n23);

    (root, leaves, [n01, n23])
}

/// Sanity: an HONEST opening of leaf 0 verifies. If this ever goes red the
/// structural test below proves nothing, because rejection would be universal.
#[test]
fn honest_leaf_opening_verifies() {
    let (root, leaves, nodes) = four_leaf_tree();

    let mut path = Vec::with_capacity(64);
    path.extend_from_slice(&leaves[1]); // sibling at level 0
    path.extend_from_slice(&nodes[1]); // sibling at level 1

    assert!(
        verify_merkle_path(&root, &[0xA1; 24], 0, &path),
        "the honest opening of leaf 0 must verify — otherwise the negative \
         test below is vacuous"
    );
}

/// Present the GENUINE internal node `N01` as if it were a leaf, and demand
/// rejection.
///
/// The forged opening is fully self-consistent under the untagged rules:
///
/// ```text
///   claimed leaf preimage : L0 ‖ L1          (64 bytes, the real preimage of N01)
///   claimed leaf index    : 0                (N01's index at level 1)
///   claimed path          : [N23]            (N01's real sibling at level 1)
/// ```
///
/// Untagged, the walk computes `SHA256(L0 ‖ L1) = N01`, then
/// `P(N01, N23) = root`, and returns true — a leaf that does not exist is
/// accepted against the real root. Tagged, the walk computes
/// `H(0x00 ‖ L0 ‖ L1) != H(0x01 ‖ L0 ‖ L1) = N01` and the root check fails.
///
/// RED before the tags.
#[test]
fn genuine_internal_node_is_rejected_in_a_leaf_position() {
    let (root, leaves, nodes) = four_leaf_tree();

    // The exact 64 bytes the tree hashed to produce N01.
    let mut forged_leaf_preimage = [0u8; 64];
    forged_leaf_preimage[..32].copy_from_slice(&leaves[0]);
    forged_leaf_preimage[32..].copy_from_slice(&leaves[1]);

    // The forgery only works if that preimage really is N01's — assert it, so a
    // future refactor that changes the node preimage turns this into a loud
    // failure rather than a silently-toothless test.
    assert_eq!(
        hash_pair(&leaves[0], &leaves[1]),
        nodes[0],
        "test setup drifted: forged preimage is not N01's preimage"
    );

    // One sibling => a depth-1 walk, which is where N01 actually sits.
    let path = nodes[1].to_vec();

    assert!(
        !verify_merkle_path(&root, &forged_leaf_preimage, 0, &path),
        "a GENUINE internal node was accepted as a leaf: the verifier hashed \
         N01's own 64-byte preimage as a leaf and walked to the real root{}",
        diagnosis()
    );
}

/// Same attack one level up: the root's own preimage `N01 ‖ N23` presented as a
/// leaf with an EMPTY path. Untagged this makes the root a valid opening of
/// itself at depth 0.
#[test]
fn root_preimage_is_rejected_as_a_zero_depth_leaf() {
    let (root, _leaves, nodes) = four_leaf_tree();

    let mut forged = [0u8; 64];
    forged[..32].copy_from_slice(&nodes[0]);
    forged[32..].copy_from_slice(&nodes[1]);

    assert!(
        !verify_merkle_path(&root, &forged, 0, &[]),
        "the root's own preimage was accepted as a depth-0 leaf opening{}",
        diagnosis()
    );
}

/// The same forgery through the two-segment entry point Route C will use.
/// `verify_merkle_path_2seg` splits the leaf preimage exactly where an internal
/// node splits, so it is the most natural place for the tag to be forgotten.
#[test]
fn genuine_internal_node_is_rejected_through_the_2seg_path() {
    let (root, leaves, nodes) = four_leaf_tree();
    let path = nodes[1].to_vec();

    assert!(
        !verify_merkle_path_2seg(&root, &leaves[0], &leaves[1], 0, &path),
        "the two-segment leaf path accepted a genuine internal node as a leaf{}",
        diagnosis()
    );
}

/// An HONEST opening of an UNTAGGED tree must now be rejected.
///
/// The three tests above compare the verifier's helpers to each other, so they
/// would stay green if someone tagged both sides with the *same* byte, or
/// tagged them in a way that never reached `verify_merkle_path`. This one
/// builds the tree the OLD way — raw `SHA256(preimage)` leaves, raw
/// `SHA256(l ‖ r)` nodes, no helper from the crate under test — and demands
/// rejection. It is the assertion that the on-chain leaf/node functions really
/// moved, not just that two exported helpers happen to differ.
#[test]
fn honest_opening_of_an_untagged_tree_is_rejected() {
    use solana_sha256_hasher::hashv;

    let untagged_leaf = |d: &[u8]| -> [u8; 32] { hashv(&[d]).to_bytes() };
    let untagged_node =
        |l: &[u8; 32], r: &[u8; 32]| -> [u8; 32] { hashv(&[l, r]).to_bytes() };

    let preimages: [[u8; 24]; 4] = [[0xA1; 24], [0xB2; 24], [0xC3; 24], [0xD4; 24]];
    let l: Vec<[u8; 32]> = preimages.iter().map(|p| untagged_leaf(p)).collect();
    let n01 = untagged_node(&l[0], &l[1]);
    let n23 = untagged_node(&l[2], &l[3]);
    let untagged_root = untagged_node(&n01, &n23);

    let mut path = Vec::with_capacity(64);
    path.extend_from_slice(&l[1]);
    path.extend_from_slice(&n23);

    assert!(
        !verify_merkle_path(&untagged_root, &preimages[0], 0, &path),
        "the verifier still accepts an untagged tree — the tags did not reach \
         verify_merkle_path, so the on-chain hashing is unchanged{}",
        diagnosis()
    );
}

// ============================================================================
// CROSS-CRATE — the prover must tag the same way, or nothing verifies
// ============================================================================

/// Prover and on-chain verifier declare these tags independently, in two
/// crates, with no shared constant. If one side is edited alone every honest
/// proof breaks; this is the cheap tripwire that says which side moved.
///
/// It is a *tripwire*, not the real gate. The real gate is the full harness:
/// prover-built trees only open against verifier-computed roots if both sides
/// hash identically, tags included.
#[test]
fn prover_and_verifier_agree_on_tags() {
    assert_eq!(
        MERKLE_LEAF_TAG,
        p01_stark::compact::MERKLE_LEAF_TAG,
        "prover and verifier disagree on the Merkle LEAF tag"
    );
    assert_eq!(
        MERKLE_NODE_TAG,
        p01_stark::compact::MERKLE_NODE_TAG,
        "prover and verifier disagree on the Merkle NODE tag"
    );
    assert_ne!(
        MERKLE_LEAF_TAG, MERKLE_NODE_TAG,
        "the two tags are equal, which is the same as having no tags at all"
    );
}
