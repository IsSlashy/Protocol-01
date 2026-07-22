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

    let mut current: [u8; 32] = hashv(&[leaf_data]).to_bytes();

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

/// Hash two 32-byte nodes together to form a parent.
#[inline]
fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[left, right]).to_bytes()
}

/// Compute the SHA-256 Merkle root from an array of field element rows.
/// Each leaf is the hash of a row of field elements.
pub fn compute_root(leaves: &[Vec<Felt>]) -> [u8; 32] {
    let leaf_hashes: Vec<[u8; 32]> = leaves
        .iter()
        .map(|row| {
            let bytes: Vec<u8> = row.iter().flat_map(|f| f.to_le_bytes()).collect();
            hashv(&[&bytes]).to_bytes()
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
