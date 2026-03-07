use anchor_lang::prelude::*;

/// Winternitz One-Time Signature (WOTS+) Vault
///
/// Quantum-safe fund protection using hash-based one-time signatures.
/// Each withdrawal requires a valid WOTS+ signature that a quantum
/// attacker cannot forge (relies only on SHA-256 preimage resistance).
///
/// Design based on the Solana Winternitz Vault pattern:
/// - 32 hash chains, Winternitz parameter w=16 (4 bits per chain)
/// - Each chain: hash 0..15 steps of a secret value
/// - Public key = hash^15(secret_i) for each chain i
/// - Signature = hash^(15-m_i)(secret_i) where m_i = nibble i of message
/// - Verification: hash^(m_i)(sig_i) == pk_i for all chains
///
/// Security: 128-bit classical, ~112-bit quantum (Grover on SHA-256)
#[account]
pub struct WinternitzVault {
    /// Owner who can deposit (Ed25519 key, for convenience only)
    pub owner: Pubkey,
    /// Current WOTS+ public key root (Merkle root of 32 chain endpoints)
    /// This is a SHA-256 hash of all 32 chain-end values concatenated
    pub wots_pubkey_hash: [u8; 32],
    /// Lamports balance held in vault
    pub balance: u64,
    /// Number of withdrawals (each consumes a WOTS+ key)
    pub withdrawal_count: u64,
    /// Vault creation timestamp
    pub created_at: i64,
    /// Whether the vault is frozen (emergency lockdown)
    pub frozen: bool,
    /// Bump seed for PDA
    pub bump: u8,
}

impl WinternitzVault {
    /// 8 (discriminator) + 32 + 32 + 8 + 8 + 8 + 1 + 1 = 98
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1;
}

/// Winternitz OTS parameters
pub const WOTS_CHAINS: usize = 32;
/// Winternitz parameter w=16: each chain has 15 hash steps (0..15)
pub const WOTS_W: u8 = 16;
/// Maximum value per chain (w - 1)
pub const WOTS_MAX_VAL: u8 = WOTS_W - 1;
/// Bytes per hash output (SHA-256)
pub const HASH_SIZE: usize = 32;
/// Total WOTS+ signature size: 32 chains * 32 bytes = 1024 bytes
pub const WOTS_SIG_SIZE: usize = WOTS_CHAINS * HASH_SIZE;
/// Total WOTS+ public key size: 32 chains * 32 bytes = 1024 bytes
pub const WOTS_PUBKEY_SIZE: usize = WOTS_CHAINS * HASH_SIZE;
