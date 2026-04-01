use anchor_lang::prelude::*;

/// Configuration and state of a shielded pool
/// Each pool handles one token type (SOL or SPL token)
#[account]
#[derive(Default)]
pub struct ShieldedPool {
    /// Authority that can update pool settings
    pub authority: Pubkey,

    /// Token mint address (system program for SOL)
    pub token_mint: Pubkey,

    /// Current Merkle tree root
    pub merkle_root: [u8; 32],

    /// Depth of the Merkle tree (20 = ~1M notes)
    pub tree_depth: u8,

    /// Index of the next leaf to insert
    pub next_leaf_index: u64,

    /// Hash of the verification key for proof validation
    pub vk_hash: [u8; 32],

    /// Total amount currently shielded in the pool
    pub total_shielded: u64,

    /// Whether the pool is accepting new deposits/transfers
    pub is_active: bool,

    /// Historical roots (last 100 roots for flexibility)
    pub historical_roots: Vec<[u8; 32]>,

    /// Maximum size of historical roots array
    pub max_historical_roots: u8,

    /// Pool creation timestamp
    pub created_at: i64,

    /// Last transaction timestamp
    pub last_tx_at: i64,

    /// Relayer fee in basis points (100 = 1%)
    pub relayer_fee_bps: u16,

    /// Relayer pubkey that receives fees
    pub relayer: Pubkey,

    /// Bump seed for PDA
    pub bump: u8,

    /// Timestamp of the last VK update (for 24h cooldown enforcement)
    pub vk_update_slot: i64,

    /// Pending new authority for two-step authority transfer
    pub pending_authority: Option<Pubkey>,
}

impl ShieldedPool {
    /// Account size calculation
    /// Fixed fields + Vec overhead + historical roots (100 * 32 bytes)
    pub const LEN: usize = 8 // discriminator
        + 32  // authority
        + 32  // token_mint
        + 32  // merkle_root
        + 1   // tree_depth
        + 8   // next_leaf_index
        + 32  // vk_hash
        + 8   // total_shielded
        + 1   // is_active
        + 4 + (100 * 32)  // historical_roots (Vec with max 100 items)
        + 1   // max_historical_roots
        + 8   // created_at
        + 8   // last_tx_at
        + 2   // relayer_fee_bps
        + 32  // relayer
        + 1   // bump
        + 8   // vk_update_slot
        + 1 + 32; // pending_authority (Option<Pubkey>)

    /// Seeds for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"shielded_pool";

    /// Default tree depth (2^20 = ~1M notes)
    pub const DEFAULT_TREE_DEPTH: u8 = 20;

    /// Maximum historical roots to store
    pub const MAX_HISTORICAL_ROOTS: u8 = 100;

    /// Maximum relayer fee (1% = 100 bps)
    pub const MAX_RELAYER_FEE_BPS: u16 = 100;

    /// VK update cooldown period in seconds (24 hours)
    pub const VK_UPDATE_COOLDOWN: i64 = 86400;

    /// Check if a root is valid (current or historical)
    pub fn is_valid_root(&self, root: &[u8; 32]) -> bool {
        if self.merkle_root == *root {
            return true;
        }
        self.historical_roots.contains(root)
    }

    /// Update the Merkle root and store old root in history.
    /// Uses a circular buffer pattern: once the vec reaches max size,
    /// we overwrite the oldest entry in-place instead of shifting with remove(0).
    pub fn update_root(&mut self, new_root: [u8; 32]) {
        let max = self.max_historical_roots as usize;
        if self.historical_roots.len() < max {
            // Still filling the buffer
            self.historical_roots.push(self.merkle_root);
        } else if max > 0 {
            // Circular overwrite: find the oldest slot and replace
            // We track the write position using next_leaf_index as a monotonic counter
            let idx = (self.next_leaf_index as usize) % max;
            self.historical_roots[idx] = self.merkle_root;
        }

        // Update to new root
        self.merkle_root = new_root;
    }
}

/// Pool statistics (read-only view)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PoolStats {
    pub total_shielded: u64,
    pub total_notes: u64,
    pub is_active: bool,
    pub tree_depth: u8,
}

impl From<&ShieldedPool> for PoolStats {
    fn from(pool: &ShieldedPool) -> Self {
        Self {
            total_shielded: pool.total_shielded,
            total_notes: pool.next_leaf_index,
            is_active: pool.is_active,
            tree_depth: pool.tree_depth,
        }
    }
}

// ---------------------------------------------------------------------------
// Denominated Pool — Fixed-denomination Tornado Cash-style pool
// ---------------------------------------------------------------------------

/// Slots per epoch (~1 hour on Solana at 400ms/slot)
pub const SLOTS_PER_EPOCH: u64 = 7200;

/// A shielded pool where every note has a fixed denomination.
/// Commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
/// No amount in the commitment — denomination enforced at program level.
///
/// Dynamic time delay: The pool adjusts the withdrawal delay based on the
/// anonymity set size (mature notes). More notes = shorter delay because the
/// anonymity set is large enough to resist timing analysis.
///
/// Lazy maturity tracking: A circular buffer `epoch_note_counts` records how
/// many notes were deposited in each epoch. On every shield/unshield, the
/// `update_maturity()` method walks the buffer to graduate old epochs into
/// `mature_note_count`. This avoids scanning all notes — O(buffer_size) worst
/// case, which is bounded at 32.
#[account]
#[derive(Default)]
pub struct DenominatedPool {
    /// Authority that can update pool settings
    pub authority: Pubkey,

    /// Token mint address (system program for SOL)
    pub token_mint: Pubkey,

    /// Fixed denomination per note (in lamports / atomic units)
    pub denomination: u64,

    /// Minimum epochs that must pass between deposit and withdrawal
    pub epoch_delay: u64,

    /// Current Merkle tree root
    pub merkle_root: [u8; 32],

    /// Depth of the Merkle tree (20 = ~1M notes)
    pub tree_depth: u8,

    /// Index of the next leaf to insert
    pub next_leaf_index: u64,

    /// Hash of the verification key for proof validation
    pub vk_hash: [u8; 32],

    /// Total amount currently shielded (= note_count * denomination)
    pub total_shielded: u64,

    /// Number of notes in pool (anonymity set size)
    pub note_count: u64,

    /// Whether the pool is accepting new deposits
    pub is_active: bool,

    /// Historical roots (last 100 roots for flexibility)
    pub historical_roots: Vec<[u8; 32]>,

    /// Maximum size of historical roots array
    pub max_historical_roots: u8,

    /// Pool creation timestamp
    pub created_at: i64,

    /// Last transaction timestamp
    pub last_tx_at: i64,

    /// Bump seed for PDA
    pub bump: u8,

    // -- Dynamic delay fields (lazy maturity tracking) --

    /// Number of notes that have been in the pool longer than `epoch_delay` epochs.
    /// Drives `get_dynamic_delay()`: more mature notes = shorter withdrawal delay.
    pub mature_note_count: u64,

    /// The last epoch at which `update_maturity()` was called.
    /// Used to determine how many new epochs to graduate.
    pub last_maturity_update_epoch: u64,

    /// Circular buffer: number of notes deposited in each epoch.
    /// Index `i` corresponds to epoch `epoch_note_start + i`.
    /// Size 32 provides a lookback window of 32 epochs (~32 hours).
    pub epoch_note_counts: [u64; 32],

    /// The absolute epoch number corresponding to index 0 of `epoch_note_counts`.
    /// When time advances, old entries are graduated (added to mature_note_count)
    /// and the start is shifted forward.
    pub epoch_note_start: u64,

    /// Hash of the verification key for transfer circuit validation.
    /// Separate from vk_hash because unshield and transfer are different circuits
    /// with different public inputs.
    pub vk_hash_transfer: [u8; 32],

    /// Timestamp of the last VK update (for 24h cooldown enforcement)
    pub vk_update_slot: i64,

    /// Write index for the historical_roots circular buffer.
    /// Decoupled from next_leaf_index so root history is not corrupted
    /// when next_leaf_index diverges (e.g., transfer_denominated).
    pub root_write_index: u64,

    /// Hash of the verification key for escrow bid circuit validation.
    /// Separate from vk_hash and vk_hash_transfer because escrow_bid
    /// has 7 public inputs (adds auction_id, pay_commitment, refund_commitment).
    pub vk_hash_escrow: [u8; 32],
}

impl DenominatedPool {
    /// Size of the epoch_note_counts circular buffer
    pub const EPOCH_BUFFER_SIZE: usize = 32;

    /// Account size calculation
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // token_mint
        + 8   // denomination
        + 8   // epoch_delay
        + 32  // merkle_root
        + 1   // tree_depth
        + 8   // next_leaf_index
        + 32  // vk_hash
        + 8   // total_shielded
        + 8   // note_count
        + 1   // is_active
        + 4 + (100 * 32)  // historical_roots (Vec with max 100 items)
        + 1   // max_historical_roots
        + 8   // created_at
        + 8   // last_tx_at
        + 1   // bump
        + 8   // mature_note_count
        + 8   // last_maturity_update_epoch
        + (8 * 32) // epoch_note_counts ([u64; 32])
        + 8   // epoch_note_start
        + 32  // vk_hash_transfer
        + 8   // vk_update_slot
        + 8   // root_write_index
        + 32; // vk_hash_escrow

    /// Seeds for PDA derivation: [b"denominated_pool", token_mint, denomination]
    pub const SEED_PREFIX: &'static [u8] = b"denominated_pool";

    /// Default tree depth (2^15 = 32,768 notes per pool)
    /// 32K notes per denomination is sufficient for launch.
    /// Depth 15 = 4,273 constraints (22% less than depth 20).
    pub const DEFAULT_TREE_DEPTH: u8 = 15;

    /// Maximum historical roots to store
    pub const MAX_HISTORICAL_ROOTS: u8 = 100;

    /// VK update cooldown period in seconds (24 hours)
    pub const VK_UPDATE_COOLDOWN: i64 = 86400;

    /// Check if a root is valid (current or historical)
    pub fn is_valid_root(&self, root: &[u8; 32]) -> bool {
        if self.merkle_root == *root {
            return true;
        }
        self.historical_roots.contains(root)
    }

    /// Update the Merkle root and store old root in history.
    /// Uses a circular buffer pattern: once the vec reaches max size,
    /// we overwrite the oldest entry in-place instead of shifting with remove(0).
    /// Uses `root_write_index` (not `next_leaf_index`) for the circular buffer
    /// position to avoid corruption when leaf index diverges from root updates.
    pub fn update_root(&mut self, new_root: [u8; 32]) {
        let max = self.max_historical_roots as usize;
        if self.historical_roots.len() < max {
            self.historical_roots.push(self.merkle_root);
        } else if max > 0 {
            let idx = (self.root_write_index as usize) % max;
            self.historical_roots[idx] = self.merkle_root;
        }
        self.root_write_index += 1;
        self.merkle_root = new_root;
    }

    /// Compute the current epoch from a slot number
    pub fn current_epoch(slot: u64) -> u64 {
        slot / SLOTS_PER_EPOCH
    }

    /// Lazy maturity update: graduates epoch entries older than `epoch_delay`
    /// into `mature_note_count`.
    ///
    /// Algorithm:
    /// 1. The "maturity frontier" is `current_epoch - epoch_delay`.
    ///    Any epoch <= this frontier is mature.
    /// 2. Walk from `last_maturity_update_epoch - epoch_delay` forward to the
    ///    new frontier, summing up note counts from the buffer.
    /// 3. Zero out graduated buffer entries and advance `epoch_note_start`.
    ///
    /// Edge case: if nobody interacts for 100 epochs, all buffer entries are
    /// mature. The loop is bounded by EPOCH_BUFFER_SIZE (32 iterations max)
    /// regardless of how much time passed — any entries beyond the buffer are
    /// already zeroed and were graduated in a prior call (or never recorded).
    pub fn update_maturity(&mut self, current_epoch: u64) {
        // Nothing to do if time hasn't advanced
        if current_epoch <= self.last_maturity_update_epoch {
            self.last_maturity_update_epoch = current_epoch;
            return;
        }

        // The maturity frontier: epochs at or before this are mature
        // If current_epoch < epoch_delay, no epochs can be mature yet
        let maturity_frontier = match current_epoch.checked_sub(self.epoch_delay) {
            Some(f) => f,
            None => {
                self.last_maturity_update_epoch = current_epoch;
                return;
            }
        };

        // Previous frontier: epochs that were already graduated last time
        let prev_frontier = self
            .last_maturity_update_epoch
            .checked_sub(self.epoch_delay)
            .unwrap_or(0);

        // Graduate epochs from (prev_frontier, maturity_frontier] that are in the buffer
        // But we must clamp to the buffer range [epoch_note_start, epoch_note_start + 32)
        let buf_end = self.epoch_note_start + Self::EPOCH_BUFFER_SIZE as u64;

        // Start scanning from the epoch after the previous frontier
        let scan_start = if prev_frontier >= self.epoch_note_start {
            prev_frontier + 1
        } else {
            self.epoch_note_start
        };

        let scan_end = maturity_frontier
            .min(buf_end.saturating_sub(1)) // clamp to buffer range
            + 1; // exclusive end

        if scan_start < scan_end {
            for epoch in scan_start..scan_end {
                let idx = ((epoch - self.epoch_note_start) as usize) % Self::EPOCH_BUFFER_SIZE;
                self.mature_note_count = self
                    .mature_note_count
                    .saturating_add(self.epoch_note_counts[idx]);
                self.epoch_note_counts[idx] = 0;
            }
        }

        // Advance epoch_note_start to discard fully graduated entries.
        // The new start is maturity_frontier + 1 (first non-mature epoch),
        // but we must ensure we don't skip un-graduated entries.
        let new_start = maturity_frontier.saturating_add(1);
        if new_start > self.epoch_note_start {
            // Zero out any remaining entries between old start and new start
            // that might not have been covered by the scan above
            let zero_end = new_start.min(self.epoch_note_start + Self::EPOCH_BUFFER_SIZE as u64);
            for epoch in self.epoch_note_start..zero_end {
                let idx = ((epoch - self.epoch_note_start) as usize) % Self::EPOCH_BUFFER_SIZE;
                // Already zeroed in the scan above for graduated entries,
                // but ensure stale entries are cleared
                self.epoch_note_counts[idx] = 0;
            }
            self.epoch_note_start = new_start;
        }

        self.last_maturity_update_epoch = current_epoch;
    }

    /// Returns the dynamic withdrawal delay (in additional epochs beyond
    /// the circuit's `min_epoch`) based on the anonymity set size.
    ///
    /// Thresholds:
    /// - >= 1000 mature notes: 0 (instant — large anonymity set)
    /// - 100..999 mature notes: 1 epoch (~1 hour)
    /// - 10..99 mature notes: 1 epoch (~1 hour)
    /// - < 10 mature notes: 2 epochs (~2 hours)
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

    /// Record a deposit in the epoch circular buffer.
    /// Must be called AFTER `update_maturity()` so `epoch_note_start` is current.
    pub fn record_deposit(&mut self, current_epoch: u64) {
        // If current_epoch is before our buffer start, it's stale — shouldn't happen
        // after update_maturity, but guard anyway.
        if current_epoch < self.epoch_note_start {
            return;
        }

        let offset = current_epoch - self.epoch_note_start;

        // If the epoch is beyond the buffer, we need to shift the buffer forward.
        // Any entries that fall off the front are implicitly lost (they should
        // have been graduated by update_maturity already).
        if offset >= Self::EPOCH_BUFFER_SIZE as u64 {
            // Shift: zero out entire buffer and reset start to current_epoch
            self.epoch_note_counts = [0u64; 32];
            self.epoch_note_start = current_epoch;
            self.epoch_note_counts[0] = 1;
        } else {
            let idx = offset as usize;
            self.epoch_note_counts[idx] = self.epoch_note_counts[idx].saturating_add(1);
        }
    }
}
