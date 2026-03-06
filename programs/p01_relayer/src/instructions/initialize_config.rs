use anchor_lang::prelude::*;

use crate::state::RelayerConfig;

/// Initialize the singleton relayer network configuration.
///
/// Only the deployer/admin calls this once to bootstrap the network.
/// PDA: [b"relayer_config"]
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    /// Admin who will control the relayer config
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Relayer config PDA (singleton)
    #[account(
        init,
        payer = authority,
        space = RelayerConfig::LEN,
        seeds = [RelayerConfig::SEED_PREFIX],
        bump
    )]
    pub config: Account<'info, RelayerConfig>,

    /// System program
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    min_stake: u64,
    max_relayers: u16,
    job_fee_lamports: u64,
    protocol_fee_bps: u16,
    protocol_fee_wallet: Pubkey,
    job_timeout_slots: u64,
    slash_amount: u64,
    cooldown_slots: u64,
) -> Result<()> {
    require!(
        protocol_fee_bps <= RelayerConfig::MAX_PROTOCOL_FEE_BPS,
        crate::errors::RelayerError::InvalidFee
    );

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.min_stake = min_stake;
    config.max_relayers = max_relayers;
    config.job_fee_lamports = job_fee_lamports;
    config.protocol_fee_bps = protocol_fee_bps;
    config.protocol_fee_wallet = protocol_fee_wallet;
    config.job_timeout_slots = job_timeout_slots;
    config.slash_amount = slash_amount;
    config.cooldown_slots = cooldown_slots;
    config.active_relayer_count = 0;
    config.total_jobs_completed = 0;
    config.is_active = true;
    config.bump = ctx.bumps.config;

    msg!("Relayer config initialized: min_stake={}, max_relayers={}", min_stake, max_relayers);

    Ok(())
}
