use anchor_lang::prelude::*;

/// A registered relayer node in the network.
/// Operators stake SOL and receive encrypted relay jobs.
///
/// PDA seeds: [b"relayer_node", operator.key().as_ref()]
#[account]
pub struct RelayerNode {
    /// Wallet that controls this relayer
    pub operator: Pubkey,

    /// X25519 public key for job encryption
    pub encryption_key: [u8; 32],

    /// SOL lamports staked (held by this PDA)
    pub stake: u64,

    /// Number of successfully completed jobs
    pub jobs_completed: u64,

    /// Number of failed or expired jobs
    pub jobs_failed: u64,

    /// Last slot at which a job was completed
    pub last_active_slot: u64,

    /// Unix timestamp when this relayer was registered
    pub registered_at: i64,

    /// Slot when deactivated (0 if currently active)
    pub deactivated_at_slot: u64,

    /// Whether this relayer is currently accepting jobs
    pub is_active: bool,

    /// Reputation score on a 0-10000 scale
    pub reputation_score: u32,

    /// SHA-256 hash of the relayer's public endpoint URL
    pub endpoint_hash: [u8; 32],

    /// PDA bump seed
    pub bump: u8,
}

impl RelayerNode {
    pub const SEED_PREFIX: &'static [u8] = b"relayer_node";

    pub const LEN: usize = 8   // discriminator
        + 32  // operator
        + 32  // encryption_key
        + 8   // stake
        + 8   // jobs_completed
        + 8   // jobs_failed
        + 8   // last_active_slot
        + 8   // registered_at
        + 8   // deactivated_at_slot
        + 1   // is_active
        + 4   // reputation_score
        + 32  // endpoint_hash
        + 1;  // bump

    /// Maximum reputation score
    pub const MAX_REPUTATION: u32 = 10_000;

    /// Default starting reputation for new relayers
    pub const INITIAL_REPUTATION: u32 = 5_000;

    /// Decrease reputation by the given amount, clamping at zero.
    pub fn decrease_reputation(&mut self, amount: u32) {
        self.reputation_score = self.reputation_score.saturating_sub(amount);
    }

    /// Increase reputation by the given amount, clamping at MAX_REPUTATION.
    pub fn increase_reputation(&mut self, amount: u32) {
        self.reputation_score = self
            .reputation_score
            .saturating_add(amount)
            .min(Self::MAX_REPUTATION);
    }

    /// Check whether the cooldown period has elapsed since deactivation.
    pub fn can_unstake(&self, current_slot: u64, cooldown_slots: u64) -> bool {
        self.deactivated_at_slot > 0
            && current_slot >= self.deactivated_at_slot.saturating_add(cooldown_slots)
    }
}
