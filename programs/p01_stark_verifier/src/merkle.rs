/// Blake3 Merkle tree verification for STARK proofs.
use blake3;

use crate::goldilocks::Felt;

/// Verify a Merkle path for a leaf at the given index.
/// Returns true if the path leads to the expected root.
pub fn verify_merkle_path(
    root: &[u8; 32],
    leaf_data: &[u8],
    index: usize,
    path: &[[u8; 32]],
) -> bool {
    let mut current = blake3::hash(leaf_data);

    let mut idx = index;
    for sibling in path {
        let combined = if idx & 1 == 0 {
            // current is left child
            hash_pair(current.as_bytes(), sibling)
        } else {
            // current is right child
            hash_pair(sibling, current.as_bytes())
        };
        current = combined;
        idx >>= 1;
    }

    current.as_bytes() == root
}

/// Hash two 32-byte nodes together to form a parent.
#[inline]
fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> blake3::Hash {
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(left);
    data[32..].copy_from_slice(right);
    blake3::hash(&data)
}

/// Compute Blake3 Merkle root from an array of field element rows.
/// Each leaf is the hash of a row of field elements.
pub fn compute_root(leaves: &[Vec<Felt>]) -> [u8; 32] {
    let leaf_hashes: Vec<[u8; 32]> = leaves
        .iter()
        .map(|row| {
            let bytes: Vec<u8> = row.iter().flat_map(|f| f.to_le_bytes()).collect();
            *blake3::hash(&bytes).as_bytes()
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
            next_level.push(*hash_pair(&chunk[0], &chunk[1]).as_bytes());
        } else {
            next_level.push(chunk[0]);
        }
    }

    merkle_root_from_hashes(&next_level)
}
