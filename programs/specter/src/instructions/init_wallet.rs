use anchor_lang::prelude::*;

use crate::errors::P01Error;
use crate::state::P01Wallet;

/// Initialize a new Protocol 01 wallet for the signing user
///
/// # Arguments
/// * `viewing_key` - 32-byte viewing key for scanning incoming stealth payments
/// * `spending_key` - 32-byte spending key for authorizing transactions
#[derive(Accounts)]
pub struct InitWallet<'info> {
    /// The user creating the wallet (pays for account creation)
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The Protocol 01 wallet PDA to be created
    #[account(
        init,
        payer = owner,
        space = P01Wallet::LEN,
        seeds = [P01Wallet::SEED_PREFIX, owner.key().as_ref()],
        bump
    )]
    pub wallet: Account<'info, P01Wallet>,

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
        return Err(P01Error::InvalidViewingKey.into());
    }

    if spending_key == [0u8; 32] {
        return Err(P01Error::InvalidSpendingKey.into());
    }

    let wallet = &mut ctx.accounts.wallet;
    let bump = ctx.bumps.wallet;

    wallet.initialize(
        ctx.accounts.owner.key(),
        viewing_key,
        spending_key,
        bump,
    );

    msg!("Protocol 01 wallet initialized for {}", ctx.accounts.owner.key());
    msg!("Wallet PDA: {}", wallet.key());

    Ok(())
}
