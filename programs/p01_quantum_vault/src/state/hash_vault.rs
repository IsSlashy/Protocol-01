use anchor_lang::prelude::*;

/// Hash-Timelock Vault for quantum-safe cold storage
///
/// Funds are locked behind a SHA-256 preimage challenge with an optional
/// timelock. Even if Ed25519 is broken by a quantum computer, an attacker
/// cannot withdraw without knowing the preimage.
///
/// Security: SHA-256 preimage resistance = 128-bit under Grover's algorithm
#[account]
pub struct HashVault {
    /// Owner who created the vault (for depositing more funds)
    pub owner: Pubkey,
    /// SHA-256(secret) — the commitment
    pub commitment: [u8; 32],
    /// Lamports balance held in vault
    pub balance: u64,
    /// Unix timestamp after which withdrawal is allowed (0 = no timelock)
    pub unlock_after: i64,
    /// Destination wallet for withdrawals
    pub destination: Pubkey,
    /// Whether the vault has been drained
    pub drained: bool,
    /// Bump seed for PDA
    pub bump: u8,
}

impl HashVault {
    /// 8 (discriminator) + 32 + 32 + 8 + 8 + 32 + 1 + 1 = 122
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 32 + 1 + 1;
}
