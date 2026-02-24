use anchor_lang::prelude::*;
use crate::state::MintConfig;

/// Register an SPL token for zkSPL confidential operations.
/// Creates a MintConfig PDA that stores verification keys and settings.
/// Only needs to be called once per token mint.
#[derive(Accounts)]
#[instruction(balance_vk_hash: [u8; 32], proof_vk_hash: [u8; 32])]
pub struct InitializeMint<'info> {
    /// Authority paying for account creation
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The SPL token mint to enable for zkSPL
    /// CHECK: We just store the pubkey, no mint validation needed
    pub token_mint: UncheckedAccount<'info>,

    /// MintConfig PDA — one per token mint
    #[account(
        init,
        payer = authority,
        space = MintConfig::LEN,
        seeds = [MintConfig::SEED_PREFIX, token_mint.key().as_ref()],
        bump
    )]
    pub mint_config: Account<'info, MintConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeMint>,
    balance_vk_hash: [u8; 32],
    proof_vk_hash: [u8; 32],
) -> Result<()> {
    let config = &mut ctx.accounts.mint_config;
    let clock = Clock::get()?;

    config.authority = ctx.accounts.authority.key();
    config.token_mint = ctx.accounts.token_mint.key();
    config.balance_vk_hash = balance_vk_hash;
    config.proof_vk_hash = proof_vk_hash;
    config.is_active = true;
    config.account_count = 0;
    config.created_at = clock.unix_timestamp;
    config.bump = ctx.bumps.mint_config;

    msg!("zkSPL mint initialized for: {}", config.token_mint);

    Ok(())
}
