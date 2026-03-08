use anchor_lang::prelude::*;

pub mod state;
use state::*;

declare_id!("QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB");

#[program]
pub mod p01_registry {
    use super::*;

    /// Register a v1 stealth meta-address (classical X25519 only).
    ///
    /// Creates a PDA keyed by the owner's wallet address, storing their
    /// spending and viewing public keys. Anyone can look this up to send
    /// the owner a stealth payment.
    pub fn register_v1(
        ctx: Context<Register>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
        name: String,
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(name.len() <= MAX_NAME_LEN, RegistryError::NameTooLong);

        let clock = Clock::get()?;
        let entry = &mut ctx.accounts.entry;
        entry.owner = ctx.accounts.owner.key();
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 1;
        entry.has_kem_key = false;
        entry.kem_pub_key = [0u8; KEM_PUBKEY_LEN];
        entry.name = name;
        entry.created_at = clock.unix_timestamp;
        entry.updated_at = clock.unix_timestamp;
        entry.bump = ctx.bumps.entry;

        msg!("Registry: v1 meta-address registered for {}", entry.owner);
        Ok(())
    }

    /// Register a v2 stealth meta-address (hybrid X25519 + ML-KEM-768).
    ///
    /// Same as v1 but also stores the ML-KEM-768 public key for
    /// post-quantum-resistant stealth payments.
    pub fn register_v2(
        ctx: Context<Register>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
        kem_pub_key: Vec<u8>,
        name: String,
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(kem_pub_key.len() == KEM_PUBKEY_LEN, RegistryError::InvalidKemKey);
        require!(name.len() <= MAX_NAME_LEN, RegistryError::NameTooLong);

        let clock = Clock::get()?;
        let entry = &mut ctx.accounts.entry;
        entry.owner = ctx.accounts.owner.key();
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 2;
        entry.has_kem_key = true;

        let mut kem_buf = [0u8; KEM_PUBKEY_LEN];
        kem_buf.copy_from_slice(&kem_pub_key);
        entry.kem_pub_key = kem_buf;

        entry.name = name;
        entry.created_at = clock.unix_timestamp;
        entry.updated_at = clock.unix_timestamp;
        entry.bump = ctx.bumps.entry;

        msg!("Registry: v2 hybrid meta-address registered for {}", entry.owner);
        Ok(())
    }

    /// Update the stealth meta-address keys (v1).
    /// Only the owner can update their own entry.
    pub fn update_keys_v1(
        ctx: Context<UpdateEntry>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);

        let entry = &mut ctx.accounts.entry;
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 1;
        entry.has_kem_key = false;
        entry.kem_pub_key = [0u8; KEM_PUBKEY_LEN];
        entry.updated_at = Clock::get()?.unix_timestamp;

        msg!("Registry: keys updated (v1) for {}", entry.owner);
        Ok(())
    }

    /// Update the stealth meta-address keys (v2 hybrid).
    /// Only the owner can update their own entry.
    pub fn update_keys_v2(
        ctx: Context<UpdateEntry>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
        kem_pub_key: Vec<u8>,
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(kem_pub_key.len() == KEM_PUBKEY_LEN, RegistryError::InvalidKemKey);

        let entry = &mut ctx.accounts.entry;
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 2;
        entry.has_kem_key = true;

        let mut kem_buf = [0u8; KEM_PUBKEY_LEN];
        kem_buf.copy_from_slice(&kem_pub_key);
        entry.kem_pub_key = kem_buf;

        entry.updated_at = Clock::get()?.unix_timestamp;

        msg!("Registry: keys updated (v2) for {}", entry.owner);
        Ok(())
    }

    /// Update the display name.
    pub fn update_name(ctx: Context<UpdateEntry>, name: String) -> Result<()> {
        require!(name.len() <= MAX_NAME_LEN, RegistryError::NameTooLong);

        let entry = &mut ctx.accounts.entry;
        entry.name = name;
        entry.updated_at = Clock::get()?.unix_timestamp;

        msg!("Registry: name updated for {}", entry.owner);
        Ok(())
    }

    /// Close the registry entry and reclaim rent.
    /// Only the owner can delete their own entry.
    pub fn deregister(ctx: Context<Deregister>) -> Result<()> {
        msg!("Registry: entry closed for {}", ctx.accounts.entry.owner);
        Ok(())
    }
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = UserRegistry::SIZE,
        seeds = [UserRegistry::SEED_PREFIX, owner.key().as_ref()],
        bump,
    )]
    pub entry: Account<'info, UserRegistry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateEntry<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [UserRegistry::SEED_PREFIX, owner.key().as_ref()],
        bump = entry.bump,
        has_one = owner,
    )]
    pub entry: Account<'info, UserRegistry>,
}

#[derive(Accounts)]
pub struct Deregister<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [UserRegistry::SEED_PREFIX, owner.key().as_ref()],
        bump = entry.bump,
        has_one = owner,
        close = owner,
    )]
    pub entry: Account<'info, UserRegistry>,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum RegistryError {
    #[msg("Key must not be all zeros")]
    InvalidKey,
    #[msg("ML-KEM-768 public key must be exactly 1184 bytes")]
    InvalidKemKey,
    #[msg("Display name exceeds 32 bytes")]
    NameTooLong,
}
