use anchor_lang::prelude::*;

/// ML-KEM-768 public key size (FIPS 203)
pub const KEM_PUBLIC_KEY_SIZE: usize = 1184;

/// A registered relayer node in the network.
/// Operators stake SOL and receive encrypted relay jobs.
///
/// PDA seeds: [b"relayer_node", operator.key().as_ref()]
#[account]
pub struct RelayerNode {
    /// Wallet that controls this relayer
    pub operator: Pubkey,

    /// X25519 public key for classical job encryption (v1)
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

    /// Whether this relayer has an ML-KEM-768 public key for hybrid encryption
    pub has_kem_key: bool,

    /// ML-KEM-768 public key for hybrid post-quantum job encryption (v2)
    /// All zeros if has_kem_key is false.
    pub kem_encryption_key: [u8; 1184],

    /// PDA bump seed
    pub bump: u8,
}

impl RelayerNode {
    pub const SEED_PREFIX: &'static [u8] = b"relayer_node";

    pub const LEN: usize = 8      // discriminator
        + 32   // operator
        + 32   // encryption_key
        + 8    // stake
        + 8    // jobs_completed
        + 8    // jobs_failed
        + 8    // last_active_slot
        + 8    // registered_at
        + 8    // deactivated_at_slot
        + 1    // is_active
        + 4    // reputation_score
        + 32   // endpoint_hash
        + 1    // has_kem_key
        + 1184 // kem_encryption_key
        + 1;   // bump

    /// Maximum reputation score
    pub const MAX_REPUTATION: u32 = 10_000;

    /// Default starting reputation for new relayers
    pub const INITIAL_REPUTATION: u32 = 5_000;

    /// Slots per decay period. At ~400 ms/slot, 15_000 slots ≈ 100 min.
    pub const DECAY_PERIOD_SLOTS: u64 = 15_000;

    /// Reputation lost per elapsed period of inactivity (lazy linear decay).
    /// 100 periods × 100 = 10_000 → MAX_REPUTATION drops to 0 in ~7 days
    /// of dormancy. Heartbeats / completions reset `last_active_slot`.
    pub const DECAY_RATE_PER_PERIOD: u32 = 100;

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

    /// Apply lazy linear reputation decay based on elapsed slots since
    /// `last_active_slot`. Idempotent within a single period — call freely.
    /// Advances `last_active_slot` by full consumed periods so any
    /// fractional remainder is preserved across calls.
    ///
    /// Sybil-defence: registers + builds rep on a few jobs + sits dormant
    /// → score collapses, locks them out via the MIN_REPUTATION gate.
    pub fn apply_decay(&mut self, current_slot: u64) {
        let elapsed = current_slot.saturating_sub(self.last_active_slot);
        let periods = elapsed / Self::DECAY_PERIOD_SLOTS;
        if periods == 0 {
            return;
        }
        let periods_u32 = periods.min(u32::MAX as u64) as u32;
        let loss = periods_u32.saturating_mul(Self::DECAY_RATE_PER_PERIOD);
        self.reputation_score = self.reputation_score.saturating_sub(loss);
        self.last_active_slot = self
            .last_active_slot
            .saturating_add(periods.saturating_mul(Self::DECAY_PERIOD_SLOTS));
    }

    /// Check whether the cooldown period has elapsed since deactivation.
    pub fn can_unstake(&self, current_slot: u64, cooldown_slots: u64) -> bool {
        self.deactivated_at_slot > 0
            && current_slot >= self.deactivated_at_slot.saturating_add(cooldown_slots)
    }
}

#[cfg(test)]
mod decay_tests {
    use super::*;

    fn fresh(slot: u64) -> RelayerNode {
        RelayerNode {
            operator: Pubkey::default(),
            encryption_key: [0u8; 32],
            stake: 0,
            jobs_completed: 0,
            jobs_failed: 0,
            last_active_slot: slot,
            registered_at: 0,
            deactivated_at_slot: 0,
            is_active: true,
            reputation_score: RelayerNode::INITIAL_REPUTATION,
            endpoint_hash: [0u8; 32],
            has_kem_key: false,
            kem_encryption_key: [0u8; 1184],
            bump: 0,
        }
    }

    #[test]
    fn no_decay_within_first_period() {
        let mut n = fresh(1_000);
        n.apply_decay(1_000 + RelayerNode::DECAY_PERIOD_SLOTS - 1);
        assert_eq!(n.reputation_score, RelayerNode::INITIAL_REPUTATION);
        assert_eq!(n.last_active_slot, 1_000);
    }

    #[test]
    fn decay_one_period_subtracts_rate() {
        let mut n = fresh(1_000);
        n.apply_decay(1_000 + RelayerNode::DECAY_PERIOD_SLOTS);
        assert_eq!(
            n.reputation_score,
            RelayerNode::INITIAL_REPUTATION - RelayerNode::DECAY_RATE_PER_PERIOD
        );
        assert_eq!(n.last_active_slot, 1_000 + RelayerNode::DECAY_PERIOD_SLOTS);
    }

    #[test]
    fn decay_preserves_partial_period_remainder() {
        let mut n = fresh(0);
        // 1.5 periods elapsed — only 1 period consumed, baseline advances by 1 period.
        let half = RelayerNode::DECAY_PERIOD_SLOTS / 2;
        n.apply_decay(RelayerNode::DECAY_PERIOD_SLOTS + half);
        assert_eq!(
            n.reputation_score,
            RelayerNode::INITIAL_REPUTATION - RelayerNode::DECAY_RATE_PER_PERIOD
        );
        assert_eq!(n.last_active_slot, RelayerNode::DECAY_PERIOD_SLOTS);

        // Additional half-period later: still no extra decay (remainder = 1 full period now).
        n.apply_decay(RelayerNode::DECAY_PERIOD_SLOTS + half + 1);
        assert_eq!(
            n.reputation_score,
            RelayerNode::INITIAL_REPUTATION - RelayerNode::DECAY_RATE_PER_PERIOD
        );
    }

    #[test]
    fn dormancy_burns_score_to_zero_then_saturates() {
        let mut n = fresh(0);
        // 200 periods → would subtract 20_000, but score saturates at 0.
        n.apply_decay(200 * RelayerNode::DECAY_PERIOD_SLOTS);
        assert_eq!(n.reputation_score, 0);
        assert_eq!(n.last_active_slot, 200 * RelayerNode::DECAY_PERIOD_SLOTS);
    }

    #[test]
    fn extreme_slot_does_not_panic() {
        let mut n = fresh(0);
        n.apply_decay(u64::MAX);
        assert_eq!(n.reputation_score, 0);
    }

    #[test]
    fn current_slot_before_baseline_is_noop() {
        // Defensive: if last_active_slot somehow exceeds current_slot
        // (clock skew, on-chain edge), saturating_sub yields 0 → no decay.
        let mut n = fresh(1_000_000);
        n.apply_decay(500_000);
        assert_eq!(n.reputation_score, RelayerNode::INITIAL_REPUTATION);
        assert_eq!(n.last_active_slot, 1_000_000);
    }

    #[test]
    fn idempotent_within_period() {
        let mut n = fresh(0);
        let slot = RelayerNode::DECAY_PERIOD_SLOTS / 4;
        n.apply_decay(slot);
        n.apply_decay(slot);
        n.apply_decay(slot);
        assert_eq!(n.reputation_score, RelayerNode::INITIAL_REPUTATION);
    }

    #[test]
    fn full_window_burns_max_to_zero() {
        // 100 periods × 100 rate = 10_000 → MAX_REPUTATION → 0.
        let mut n = fresh(0);
        n.reputation_score = RelayerNode::MAX_REPUTATION;
        n.apply_decay(100 * RelayerNode::DECAY_PERIOD_SLOTS);
        assert_eq!(n.reputation_score, 0);
    }

    #[test]
    fn after_decay_increase_reputation_works_normally() {
        // Mirrors complete_job ordering: apply_decay → +100.
        let mut n = fresh(0);
        n.apply_decay(2 * RelayerNode::DECAY_PERIOD_SLOTS); // -200
        assert_eq!(n.reputation_score, RelayerNode::INITIAL_REPUTATION - 200);
        n.increase_reputation(100);
        assert_eq!(n.reputation_score, RelayerNode::INITIAL_REPUTATION - 100);
    }
}
