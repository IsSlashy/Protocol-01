use anchor_lang::prelude::*;

use crate::errors::SpecterError;
use crate::state::SpecterWallet;

/// Initialize a new Specter wallet for the signing user
///
/// # Arguments
/// * `viewing_key` - 32-byte viewing key for scanning incoming stealth payments
/// * `spending_key` - 32-byte spending key for authorizing transactions
#[derive(Accounts)]
pub struct InitWallet<'info> {
    /// The user creating the wallet (pays for account creation)
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The Specter wallet PDA to be created
    #[account(
        init,
        payer = owner,
        space = SpecterWallet::LEN,
        seeds = [SpecterWallet::SEED_PREFIX, owner.key().as_ref()],
        bump
    )]
    pub wallet: Account<'info, SpecterWallet>,

    /// System program for account creation
    pub system_program: Program<'info, System>,
}

/// Handler for init_wallet instruction
pub fn handler(
    ctx: Context<InitWallet>,
    viewing_key: [u8; 32],
    spending_key: [u8; 32],
) -> Result<()> {
    // Validate that keys are not all zeros
    if viewing_key == [0u8; 32] {
        return Err(SpecterError::InvalidViewingKey.into());
    }

    if spending_key == [0u8; 32] {
        return Err(SpecterError::InvalidSpendingKey.into());
    }

    let wallet = &mut ctx.accounts.wallet;
    let bump = ctx.bumps.wallet;

    wallet.initialize(
        ctx.accounts.owner.key(),
        viewing_key,
        spending_key,
        bump,
    );

    msg!("Specter wallet initialized for {}", ctx.accounts.owner.key());
    msg!("Wallet PDA: {}", wallet.key());

    Ok(())
}
