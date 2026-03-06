use anchor_lang::prelude::*;

use crate::state::RelayerConfig;

/// Update the relayer network configuration.
///
/// Only the authority can update. All params are optional so individual
/// fields can be updated without touching others.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// Must be the current config authority
    pub authority: Signer<'info>,

    /// Relayer config PDA
    #[account(
        mut,
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump,
        has_one = authority @ crate::errors::RelayerError::Unauthorized
    )]
    pub config: Account<'info, RelayerConfig>,
}

pub fn handler(
    ctx: Context<UpdateConfig>,
    min_stake: Option<u64>,
    max_relayers: Option<u16>,
    job_fee_lamports: Option<u64>,
    protocol_fee_bps: Option<u16>,
    protocol_fee_wallet: Option<Pubkey>,
    job_timeout_slots: Option<u64>,
    slash_amount: Option<u64>,
    cooldown_slots: Option<u64>,
    is_active: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(v) = min_stake {
        config.min_stake = v;
    }
    if let Some(v) = max_relayers {
        config.max_relayers = v;
    }
    if let Some(v) = job_fee_lamports {
        config.job_fee_lamports = v;
    }
    if let Some(v) = protocol_fee_bps {
        require!(
            v <= RelayerConfig::MAX_PROTOCOL_FEE_BPS,
            crate::errors::RelayerError::InvalidFee
        );
        config.protocol_fee_bps = v;
    }
    if let Some(v) = protocol_fee_wallet {
        config.protocol_fee_wallet = v;
    }
    if let Some(v) = job_timeout_slots {
        config.job_timeout_slots = v;
    }
    if let Some(v) = slash_amount {
        config.slash_amount = v;
    }
    if let Some(v) = cooldown_slots {
        config.cooldown_slots = v;
    }
    if let Some(v) = is_active {
        config.is_active = v;
    }

    msg!("Relayer config updated");

    Ok(())
}
