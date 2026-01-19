use anchor_lang::prelude::*;

/// StealthAccount - One-time stealth payment account
///
/// This account represents a pending stealth payment that can only be claimed
/// by the intended recipient who possesses the corresponding private key.
/// The payment details are encrypted to preserve privacy.
#[account]
#[derive(Default)]
pub struct StealthAccount {
    /// The derived stealth public key (one-time address)
    /// Generated using ECDH between sender and recipient viewing keys
    pub recipient_key: [u8; 32],

    /// Encrypted amount using recipient's viewing key
    /// Only the recipient can decrypt this to know the payment amount
    pub encrypted_amount: [u8; 32],

    /// Token mint address (Pubkey::default() for native SOL)
    pub token_mint: Pubkey,

    /// Whether this stealth payment has been claimed
    pub claimed: bool,

    /// Unix timestamp when the payment was created
    pub created_at: i64,

    /// PDA bump seed
    pub bump: u8,
}

impl StealthAccount {
    /// Account space calculation
    /// discriminator (8) + recipient_key (32) + encrypted_amount (32) +
    /// token_mint (32) + claimed (1) + created_at (8) + bump (1)
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 8 + 1;

    /// Seed prefix for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"stealth";

    /// Stealth payment expiry time (30 days in seconds)
    pub const EXPIRY_SECONDS: i64 = 30 * 24 * 60 * 60;

    /// Initialize a new stealth payment
    pub fn initialize(
        &mut self,
        recipient_key: [u8; 32],
        encrypted_amount: [u8; 32],
        token_mint: Pubkey,
        created_at: i64,
        bump: u8,
    ) {
        self.recipient_key = recipient_key;
        self.encrypted_amount = encrypted_amount;
        self.token_mint = token_mint;
        self.claimed = false;
        self.created_at = created_at;
        self.bump = bump;
    }

    /// Mark the stealth payment as claimed
    pub fn mark_claimed(&mut self) {
        self.claimed = true;
    }

    /// Check if the payment has expired
    pub fn is_expired(&self, current_time: i64) -> bool {
        current_time > self.created_at.saturating_add(Self::EXPIRY_SECONDS)
    }

    /// Check if the payment can be claimed
    pub fn can_claim(&self, current_time: i64) -> bool {
        !self.claimed && !self.is_expired(current_time)
    }
}

/// Decoy levels for transaction privacy
/// Higher levels provide more privacy but cost more compute units
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DecoyLevel {
    /// No decoys (fastest, least private)
    None = 0,
    /// 2 decoy outputs
    Low = 1,
    /// 4 decoy outputs
    Medium = 2,
    /// 8 decoy outputs
    High = 3,
    /// 16 decoy outputs (most private, highest cost)
    Maximum = 4,
}

impl Default for DecoyLevel {
    fn default() -> Self {
        DecoyLevel::Medium
    }
}

impl DecoyLevel {
    /// Convert from u8 to DecoyLevel
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(DecoyLevel::None),
            1 => Some(DecoyLevel::Low),
            2 => Some(DecoyLevel::Medium),
            3 => Some(DecoyLevel::High),
            4 => Some(DecoyLevel::Maximum),
            _ => None,
        }
    }

    /// Get the number of decoys for this level
    pub fn decoy_count(&self) -> u8 {
        match self {
            DecoyLevel::None => 0,
            DecoyLevel::Low => 2,
            DecoyLevel::Medium => 4,
            DecoyLevel::High => 8,
            DecoyLevel::Maximum => 16,
        }
    }
}
