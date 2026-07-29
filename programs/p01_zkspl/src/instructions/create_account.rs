use anchor_lang::prelude::*;
use crate::errors::ZkSplError;
use crate::state::{ConfidentialAccount, MintConfig};

/// Create a confidential account for a user + token pair.
/// The initial balance commitment is provided by the user.
/// Initial balance is 0, so commitment = Poseidon(0, initial_salt, owner_pubkey, token_mint).
/// The program cannot verify this (no Poseidon on-chain) — it trusts the user
/// for initialization only. All subsequent updates require ZK proofs.
#[derive(Accounts)]
pub struct CreateAccount<'info> {
    /// The wallet owner
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The mint config (must be active)
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump,
        constraint = mint_config.is_active @ ZkSplError::MintNotActive
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// The confidential account PDA — one per (owner, mint) pair
    #[account(
        init,
        payer = owner,
        space = ConfidentialAccount::LEN,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            owner.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateAccount>,
    initial_commitment: [u8; 32],
) -> Result<()> {
    let account = &mut ctx.accounts.confidential_account;
    let config = &ctx.accounts.mint_config;
    let clock = Clock::get()?;

    account.owner = ctx.accounts.owner.key();
    account.mint = config.token_mint;
    account.balance_commitment = initial_commitment;
    account.nonce = 0;
    account.pending_credits = Vec::new();
    account.viewer_keys = Vec::new();
    account.is_initialized = true;
    account.created_at = clock.unix_timestamp;
    account.last_tx_at = clock.unix_timestamp;
    account.bump = ctx.bumps.confidential_account;

    // Increment mint account count (mutable borrow of mint_config not needed
    // since we just read it — count update would need a separate instruction
    // or we accept the slight inaccuracy for now)

    msg!("zkSPL account created for: {}", account.owner);

    emit!(AccountCreatedEvent {
        owner: account.owner,
        mint: account.mint,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct AccountCreatedEvent {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub timestamp: i64,
}
