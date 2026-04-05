use anchor_lang::prelude::*;
use crate::state::CONFIG_SEED;

/// Close config account (devnet migration only).
/// Uses UncheckedAccount because the old struct can't be deserialized.
#[derive(Accounts)]
pub struct CloseConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: We manually verify seeds and drain lamports.
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: AccountInfo<'info>,
}

pub fn handler(ctx: Context<CloseConfig>) -> Result<()> {
    let config = &ctx.accounts.config;
    let authority = &ctx.accounts.authority;

    // Drain all lamports to authority
    let lamports = config.lamports();
    **config.try_borrow_mut_lamports()? = 0;
    **authority.try_borrow_mut_lamports()? = authority
        .lamports()
        .checked_add(lamports)
        .unwrap();

    // Zero out data
    let mut data = config.try_borrow_mut_data()?;
    data.fill(0);

    msg!("Mugen config closed — {} lamports returned", lamports);
    Ok(())
}
