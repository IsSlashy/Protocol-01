use anchor_lang::prelude::*;

/// Nullifier set for preventing double-spending
/// Uses a Bloom filter for fast probabilistic checking
/// plus an on-chain list for definitive verification
///
/// Uses zero-copy to avoid stack overflow during deserialization
#[account(zero_copy)]
#[repr(C)]
pub struct NullifierSet {
    /// Associated shielded pool
    pub pool: Pubkey,

    /// Number of nullifiers stored
    pub count: u64,

    /// Number of hash functions for bloom filter
    pub num_hash_functions: u8,

    /// Bump seed for PDA
    pub bump: u8,

    /// Padding for alignment
    pub _padding: [u8; 6],

    /// Bloom filter for fast probabilistic checking (2KB)
    /// False positives possible, false negatives impossible
    pub bloom_filter: [u64; 256],
}

impl NullifierSet {
    /// Seeds for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"nullifier_set";

    /// Bloom filter size in bits
    pub const BLOOM_SIZE_BITS: usize = 256 * 64; // 16,384 bits

    /// Check if a nullifier might be in the set (Bloom filter check)
    /// Returns true if POSSIBLY in set, false if DEFINITELY not in set
    pub fn might_contain(&self, nullifier: &[u8; 32]) -> bool {
        for i in 0..self.num_hash_functions as usize {
            let bit_index = self.get_bit_index(nullifier, i);
            let word_index = bit_index / 64;
            let bit_offset = bit_index % 64;

            if (self.bloom_filter[word_index] & (1u64 << bit_offset)) == 0 {
                return false;
            }
        }
        true
    }

    /// Add a nullifier to the Bloom filter
    pub fn add(&mut self, nullifier: &[u8; 32]) {
        for i in 0..self.num_hash_functions as usize {
            let bit_index = self.get_bit_index(nullifier, i);
            let word_index = bit_index / 64;
            let bit_offset = bit_index % 64;

            self.bloom_filter[word_index] |= 1u64 << bit_offset;
        }
        self.count += 1;
    }

    /// Get bit index for a specific hash function
    fn get_bit_index(&self, nullifier: &[u8; 32], hash_index: usize) -> usize {
        use sha3::{Digest, Keccak256};

        // Double hashing technique: h(i) = h1 + i*h2
        let mut hasher1 = Keccak256::new();
        hasher1.update(nullifier);
        let h1 = hasher1.finalize();

        let mut hasher2 = Keccak256::new();
        hasher2.update(nullifier);
        hasher2.update([0x01]);
        let h2 = hasher2.finalize();

        // Extract u64 from hashes
        let h1_val = u64::from_le_bytes(h1[0..8].try_into().unwrap());
        let h2_val = u64::from_le_bytes(h2[0..8].try_into().unwrap());

        // Compute combined hash
        let combined = h1_val.wrapping_add((hash_index as u64).wrapping_mul(h2_val));

        (combined as usize) % Self::BLOOM_SIZE_BITS
    }
}

/// Separate account for storing actual nullifiers (for definitive verification)
/// This is created per-batch to avoid account size limits
#[account]
pub struct NullifierBatch {
    /// Associated nullifier set
    pub nullifier_set: Pubkey,

    /// Batch index
    pub batch_index: u64,

    /// Nullifiers in this batch (max ~300 per account due to size limits)
    pub nullifiers: Vec<[u8; 32]>,

    /// Bump seed for PDA
    pub bump: u8,
}

impl NullifierBatch {
    /// Maximum nullifiers per batch
    pub const MAX_NULLIFIERS_PER_BATCH: usize = 300;

    /// Account size calculation
    pub const LEN: usize = 8   // discriminator
        + 32   // nullifier_set
        + 8    // batch_index
        + 4 + (Self::MAX_NULLIFIERS_PER_BATCH * 32)  // nullifiers vec
        + 1;   // bump

    /// Seeds for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"nullifier_batch";

    /// Check if a nullifier exists in this batch
    pub fn contains(&self, nullifier: &[u8; 32]) -> bool {
        self.nullifiers.contains(nullifier)
    }

    /// Add a nullifier to this batch
    pub fn add(&mut self, nullifier: [u8; 32]) -> Result<()> {
        require!(
            self.nullifiers.len() < Self::MAX_NULLIFIERS_PER_BATCH,
            crate::errors::ZkShieldedError::MerkleTreeFull
        );
        self.nullifiers.push(nullifier);
        Ok(())
    }
}
