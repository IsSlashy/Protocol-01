use anchor_lang::prelude::*;

/// Winternitz One-Time Signature (WOTS+) Vault
///
/// Quantum-safe fund protection using hash-based one-time signatures.
/// Each withdrawal requires a valid WOTS+ signature that a quantum
/// attacker cannot forge (relies only on SHA-256 preimage resistance).
///
/// Design (unified 67-chain spec, full 256-bit post-quantum security):
/// - 64 message hash chains + 3 checksum hash chains = 67 total
/// - Winternitz parameter w=16 (4 bits per chain)
/// - Each chain: hash 0..15 steps of a secret value
/// - Public key = hash^15(secret_i) for each chain i
/// - Signature = hash^(15-m_i)(secret_i) where m_i = nibble i
/// - Verification: hash^(m_i)(sig_i) == pk_i for all 67 chains
/// - Checksum = sum(15 - m_i) for i in 0..64, encoded MSB-first as 3 nibbles
///
/// Security: ~256-bit classical (SHA-256 preimage over full 32-byte digest),
/// ~128-bit quantum (Grover on SHA-256). Checksum prevents forgery via
/// nibble-decrease attack.
#[account]
pub struct WinternitzVault {
    /// Owner who can deposit (Ed25519 key, for convenience only)
    pub owner: Pubkey,
    /// Current WOTS+ public key root (SHA-256 of all 67 chain endpoints concatenated)
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

/// Message hash chains (2 nibbles per byte of 32-byte SHA-256 digest)
pub const WOTS_MSG_CHAINS: usize = 64;
/// Checksum chains: ceil(log2(64 * 15) / 4) = ceil(9.9 / 4) = 3
pub const WOTS_CHECKSUM_CHAINS: usize = 3;
/// Total chains (message + checksum)
pub const WOTS_CHAINS: usize = WOTS_MSG_CHAINS + WOTS_CHECKSUM_CHAINS;
/// Winternitz parameter w=16: each chain has 15 hash steps (0..15)
pub const WOTS_W: u8 = 16;
/// Maximum value per chain (w - 1)
pub const WOTS_MAX_VAL: u8 = WOTS_W - 1;
/// Bytes per hash output (SHA-256)
pub const HASH_SIZE: usize = 32;
/// Total WOTS+ signature size: 67 chains * 32 bytes = 2144 bytes
pub const WOTS_SIG_SIZE: usize = WOTS_CHAINS * HASH_SIZE;
/// Total WOTS+ public key size: 67 chains * 32 bytes = 2144 bytes
pub const WOTS_PUBKEY_SIZE: usize = WOTS_CHAINS * HASH_SIZE;

/// Buffer account that holds a pending WOTS+ signature uploaded in chunks.
///
/// A single WOTS+ signature is 2144 bytes, which exceeds Solana's 1232-byte
/// legacy TX cap and the 1644-byte v0 versioned TX cap — the signature
/// cannot be passed inline in a single withdrawal instruction. Instead, the
/// authority initializes this buffer, writes the 2144-byte signature in
/// multiple chunks (typically 3 × ~900 bytes), then invokes the withdrawal
/// instruction which reads from the buffer and reconstructs the pubkey by
/// walking each chain `(15 - m_i)` more hash steps.
///
/// The buffer is PDA-seeded by `[b"wots_sig", vault, authority]` so each
/// (vault, signer) pair has at most one pending buffer. The authority must
/// close the buffer (via `close_wots_sig_buffer`) after use to recover rent.
#[account]
pub struct WotsSigBuffer {
    /// Who initialized the buffer and who must sign the withdrawal.
    pub authority: Pubkey,
    /// Which Winternitz vault this signature targets. Binding here prevents
    /// a buffer from being diverted to verify against a different vault's
    /// stored pubkey hash.
    pub vault: Pubkey,
    /// Expected total signature size (always WOTS_SIG_SIZE = 2144).
    pub sig_size: u32,
    /// Running high-water-mark of bytes written so far.
    pub bytes_written: u32,
    // Signature bytes are laid out starting at SIG_DATA_OFFSET via raw
    // account-data writes (see write_wots_sig_chunk). Not modeled as a
    // Vec<u8> field to avoid re-serializing the whole struct on each chunk.
}

impl WotsSigBuffer {
    /// Byte offset where the raw signature data begins within the account.
    /// 8 (discriminator) + 32 (authority) + 32 (vault) + 4 (sig_size) + 4 (bytes_written) = 80.
    pub const SIG_DATA_OFFSET: usize = 8 + 32 + 32 + 4 + 4;

    /// Total account size for a fully-populated buffer (2224 bytes).
    pub const SPACE: usize = Self::SIG_DATA_OFFSET + WOTS_SIG_SIZE;
}
