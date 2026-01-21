use anchor_lang::prelude::*;

/// Merkle tree state stored on-chain
/// Uses sparse storage for efficiency - only stores non-empty nodes
#[account]
#[derive(Default)]
pub struct MerkleTreeState {
    /// Associated shielded pool
    pub pool: Pubkey,

    /// Current root hash
    pub root: [u8; 32],

    /// Number of leaves inserted
    pub leaf_count: u64,

    /// Tree depth
    pub depth: u8,

    /// Filled subtrees (optimization for insertion)
    /// Stores the rightmost filled node at each level
    pub filled_subtrees: Vec<[u8; 32]>,

    /// Bump seed for PDA
    pub bump: u8,
}

impl MerkleTreeState {
    /// Account size calculation
    pub const LEN: usize = 8 // discriminator
        + 32  // pool
        + 32  // root
        + 8   // leaf_count
        + 1   // depth
        + 4 + (21 * 32)  // filled_subtrees (Vec with depth + 1 items)
        + 1;  // bump

    /// Seeds for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"merkle_tree";

    /// Zero value for empty leaves (Poseidon hash of 0)
    pub const ZERO_VALUE: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
        0x94, 0xa0, 0x38, 0x73, 0x2d, 0x5c, 0x96, 0x0c,
    ];

    /// Initialize the tree with zero values
    pub fn initialize(&mut self, pool: Pubkey, depth: u8) {
        self.pool = pool;
        self.depth = depth;
        self.leaf_count = 0;

        // Compute zero values for each level
        let mut current = Self::ZERO_VALUE;
        self.filled_subtrees = vec![current];

        for _ in 0..depth {
            current = self.hash_pair(&current, &current);
            self.filled_subtrees.push(current);
        }

        // Initial root is hash of all zeros
        self.root = current;
    }

    /// Insert a new leaf and update the root
    pub fn insert(&mut self, leaf: [u8; 32]) -> Result<u64> {
        let leaf_index = self.leaf_count;

        // Check tree is not full
        let max_leaves = 1u64 << self.depth;
        require!(
            leaf_index < max_leaves,
            crate::errors::ZkShieldedError::MerkleTreeFull
        );

        let mut current_hash = leaf;
        let mut current_index = leaf_index;

        // Update path from leaf to root
        for level in 0..self.depth as usize {
            let is_left = current_index % 2 == 0;

            let (left, right) = if is_left {
                // We're inserting on the left
                if current_index + 1 == self.leaf_count + 1 {
                    // No sibling yet, use zero value for this level
                    self.filled_subtrees[level] = current_hash;
                }
                (current_hash, self.get_zero_for_level(level))
            } else {
                // We're inserting on the right
                (self.filled_subtrees[level], current_hash)
            };

            current_hash = self.hash_pair(&left, &right);
            current_index /= 2;

            // Update filled subtree if we're on the rightmost path
            if current_index * 2 + 1 == (self.leaf_count / (1 << level)) {
                self.filled_subtrees[level + 1] = current_hash;
            }
        }

        self.root = current_hash;
        self.leaf_count += 1;

        Ok(leaf_index)
    }

    /// Get zero value for a specific tree level
    fn get_zero_for_level(&self, level: usize) -> [u8; 32] {
        if level < self.filled_subtrees.len() {
            // Use computed zero value
            let mut zero = Self::ZERO_VALUE;
            for _ in 0..level {
                zero = self.hash_pair(&zero, &zero);
            }
            zero
        } else {
            Self::ZERO_VALUE
        }
    }

    /// Poseidon hash of two 32-byte inputs
    /// This is a placeholder - actual implementation uses Poseidon
    fn hash_pair(&self, left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        use sha3::{Digest, Keccak256};

        // For now, use Keccak256 as placeholder
        // In production, this should use Poseidon hash
        let mut hasher = Keccak256::new();
        hasher.update(left);
        hasher.update(right);
        let result = hasher.finalize();

        let mut output = [0u8; 32];
        output.copy_from_slice(&result);
        output
    }
}

/// Helper for generating Merkle proofs off-chain
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct MerkleProof {
    pub leaf: [u8; 32],
    pub path_indices: Vec<u8>,   // 0 = left, 1 = right
    pub path_elements: Vec<[u8; 32]>,
}

impl MerkleProof {
    /// Verify the proof against a root
    pub fn verify(&self, root: &[u8; 32]) -> bool {
        let mut current = self.leaf;

        for (i, sibling) in self.path_elements.iter().enumerate() {
            let is_left = self.path_indices[i] == 0;

            let (left, right) = if is_left {
                (current, *sibling)
            } else {
                (*sibling, current)
            };

            // Hash pair (same as in MerkleTreeState)
            use sha3::{Digest, Keccak256};
            let mut hasher = Keccak256::new();
            hasher.update(left);
            hasher.update(right);
            let result = hasher.finalize();

            current.copy_from_slice(&result);
        }

        current == *root
    }
}
