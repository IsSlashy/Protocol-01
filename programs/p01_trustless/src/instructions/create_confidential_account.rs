use anchor_lang::prelude::*;

use crate::state::ConfidentialAccount;

/// Create a confidential balance account for trustless zkSPL operations.
///
/// One account per (owner, token_mint) pair.
/// The initial commitment should be Poseidon(0, salt, owner_pubkey, token_mint)
/// representing a zero balance.
#[derive(Accounts)]
#[instruction(initial_commitment: [u8; 32])]
pub struct CreateConfidentialAccount<'info> {
    /// User creating the account (will own it)
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Token mint for this account
    /// CHECK: Any valid mint pubkey
    pub token_mint: AccountInfo<'info>,

    /// Confidential account (PDA)
    #[account(
        init,
        payer = owner,
        space = ConfidentialAccount::LEN,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            owner.key().as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateConfidentialAccount>,
    initial_commitment: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;

    let account = &mut ctx.accounts.confidential_account;
    account.owner = ctx.accounts.owner.key();
    account.mint = ctx.accounts.token_mint.key();
    account.balance_commitment = initial_commitment;
    account.nonce = 0;
    account.is_initialized = true;
    account.created_at = clock.unix_timestamp;
    account.last_tx_at = clock.unix_timestamp;
    account.bump = ctx.bumps.confidential_account;

    emit!(AccountCreatedEvent {
        owner: account.owner,
        mint: account.mint,
        initial_commitment,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct AccountCreatedEvent {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub initial_commitment: [u8; 32],
    pub timestamp: i64,
}
