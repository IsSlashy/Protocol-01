use anchor_lang::prelude::*;

/// Subscription vault: holds funds deposited by a subscriber for periodic
/// claims by a retailer. Supports two modes:
///
/// **Normal mode**: `subscriber_pubkey` is set, vault actions require wallet signature.
/// **Private mode**: `subscriber_commitment` is set (Poseidon(secret)), vault actions
/// require a ZK proof of knowledge of the secret.
///
/// PDA: [b"subscription_vault", retailer, subscriber_id_bytes, token_mint]
/// where subscriber_id_bytes = subscriber_pubkey (normal) or subscriber_commitment (private)
#[account]
#[derive(Default)]
pub struct SubscriptionVault {
    /// Subscriber wallet (normal mode only)
    pub subscriber_pubkey: Option<Pubkey>,

    /// Subscriber commitment = Poseidon(secret) (private mode only)
    pub subscriber_commitment: Option<[u8; 32]>,

    /// Retailer who receives periodic payments
    pub retailer: Pubkey,

    /// Token mint (system program ID for native SOL)
    pub token_mint: Pubkey,

    /// Total amount deposited into the vault
    pub total_deposited: u64,

    /// Amount paid per period (in lamports / atomic units)
    pub rate: u64,

    /// Number of slots between each claimable period
    pub interval_slots: u64,

    /// Slot at which the subscription started
    pub start_slot: i64,

    /// Number of periods already claimed by the retailer
    pub claimed_periods: u64,

    /// Whether the vault is active (accepting claims)
    pub is_active: bool,

    /// Whether the vault is paused (no claims while paused)
    pub is_paused: bool,

    /// Slot at which the vault was paused (if paused)
    pub pause_slot: Option<i64>,

    /// Total slots spent in paused state (accumulated over pause/resume cycles)
    pub total_paused_slots: i64,

    /// VK hash for subscriber ownership circuit (private mode)
    pub vk_hash_subscriber: [u8; 32],

    /// Source denominated pool (for cancel_private re-shield)
    pub source_pool: Option<Pubkey>,

    /// PDA bump seed
    pub bump: u8,

    /// Stealth meta address (v1) for refund-via-relayer delivery on cancel.
    /// Layout: `[spending_pub(32) | viewing_pub(32)]`.
    /// `None` for legacy V4 vaults — those fall back to the legacy reshield
    /// path in `cancel_private_stark`. Appended at the end so existing
    /// vaults decode as `None` from trailing zero padding.
    pub client_stealth_meta: Option<[u8; 64]>,

    /// License commitment = Poseidon(licenseSecret), posted by the subscriber
    /// at subscribe time so a merchant can later verify a presented license key
    /// by checking Poseidon(decode(key)) == license_commitment OFF-CHAIN.
    /// The chain only stores the 32 raw bytes — no Poseidon/verification runs
    /// on-chain. `None` for vaults created before this field existed; appended
    /// at the very end so existing vault accounts decode it as `None` from
    /// trailing zero padding (same backward-compat trick as `client_stealth_meta`).
    pub license_commitment: Option<[u8; 32]>,
}

impl SubscriptionVault {
    pub const SEED_PREFIX: &'static [u8] = b"subscription_vault";

    /// Account size: discriminator + all fields
    /// Option<Pubkey> = 1 + 32 = 33
    /// Option<[u8;32]> = 1 + 32 = 33
    /// Option<i64> = 1 + 8 = 9
    /// Option<Pubkey> = 1 + 32 = 33
    pub const LEN: usize = 8   // discriminator
        + 33   // subscriber_pubkey: Option<Pubkey>
        + 33   // subscriber_commitment: Option<[u8;32]>
        + 32   // retailer
        + 32   // token_mint
        + 8    // total_deposited
        + 8    // rate
        + 8    // interval_slots
        + 8    // start_slot (i64)
        + 8    // claimed_periods
        + 1    // is_active
        + 1    // is_paused
        + 9    // pause_slot: Option<i64>
        + 8    // total_paused_slots (i64)
        + 32   // vk_hash_subscriber
        + 33   // source_pool: Option<Pubkey>
        + 1    // bump
        + 65   // client_stealth_meta: Option<[u8; 64]> (1 tag + 64 value)
        + 33;  // license_commitment: Option<[u8; 32]> (1 tag + 32 value)

    /// Returns the subscriber ID bytes used in the PDA seed.
    /// Normal mode: subscriber pubkey bytes
    /// Private mode: subscriber commitment bytes
    pub fn subscriber_id_bytes(&self) -> [u8; 32] {
        if let Some(pubkey) = self.subscriber_pubkey {
            pubkey.to_bytes()
        } else if let Some(commitment) = self.subscriber_commitment {
            commitment
        } else {
            [0u8; 32]
        }
    }

    /// Returns whether this is a normal (wallet-based) vault
    pub fn is_normal_mode(&self) -> bool {
        self.subscriber_pubkey.is_some()
    }

    /// Returns whether this is a private (ZK-based) vault
    pub fn is_private_mode(&self) -> bool {
        self.subscriber_commitment.is_some()
    }

    /// Compute the number of claimable periods based on elapsed time.
    /// Accounts for paused time.
    pub fn claimable_periods(&self, current_slot: i64) -> u64 {
        if !self.is_active || self.is_paused {
            return 0;
        }

        let effective_elapsed = self.effective_elapsed_slots(current_slot);
        if effective_elapsed <= 0 {
            return 0;
        }

        let total_periods = (effective_elapsed as u64) / self.interval_slots;
        let unclaimed = total_periods.saturating_sub(self.claimed_periods);

        // Cap at remaining funded periods so retailer payout never exceeds
        // the residual vault balance (prevents u64 underflow when cancelling
        // a vault whose elapsed window outran its funding).
        let max_funded = if self.rate == 0 {
            0
        } else {
            (self.total_deposited / self.rate).saturating_sub(self.claimed_periods)
        };
        unclaimed.min(max_funded)
    }

    /// Compute effective elapsed slots (subtracting paused time)
    fn effective_elapsed_slots(&self, current_slot: i64) -> i64 {
        let elapsed = current_slot - self.start_slot;
        elapsed - self.total_paused_slots
    }

    /// Returns true when this vault has a stealth meta address registered
    /// for refund-via-relayer routing on cancel.
    pub fn has_stealth_refund(&self) -> bool {
        self.client_stealth_meta.is_some()
    }

    /// Amount available to refund on cancellation
    pub fn refundable_amount(&self, current_slot: i64) -> u64 {
        let claimable = self.claimable_periods(current_slot);
        let total_owed = (self.claimed_periods + claimable) * self.rate;
        self.total_deposited.saturating_sub(total_owed)
    }
}
