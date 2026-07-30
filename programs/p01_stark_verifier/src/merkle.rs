/// SHA-256 Merkle tree verification for STARK proofs.
///
/// **[P1.6 CU fix]** On-chain hashing uses `solana_sha256_hasher::hashv`, which
/// maps to the native `sol_sha256` syscall on BPF (~85 CU per 64-byte pair).
/// Previously used Blake3, but `sol_blake3` is gated behind a feature that
/// is inactive on devnet/mainnet, forcing software Blake3 (~15k+ CU/hash)
/// which overflowed the 1.4M CU cap. Off-chain (tests, host), `solana-sha256-
/// hasher` falls back to `sha2::Sha256` — results are bit-identical.
use solana_sha256_hasher::hashv;

use crate::goldilocks::Felt;

/// Domain-separation tag prefixed to every LEAF preimage.
///
/// # Why the tags exist
///
/// Untagged, this tree hashed a leaf as `SHA256(preimage)` and an internal node
/// as `SHA256(left ‖ right)` — the same function. For any 64-byte string `X`
/// the tree could not distinguish "leaf with preimage `X`" from "parent of the
/// children `X[..32]`, `X[32..]`", and `verify_merkle_path` resolves that
/// ambiguity in whichever direction the prover asks for: it hashes the bytes it
/// is handed as a leaf and walks the siblings it is handed. So a genuine
/// internal node `N = H(L0 ‖ L1)` could be re-presented as a leaf whose
/// preimage is `L0 ‖ L1`, with `N`'s own siblings as the path, and the walk
/// landed on the real root. That accepts a leaf that never existed, at a
/// tree index that was never a leaf index.
///
/// With the tags, `leaf = H(0x00 ‖ preimage)` and `node = H(0x01 ‖ l ‖ r)` are
/// different functions on the same bytes, so no node preimage is ever a valid
/// leaf preimage.
///
/// # Why now, before Route C
///
/// The colliding shape needs a 64-byte leaf preimage. Today's leaves are trace
/// rows (`trace_width * 8` bytes — no shipping circuit is width 8) and B4 pair
/// leaves (16 bytes), so nothing lines up yet. Route C makes trace leaves
/// `H(row[j] ‖ row[j + lde/2])` = `2 * trace_width * 8` bytes, which is exactly
/// 64 at `trace_width == 4` — C2 and C4. The tags must be in place before that
/// lands, not after.
///
/// # Cost
///
/// The tag lives in the hash PREIMAGE, never on the wire. On BPF the
/// `sol_sha256` cost model charges `85 + Σ max(10, len_i / 2)` per call, so a
/// 1-byte segment adds the 10-CU floor per hash — that part is the documented
/// cost model, not a measurement.
///
/// MEASURED with the `cu_budget` harness (litesvm, real SBF bytecode), tagged
/// `.so` sha256 `e879bf30…` / 638,088 B against the untagged baseline
/// `b5c7e01d…` / 637,968 B:
///
/// ```text
///   circuit   phase-1 CU before -> after      delta         proof bytes
///   C0            464,141 ->   480,335     +16,194 (+3.5%)   45,433 unchanged
///   C1            588,303 ->   617,570     +29,267 (+5.0%)   66,233 unchanged
///   C2            588,685 ->   618,739     +30,054 (+5.1%)   66,681 unchanged
///   C3            628,028 ->   659,366     +31,338 (+5.0%)   74,933 unchanged
///   C4            672,124 ->   704,685     +32,561 (+4.8%)   78,377 unchanged
///   C5            629,228 ->   658,596     +29,368 (+4.7%)   75,301 unchanged
///   C6            628,737 ->   661,697     +32,960 (+5.2%)   76,405 unchanged
/// ```
///
/// Proof size is unchanged on all seven — a tag that moved a single wire byte
/// would be a tag put on the wire by mistake. Worst phase-1 is C4 at 704,685 CU,
/// 50.3% of the 1,400,000 cap, so ~695K headroom remains for Route C and C7.
pub const MERKLE_LEAF_TAG: u8 = 0x00;

/// Domain-separation tag prefixed to every INTERNAL-NODE preimage.
/// See [`MERKLE_LEAF_TAG`].
pub const MERKLE_NODE_TAG: u8 = 0x01;

/// Verify a Merkle path for a leaf at the given index.
///
/// `path` is a flat byte slice of concatenated 32-byte siblings; length must
/// be a multiple of 32. Returns true iff the path leads to the expected root.
///
/// **[P1.6]** Accepts `&[u8]` instead of `&[[u8;32]]` so callers can pass
/// borrowed slices carved out of the proof buffer without any `Vec<[u8;32]>`
/// materialization — that owned-array parse used to blow past the default
/// 32KB BPF heap on multi-query proofs.
pub fn verify_merkle_path(
    root: &[u8; 32],
    leaf_data: &[u8],
    index: usize,
    path: &[u8],
) -> bool {
    if path.len() % 32 != 0 {
        return false;
    }

    let mut current: [u8; 32] = hash_leaf(leaf_data);

    let mut idx = index;
    for sibling_slice in path.chunks_exact(32) {
        let sibling: &[u8; 32] = sibling_slice.try_into().unwrap();
        current = if idx & 1 == 0 {
            hash_pair(&current, sibling)
        } else {
            hash_pair(sibling, &current)
        };
        idx >>= 1;
    }

    &current == root
}

/// Verify a Merkle path whose leaf preimage is the concatenation of TWO
/// borrowed slices, without copying them into one buffer.
///
/// Identical to [`verify_merkle_path`] in every respect except the leaf
/// segmentation; the resulting leaf hash is bit-identical to hashing the
/// concatenation. Provided here, already tagged, so that a pair-leaf trace
/// tree (Route C) has a tagged entry point to call and never needs to open-code
/// `hashv` on a leaf again.
pub fn verify_merkle_path_2seg(
    root: &[u8; 32],
    leaf_a: &[u8],
    leaf_b: &[u8],
    index: usize,
    path: &[u8],
) -> bool {
    if path.len() % 32 != 0 {
        return false;
    }

    let mut current: [u8; 32] = hash_leaf_2seg(leaf_a, leaf_b);

    let mut idx = index;
    for sibling_slice in path.chunks_exact(32) {
        let sibling: &[u8; 32] = sibling_slice.try_into().unwrap();
        current = if idx & 1 == 0 {
            hash_pair(&current, sibling)
        } else {
            hash_pair(sibling, &current)
        };
        idx >>= 1;
    }

    &current == root
}

/// Hash a leaf preimage: `H(0x00 ‖ preimage)`.
///
/// EVERY leaf in EVERY tree this verifier checks goes through here or through
/// [`hash_leaf_2seg`]. A tree with only some of its leaves tagged is worse than
/// an untagged one, because it looks finished.
#[inline]
pub fn hash_leaf(leaf_data: &[u8]) -> [u8; 32] {
    hashv(&[&[MERKLE_LEAF_TAG], leaf_data]).to_bytes()
}

/// Hash a leaf preimage supplied as TWO borrowed segments:
/// `H(0x00 ‖ a ‖ b)`.
///
/// `hashv` concatenates its arguments, so this is bit-identical to
/// `hash_leaf(&[a ‖ b])`. The split form exists so a caller can hash two
/// slices carved out of the proof buffer without materializing the
/// concatenation on the BPF stack — which is what a Route-C pair-leaf trace
/// opening needs (`2 * trace_width * 8` bytes, up to 160 for C6).
#[inline]
pub fn hash_leaf_2seg(a: &[u8], b: &[u8]) -> [u8; 32] {
    hashv(&[&[MERKLE_LEAF_TAG], a, b]).to_bytes()
}

/// Hash two 32-byte nodes together to form a parent: `H(0x01 ‖ left ‖ right)`.
#[inline]
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[MERKLE_NODE_TAG], left, right]).to_bytes()
}

/// Compute Blake3 Merkle root from an array of field element rows.
/// Each leaf is the hash of a row of field elements.
pub fn compute_root(leaves: &[Vec<Felt>]) -> [u8; 32] {
    let leaf_hashes: Vec<[u8; 32]> = leaves
        .iter()
        .map(|row| {
            let bytes: Vec<u8> = row.iter().flat_map(|f| f.to_le_bytes()).collect();
            hash_leaf(&bytes)
        })
        .collect();

    merkle_root_from_hashes(&leaf_hashes)
}

fn merkle_root_from_hashes(hashes: &[[u8; 32]]) -> [u8; 32] {
    if hashes.len() == 1 {
        return hashes[0];
    }

    let mut next_level = Vec::with_capacity(hashes.len() / 2);
    for chunk in hashes.chunks(2) {
        if chunk.len() == 2 {
            next_level.push(hash_pair(&chunk[0], &chunk[1]));
        } else {
            next_level.push(chunk[0]);
        }
    }

    merkle_root_from_hashes(&next_level)
}
