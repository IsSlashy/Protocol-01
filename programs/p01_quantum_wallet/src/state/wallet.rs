use anchor_lang::prelude::*;

/// Per-owner quantum-safe smart-contract wallet.
///
/// PDA seeds: `[b"qw", owner_id.as_ref()]`. The `owner_id` is a stable
/// identifier — typically the user's Ed25519 pubkey at init time — but its
/// security role is purely as a seed, NOT as a signer of withdrawals. Once
/// the wallet is initialized, fund custody is gated by knowledge of the
/// preimage of `commitment_to_secret` (verified via STARK), so the Ed25519
/// keypair behind `owner_id` may be considered compromised without putting
/// funds at risk. See `instructions::withdraw` for the auth flow.
#[account]
pub struct QuantumWalletAccount {
    /// Seed identifier this wallet is bound to. Does NOT authorize spending.
    pub owner_id: Pubkey,
    /// `Poseidon(seed_secret, salt)` over the Goldilocks field. The 8-byte
    /// little-endian encoding of this commitment is what the wallet-auth STARK
    /// circuit binds its public input to.
    pub commitment_to_secret: [u8; 32],
    /// Current SOL balance held inside the PDA (lamports). Tracks lamports
    /// separately from `to_account_info().lamports()` so we can validate
    /// arithmetic deterministically; the two are reconciled at every state
    /// mutation.
    pub balance: u64,
    /// Monotonic nonce. Bumped on every spend-side instruction (withdraw,
    /// transfer, rotate, recover) so a STARK proof bound to nonce N cannot be
    /// replayed against nonce N+1.
    pub nonce: u64,
    /// Optional SPHINCS+ public key for `emergency_recover`. When `None`, the
    /// wallet has opted out of recovery — funds are unrecoverable if the seed
    /// is lost. The on-chain key is the 32-byte SPHINCS+-128f-simple pubkey
    /// (NIST FIPS 205 / SLH-DSA).
    pub recovery_pubkey: Option<[u8; 32]>,
    /// Slot at init time, for audit and analytics.
    pub created_slot: u64,
    /// PDA bump.
    pub bump: u8,
}

impl QuantumWalletAccount {
    pub const SEED_PREFIX: &'static [u8] = b"qw";

    /// `8` Anchor discriminator + struct size.
    pub const SIZE: usize = 8        // discriminator
        + 32                          // owner_id
        + 32                          // commitment_to_secret
        + 8                           // balance
        + 8                           // nonce
        + 1 + 32                      // Option<[u8; 32]> recovery_pubkey
        + 8                           // created_slot
        + 1                           // bump
        + 16;                         // padding for future fields
}

/// Encode the 8-byte little-endian Goldilocks felt that the STARK circuit
/// receives as public input. Convention: the first 8 bytes of the 32-byte
/// commitment field hold the Goldilocks u64 in LE; the remaining 24 bytes are
/// reserved (zero today, hash-extension in future).
pub fn commitment_public_input_bytes(commitment: &[u8; 32]) -> [u8; 8] {
    let mut out = [0u8; 8];
    out.copy_from_slice(&commitment[..8]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commitment_public_input_takes_first_eight_bytes_le() {
        let mut commitment = [0u8; 32];
        commitment[..8].copy_from_slice(&u64::to_le_bytes(0xDEAD_BEEF_CAFE_F00D));
        commitment[8] = 0xFF; // must be ignored
        assert_eq!(
            commitment_public_input_bytes(&commitment),
            u64::to_le_bytes(0xDEAD_BEEF_CAFE_F00D)
        );
    }

    #[test]
    fn wallet_size_accounts_for_all_fields_with_padding() {
        // Hand-counted: 8 discriminator + 32 + 32 + 8 + 8 + (1 + 32) + 8 + 1 + 16
        // = 146 bytes; the constant must be at least that.
        let computed = 8 + 32 + 32 + 8 + 8 + 1 + 32 + 8 + 1 + 16;
        assert_eq!(QuantumWalletAccount::SIZE, computed);
        assert!(QuantumWalletAccount::SIZE >= 8 + 32 + 32 + 8 + 8 + 33 + 8 + 1);
    }
}
