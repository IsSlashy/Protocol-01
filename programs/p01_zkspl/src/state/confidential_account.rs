use anchor_lang::prelude::*;

/// A confidential token account.
/// Holds an encrypted balance as a Poseidon hash commitment.
/// Nobody can see the actual balance — only the owner knows it.
///
/// Balance commitment = Poseidon(balance, salt, owner_pubkey, token_mint)
/// where owner_pubkey = Poseidon(spending_key)
#[account]
#[derive(Default)]
pub struct ConfidentialAccount {
    /// Solana wallet that owns this account
    pub owner: Pubkey,

    /// The SPL token mint
    pub mint: Pubkey,

    /// Current balance commitment: Poseidon(balance, salt, owner_pubkey, token_mint)
    /// This is the only on-chain balance representation.
    /// Nobody can determine the actual balance from this hash.
    pub balance_commitment: [u8; 32],

    /// Anti-replay nonce (incremented on every state change)
    pub nonce: u64,

    /// Pending credits from incoming private transfers.
    /// Each entry is an amount_hash = Poseidon(amount, amount_salt).
    /// The recipient must apply these to update their balance.
    /// Max 16 pending credits (prevents account bloat).
    pub pending_credits: Vec<PendingCredit>,

    /// Optional viewing keys for compliance.
    /// If a pubkey is listed here, that entity can request a viewing proof.
    /// Entirely opt-in — the owner adds/removes viewers.
    pub viewer_keys: Vec<Pubkey>,

    /// Whether this account is initialized and active
    pub is_initialized: bool,

    /// Creation timestamp
    pub created_at: i64,

    /// Last operation timestamp
    pub last_tx_at: i64,

    /// PDA bump
    pub bump: u8,
}

/// A pending credit from an incoming private transfer.
/// The sender created the amount_hash and the recipient must apply it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct PendingCredit {
    /// Poseidon(amount, amount_salt) — matches the sender's proof
    pub amount_hash: [u8; 32],

    /// Who sent this credit
    pub sender: Pubkey,

    /// When it was received
    pub timestamp: i64,
}

impl ConfidentialAccount {
    /// Maximum pending credits before the account must process them
    pub const MAX_PENDING_CREDITS: usize = 16;

    /// Maximum viewer keys
    pub const MAX_VIEWER_KEYS: usize = 8;

    pub const LEN: usize = 8   // discriminator
        + 32  // owner
        + 32  // mint
        + 32  // balance_commitment
        + 8   // nonce
        + 4 + (Self::MAX_PENDING_CREDITS * PendingCredit::LEN)  // pending_credits Vec
        + 4 + (Self::MAX_VIEWER_KEYS * 32)  // viewer_keys Vec
        + 1   // is_initialized
        + 8   // created_at
        + 8   // last_tx_at
        + 1;  // bump

    pub const SEED_PREFIX: &'static [u8] = b"zkspl_account";
}

impl PendingCredit {
    pub const LEN: usize = 32  // amount_hash
        + 32  // sender
        + 8;  // timestamp
}
