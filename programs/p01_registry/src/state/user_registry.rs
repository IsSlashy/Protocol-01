use anchor_lang::prelude::*;

/// ML-KEM-768 public key size per FIPS 203
pub const KEM_PUBKEY_LEN: usize = 1184;

/// Maximum display name length (UTF-8 bytes)
pub const MAX_NAME_LEN: usize = 32;

/// UserRegistry entry — on-chain stealth meta-address record.
///
/// Allows anyone to look up a user's stealth meta-address by their wallet
/// address, enabling private payments without out-of-band coordination.
///
/// Supports both v1 (classical X25519 only) and v2 (hybrid X25519 + ML-KEM-768).
///
/// # Account size breakdown
///   discriminator             8
///   owner                    32
///   spending_pub_key         32
///   viewing_pub_key          32
///   version                   1
///   has_kem_key               1
///   kem_pub_key            1184   (ML-KEM-768, zeroed if v1)
///   name_len                  4   (u32 Borsh length prefix)
///   name                     32   (max 32 bytes UTF-8)
///   created_at                8
///   updated_at                8
///   bump                      1
///   ─────────────────────────────
///   total                  1343 bytes
#[account]
pub struct UserRegistry {
    /// The wallet that owns this registry entry
    pub owner: Pubkey,

    /// Spending public key (Ed25519, 32 bytes)
    /// Used to derive stealth addresses for this recipient
    pub spending_pub_key: [u8; 32],

    /// Viewing public key (X25519, 32 bytes)
    /// Used in ECDH to derive shared secrets for stealth scanning
    pub viewing_pub_key: [u8; 32],

    /// Meta-address version: 1 = classical, 2 = hybrid (X25519 + ML-KEM)
    pub version: u8,

    /// Whether the KEM public key is populated
    pub has_kem_key: bool,

    /// ML-KEM-768 public key (1184 bytes, FIPS 203)
    /// Zeroed if version == 1
    pub kem_pub_key: [u8; KEM_PUBKEY_LEN],

    /// Optional display name (max 32 bytes UTF-8)
    pub name: String,

    /// Unix timestamp when this entry was first created
    pub created_at: i64,

    /// Unix timestamp when this entry was last updated
    pub updated_at: i64,

    /// PDA bump seed
    pub bump: u8,
}

impl UserRegistry {
    /// Account space = 8 (disc) + 32 + 32 + 32 + 1 + 1 + 1184 + (4 + 32) + 8 + 8 + 1 = 1343
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 1 + 1 + KEM_PUBKEY_LEN + (4 + MAX_NAME_LEN) + 8 + 8 + 1;

    pub const SEED_PREFIX: &'static [u8] = b"user_registry";
}
