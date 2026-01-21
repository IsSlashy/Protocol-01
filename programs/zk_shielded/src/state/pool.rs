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
        + 1;  // bump

    /// Seeds for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"shielded_pool";

    /// Default tree depth (2^20 = ~1M notes)
    pub const DEFAULT_TREE_DEPTH: u8 = 20;

    /// Maximum historical roots to store
    pub const MAX_HISTORICAL_ROOTS: u8 = 100;

    /// Maximum relayer fee (1% = 100 bps)
    pub const MAX_RELAYER_FEE_BPS: u16 = 100;

    /// Check if a root is valid (current or historical)
    pub fn is_valid_root(&self, root: &[u8; 32]) -> bool {
        if self.merkle_root == *root {
            return true;
        }
        self.historical_roots.contains(root)
    }

    /// Update the Merkle root and store old root in history
    pub fn update_root(&mut self, new_root: [u8; 32]) {
        // Store current root in history
        if self.historical_roots.len() >= self.max_historical_roots as usize {
            self.historical_roots.remove(0);
        }
        self.historical_roots.push(self.merkle_root);

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
