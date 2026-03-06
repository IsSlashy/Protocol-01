use anchor_lang::prelude::*;

/// Global configuration for the relayer network.
/// Controls registration parameters, fees, slashing, and emergency shutdown.
///
/// PDA seeds: [b"relayer_config"]
#[account]
pub struct RelayerConfig {
    /// Admin who can update config
    pub authority: Pubkey,

    /// Minimum SOL lamports to register as a relayer (e.g., 5 SOL = 5_000_000_000)
    pub min_stake: u64,

    /// Maximum number of active relayers in the network
    pub max_relayers: u16,

    /// Base relay fee paid per job (in lamports)
    pub job_fee_lamports: u64,

    /// Protocol cut from fees in basis points (e.g., 500 = 5%)
    pub protocol_fee_bps: u16,

    /// Wallet where protocol fees are sent
    pub protocol_fee_wallet: Pubkey,

    /// Slots before a job expires (e.g., 300 = ~2 min at 400ms/slot)
    pub job_timeout_slots: u64,

    /// Lamports slashed for misbehavior
    pub slash_amount: u64,

    /// Slots to wait after deactivation before unstaking
    pub cooldown_slots: u64,

    /// Current count of active relayers
    pub active_relayer_count: u16,

    /// Global stats: total jobs completed across all relayers
    pub total_jobs_completed: u64,

    /// Emergency kill switch
    pub is_active: bool,

    /// PDA bump seed
    pub bump: u8,
}

impl RelayerConfig {
    pub const SEED_PREFIX: &'static [u8] = b"relayer_config";

    pub const LEN: usize = 8   // discriminator
        + 32  // authority
        + 8   // min_stake
        + 2   // max_relayers
        + 8   // job_fee_lamports
        + 2   // protocol_fee_bps
        + 32  // protocol_fee_wallet
        + 8   // job_timeout_slots
        + 8   // slash_amount
        + 8   // cooldown_slots
        + 2   // active_relayer_count
        + 8   // total_jobs_completed
        + 1   // is_active
        + 1;  // bump

    /// Maximum protocol fee: 50% (5000 bps)
    pub const MAX_PROTOCOL_FEE_BPS: u16 = 5000;

    /// Calculate the protocol fee for a given job fee amount
    pub fn protocol_fee_for(&self, fee: u64) -> u64 {
        (fee as u128)
            .checked_mul(self.protocol_fee_bps as u128)
            .unwrap_or(0)
            .checked_div(10_000)
            .unwrap_or(0) as u64
    }

    /// Check whether the network can accept a new relayer registration
    pub fn can_register(&self) -> bool {
        self.is_active && self.active_relayer_count < self.max_relayers
    }
}
