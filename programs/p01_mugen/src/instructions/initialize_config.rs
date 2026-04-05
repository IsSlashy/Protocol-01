use anchor_lang::prelude::*;
use crate::errors::MugenError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitConfigParams {
    /// Total fee in basis points (e.g. 150 = 1.5%).
    pub fee_bps: u16,
    /// P01 Protocol wallet (app/infra revenue).
    pub p01_fee_wallet: Pubkey,
    /// Mugen Exchange wallet (exchange revenue).
    pub mugen_fee_wallet: Pubkey,
    /// Treasury wallet (DAO/governance).
    pub treasury_wallet: Pubkey,
    /// P01 share in bps out of 10000 (e.g. 2000 = 20%).
    pub p01_fee_share: u16,
    /// Mugen share in bps out of 10000 (e.g. 6500 = 65%).
    pub mugen_fee_share: u16,
    /// Noise fund wallet (auto-feeds noise wallets from trade fees).
    pub noise_fund_wallet: Pubkey,
    /// Noise fund share in bps out of 10000 (e.g. 1500 = 15%).
    pub noise_fee_share: u16,
    pub min_trade_amount: u64,
    pub max_trade_amount: u64,
    pub escrow_timeout: i64,
    pub dispute_timeout: i64,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = MugenConfig::LEN,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, MugenConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>, params: InitConfigParams) -> Result<()> {
    require!(params.fee_bps <= MAX_FEE_BPS, MugenError::InvalidFeeBps);
    require!(
        params.min_trade_amount < params.max_trade_amount,
        MugenError::InvalidTradeLimits,
    );
    // Shares must sum to <= 10000 (remainder goes to treasury)
    require!(
        params.p01_fee_share + params.mugen_fee_share + params.noise_fee_share <= 10000,
        MugenError::InvalidFeeBps,
    );

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.fee_bps = params.fee_bps;
    config.p01_fee_wallet = params.p01_fee_wallet;
    config.mugen_fee_wallet = params.mugen_fee_wallet;
    config.treasury_wallet = params.treasury_wallet;
    config.p01_fee_share = params.p01_fee_share;
    config.mugen_fee_share = params.mugen_fee_share;
    config.noise_fund_wallet = params.noise_fund_wallet;
    config.noise_fee_share = params.noise_fee_share;
    config.min_trade_amount = params.min_trade_amount;
    config.max_trade_amount = params.max_trade_amount;
    config.escrow_timeout = params.escrow_timeout;
    config.dispute_timeout = params.dispute_timeout;
    config.total_trades = 0;
    config.total_volume = 0;
    config.total_fees_collected = 0;
    config.is_active = true;
    config.bump = ctx.bumps.config;

    let treasury_share = 10000 - params.p01_fee_share - params.mugen_fee_share - params.noise_fee_share;
    msg!(
        "Mugen Exchange initialized — fee: {} bps, split: P01 {}% / Mugen {}% / Noise {}% / Treasury {}%",
        params.fee_bps,
        params.p01_fee_share / 100,
        params.mugen_fee_share / 100,
        params.noise_fee_share / 100,
        treasury_share / 100,
    );
    Ok(())
}
