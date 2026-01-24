use anchor_lang::prelude::*;

/// P01Wallet - Main wallet account for privacy operations
///
/// This account stores the cryptographic keys needed for stealth addressing
/// and private payments. The viewing key allows scanning for incoming payments
/// while the spending key authorizes outgoing transactions.
#[account]
#[derive(Default)]
pub struct P01Wallet {
    /// The owner's public key (authority)
    pub owner: Pubkey,

    /// Viewing key for scanning stealth payments (derived from owner's key)
    /// Used to detect incoming stealth payments without revealing the recipient
    pub viewing_key: [u8; 32],

    /// Spending key for authorizing outgoing payments
    /// Required to claim stealth payments or send private transactions
    pub spending_key: [u8; 32],

    /// Nonce for generating unique stealth addresses
    /// Incremented with each outgoing stealth payment
    pub nonce: u64,

    /// PDA bump seed for deterministic address derivation
    pub bump: u8,
}

impl P01Wallet {
    /// Account space calculation for rent exemption
    /// discriminator (8) + owner (32) + viewing_key (32) + spending_key (32) + nonce (8) + bump (1)
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1;

    /// Seed prefix for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"p01_wallet";

    /// Initialize the wallet with the given keys
    pub fn initialize(
        &mut self,
        owner: Pubkey,
        viewing_key: [u8; 32],
        spending_key: [u8; 32],
        bump: u8,
    ) {
        self.owner = owner;
        self.viewing_key = viewing_key;
        self.spending_key = spending_key;
        self.nonce = 0;
        self.bump = bump;
    }

    /// Increment nonce and return the new value
    pub fn increment_nonce(&mut self) -> u64 {
        self.nonce = self.nonce.saturating_add(1);
        self.nonce
    }

    /// Verify that the given pubkey is the owner
    pub fn is_owner(&self, pubkey: &Pubkey) -> bool {
        self.owner == *pubkey
    }
}
