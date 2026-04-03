use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::DenominatedPool;

/// Resize an existing denominated pool account to accommodate new fields.
/// Uses AccountInfo to avoid deserialization failure on undersized accounts.
/// Admin-only.
#[derive(Accounts)]
pub struct ResizeDenominatedPool<'info> {
    /// Pool authority (pays for realloc rent)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Manually validated (owner + authority)
    #[account(mut)]
    pub denominated_pool: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ResizeDenominatedPool>) -> Result<()> {
    let pool_info = &ctx.accounts.denominated_pool;
    let authority = &ctx.accounts.authority;

    // Validate the account belongs to our program
    require!(
        pool_info.owner == ctx.program_id,
        ZkShieldedError::InvalidMerkleRoot
    );

    // Read authority from the account (offset 8 = after discriminator)
    {
        let data = pool_info.try_borrow_data()?;
        require!(data.len() >= 40, ZkShieldedError::InvalidMerkleRoot);
        let stored_authority = Pubkey::try_from(&data[8..40])
            .map_err(|_| error!(ZkShieldedError::Unauthorized))?;
        require!(
            stored_authority == authority.key(),
            ZkShieldedError::Unauthorized
        );
    }

    let new_len = DenominatedPool::LEN;
    let current_len = pool_info.data_len();

    if current_len >= new_len {
        msg!("Pool already at target size ({} bytes)", current_len);
        return Ok(());
    }

    let rent = Rent::get()?;
    let new_minimum_balance = rent.minimum_balance(new_len);
    let lamports_diff = new_minimum_balance.saturating_sub(pool_info.lamports());

    if lamports_diff > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: authority.to_account_info(),
                    to: pool_info.clone(),
                },
            ),
            lamports_diff,
        )?;
    }

    pool_info.resize(new_len)?; // zero-fill new bytes

    msg!(
        "Resized denominated pool from {} to {} bytes",
        current_len,
        new_len
    );

    Ok(())
}
