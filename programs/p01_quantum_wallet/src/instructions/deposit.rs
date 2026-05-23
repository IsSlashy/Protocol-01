use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

use crate::errors::QWalletError;
use crate::state::QuantumWalletAccount;

/// Deposit SOL into a quantum wallet. Open: anyone may deposit to anyone's
/// wallet — there is no secret involved on the funding side.
#[derive(Accounts)]
pub struct DepositQuantum<'info> {
    /// Funds source.
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// CHECK: seed identifier of the target wallet. Used only for PDA derivation.
    pub owner_id: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [QuantumWalletAccount::SEED_PREFIX, owner_id.key().as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, QuantumWalletAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositQuantum>, amount: u64) -> Result<()> {
    require!(amount > 0, QWalletError::ZeroAmount);

    let ix = system_instruction::transfer(
        &ctx.accounts.depositor.key(),
        &ctx.accounts.wallet.key(),
        amount,
    );
    invoke(
        &ix,
        &[
            ctx.accounts.depositor.to_account_info(),
            ctx.accounts.wallet.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    let wallet = &mut ctx.accounts.wallet;
    wallet.balance = wallet
        .balance
        .checked_add(amount)
        .ok_or(QWalletError::Overflow)?;

    msg!("deposited {} lamports into quantum wallet", amount);
    Ok(())
}
