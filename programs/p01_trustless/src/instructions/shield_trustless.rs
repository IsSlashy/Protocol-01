use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::TrustlessError;
use crate::state::{MerkleTreeState, PoolState};

/// Shield tokens into the trustless pool. No proof required.
///
/// The user deposits exactly `pool.denomination` tokens.
/// A commitment is inserted into the on-chain Merkle tree.
/// An event is emitted for client-side Merkle tree indexing.
///
/// Supports both native SOL and SPL tokens.
#[derive(Accounts)]
#[instruction(commitment: [u8; 32], new_root: [u8; 32])]
pub struct ShieldTrustless<'info> {
    /// User depositing tokens
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Pool state
    #[account(
        mut,
        seeds = [
            PoolState::SEED_PREFIX,
            pool.token_mint.as_ref(),
            &pool.denomination.to_le_bytes()
        ],
        bump = pool.bump,
        constraint = pool.is_active @ TrustlessError::PoolNotActive
    )]
    pub pool: Account<'info, PoolState>,

    /// Merkle tree state
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// System program (required for native SOL transfers)
    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// User's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub user_token_account: Option<Account<'info, TokenAccount>>,

    /// Pool's token vault (optional, only for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<ShieldTrustless>,
    commitment: [u8; 32],
    new_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let amount = pool.denomination;

    let is_native_sol = pool.token_mint == system_program::ID;

    // --- Transfer tokens ---
    if is_native_sol {
        // Native SOL: transfer exactly denomination lamports to pool PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;
    } else {
        // SPL Token transfer
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(TrustlessError::MissingTokenProgram)?;
        let user_token_account = ctx.accounts.user_token_account
            .as_ref()
            .ok_or(TrustlessError::MissingTokenAccount)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(TrustlessError::MissingPoolVault)?;

        require!(
            user_token_account.mint == pool.token_mint,
            TrustlessError::InvalidTokenMint
        );
        require!(
            user_token_account.owner == ctx.accounts.depositor.key(),
            TrustlessError::InvalidTokenOwner
        );
        require!(
            pool_vault.mint == pool.token_mint,
            TrustlessError::InvalidTokenMint
        );

        let transfer_ctx = CpiContext::new(
            token_program.to_account_info(),
            TokenTransfer {
                from: user_token_account.to_account_info(),
                to: pool_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;
    }

    // --- Insert commitment into Merkle tree ---
    let leaf_index = merkle_tree.insert_with_root(commitment, new_root)?;

    // --- Update pool state ---
    pool.update_root(merkle_tree.root);
    pool.leaf_count = merkle_tree.leaf_count;
    pool.total_shielded = pool
        .total_shielded
        .checked_add(amount)
        .ok_or(TrustlessError::ArithmeticOverflow)?;
    pool.note_count = pool
        .note_count
        .checked_add(1)
        .ok_or(TrustlessError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    // Dynamic delay: update maturity tracking and record this deposit
    let current_epoch = PoolState::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    pool.record_deposit(current_epoch);

    msg!("Commitment added at index: {}", leaf_index);

    emit!(ShieldTrustlessEvent {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        denomination: amount,
        commitment,
        leaf_index,
        new_root: merkle_tree.root,
        deposit_epoch: current_epoch,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct ShieldTrustlessEvent {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub denomination: u64,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub new_root: [u8; 32],
    pub deposit_epoch: u64,
    pub timestamp: i64,
}
