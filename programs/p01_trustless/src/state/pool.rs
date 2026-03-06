use anchor_lang::prelude::*;

/// Slots per epoch (~1 hour on Solana at 400ms/slot)
pub const SLOTS_PER_EPOCH: u64 = 7200;

/// Trustless shielded pool state.
/// Tracks the Merkle tree root, leaf count, and pool configuration.
/// No admin keys required for operations -- only for initialization.
#[account]
#[derive(Default)]
pub struct PoolState {
    /// Authority that initialized the pool (can update VK hash only)
    pub authority: Pubkey,

    /// Current Merkle tree root
    pub merkle_root: [u8; 32],

    /// Number of leaves (commitments) inserted
    pub leaf_count: u64,

    /// SPL token mint (System Program ID = native SOL)
    pub token_mint: Pubkey,

    /// Vault PDA address (for SPL tokens)
    pub vault: Pubkey,

    /// Fixed denomination per note (in lamports / atomic units)
    pub denomination: u64,

    /// Hash of the unshield circuit verification key
    pub verification_key_hash: [u8; 32],

    /// Hash of the zkSPL circuit verification key
    pub zkspl_vk_hash: [u8; 32],

    /// Total amount currently shielded in the pool
    pub total_shielded: u64,

    /// Number of active notes in the pool
    pub note_count: u64,

    /// Whether the pool is accepting operations
    pub is_active: bool,

    /// Historical roots (last 100 roots for flexibility)
    pub historical_roots: Vec<[u8; 32]>,

    /// Maximum size of historical roots array
    pub max_historical_roots: u8,

    /// Depth of the Merkle tree
    pub tree_depth: u8,

    /// Pool creation timestamp
    pub created_at: i64,

    /// Last transaction timestamp
    pub last_tx_at: i64,

    /// Bump seed for PDA
    pub bump: u8,

    /// Base epoch delay for withdrawals
    pub epoch_delay: u64,

    /// Number of notes that have matured (past epoch_delay)
    pub mature_note_count: u64,

    /// Last epoch at which maturity was updated
    pub last_maturity_update_epoch: u64,

    /// Circular buffer: deposits per epoch
    pub epoch_note_counts: [u64; 32],

    /// Epoch corresponding to index 0 of the buffer
    pub epoch_note_start: u64,
}

impl PoolState {
    /// Epoch buffer size
    pub const EPOCH_BUFFER_SIZE: usize = 32;

    pub const LEN: usize = 8   // discriminator
        + 32  // authority
        + 32  // merkle_root
        + 8   // leaf_count
        + 32  // token_mint
        + 32  // vault
        + 8   // denomination
        + 32  // verification_key_hash
        + 32  // zkspl_vk_hash
        + 8   // total_shielded
        + 8   // note_count
        + 1   // is_active
        + 4 + (100 * 32)  // historical_roots Vec
        + 1   // max_historical_roots
        + 1   // tree_depth
        + 8   // created_at
        + 8   // last_tx_at
        + 1   // bump
        + 8   // epoch_delay
        + 8   // mature_note_count
        + 8   // last_maturity_update_epoch
        + (8 * 32) // epoch_note_counts
        + 8;  // epoch_note_start

    pub const SEED_PREFIX: &'static [u8] = b"trustless_pool";

    /// Default tree depth (2^15 = 32,768 notes per pool)
    pub const DEFAULT_TREE_DEPTH: u8 = 15;

    /// Maximum historical roots to store
    pub const MAX_HISTORICAL_ROOTS: u8 = 100;

    /// Default epoch delay (2 epochs ~= 2 hours)
    pub const DEFAULT_EPOCH_DELAY: u64 = 2;

    /// Check if a root is valid (current or in history)
    pub fn is_valid_root(&self, root: &[u8; 32]) -> bool {
        if self.merkle_root == *root {
            return true;
        }
        self.historical_roots.contains(root)
    }

    /// Update the Merkle root and push old root into history
    pub fn update_root(&mut self, new_root: [u8; 32]) {
        if self.historical_roots.len() >= self.max_historical_roots as usize {
            self.historical_roots.remove(0);
        }
        self.historical_roots.push(self.merkle_root);
        self.merkle_root = new_root;
    }

    /// Compute the current epoch from a slot number
    pub fn current_epoch(slot: u64) -> u64 {
        slot / SLOTS_PER_EPOCH
    }

    /// Lazy maturity update: graduate old epoch entries into mature_note_count
    pub fn update_maturity(&mut self, current_epoch: u64) {
        if current_epoch <= self.last_maturity_update_epoch {
            self.last_maturity_update_epoch = current_epoch;
            return;
        }

        let maturity_frontier = match current_epoch.checked_sub(self.epoch_delay) {
            Some(f) => f,
            None => {
                self.last_maturity_update_epoch = current_epoch;
                return;
            }
        };

        let prev_frontier = self
            .last_maturity_update_epoch
            .checked_sub(self.epoch_delay)
            .unwrap_or(0);

        let buf_end = self.epoch_note_start + Self::EPOCH_BUFFER_SIZE as u64;

        let scan_start = if prev_frontier >= self.epoch_note_start {
            prev_frontier + 1
        } else {
            self.epoch_note_start
        };

        let scan_end = maturity_frontier
            .min(buf_end.saturating_sub(1))
            + 1;

        if scan_start < scan_end {
            for epoch in scan_start..scan_end {
                let idx = ((epoch - self.epoch_note_start) as usize) % Self::EPOCH_BUFFER_SIZE;
                self.mature_note_count = self
                    .mature_note_count
                    .saturating_add(self.epoch_note_counts[idx]);
                self.epoch_note_counts[idx] = 0;
            }
        }

        let new_start = maturity_frontier.saturating_add(1);
        if new_start > self.epoch_note_start {
            let zero_end = new_start.min(self.epoch_note_start + Self::EPOCH_BUFFER_SIZE as u64);
            for epoch in self.epoch_note_start..zero_end {
                let idx = ((epoch - self.epoch_note_start) as usize) % Self::EPOCH_BUFFER_SIZE;
                self.epoch_note_counts[idx] = 0;
            }
            self.epoch_note_start = new_start;
        }

        self.last_maturity_update_epoch = current_epoch;
    }

    /// Dynamic withdrawal delay based on anonymity set size
    pub fn get_dynamic_delay(&self) -> u64 {
        if self.mature_note_count >= 1000 {
            0
        } else if self.mature_note_count >= 100 {
            1
        } else if self.mature_note_count >= 10 {
            1
        } else {
            2
        }
    }

    /// Record a deposit in the epoch circular buffer
    pub fn record_deposit(&mut self, current_epoch: u64) {
        if current_epoch < self.epoch_note_start {
            return;
        }

        let offset = current_epoch - self.epoch_note_start;
        if offset >= Self::EPOCH_BUFFER_SIZE as u64 {
            self.epoch_note_counts = [0u64; 32];
            self.epoch_note_start = current_epoch;
            self.epoch_note_counts[0] = 1;
        } else {
            let idx = offset as usize;
            self.epoch_note_counts[idx] = self.epoch_note_counts[idx].saturating_add(1);
        }
    }
}
