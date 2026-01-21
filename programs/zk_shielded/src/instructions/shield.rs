use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, ShieldedPool};

/// Shield tokens: deposit transparent tokens into the shielded pool
/// The user provides a commitment (hash of amount, pubkey, randomness, token_mint)
/// and the tokens are transferred to the pool
#[derive(Accounts)]
#[instruction(amount: u64, commitment: [u8; 32])]
pub struct Shield<'info> {
    /// User depositing tokens
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Shielded pool
    #[account(
        mut,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump,
        constraint = shielded_pool.is_active @ ZkShieldedError::PoolNotActive
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    /// Merkle tree state
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            shielded_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// User's token account (source)
    #[account(
        mut,
        constraint = user_token_account.mint == shielded_pool.token_mint,
        constraint = user_token_account.owner == depositor.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Pool's token vault (destination)
    #[account(
        mut,
        constraint = pool_vault.mint == shielded_pool.token_mint,
        constraint = pool_vault.owner == shielded_pool.key()
    )]
    pub pool_vault: Account<'info, TokenAccount>,

    /// Token program
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Shield>, amount: u64, commitment: [u8; 32]) -> Result<()> {
    require!(amount > 0, ZkShieldedError::InvalidAmount);

    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // Transfer tokens from user to pool vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        TokenTransfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.pool_vault.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // Insert commitment into Merkle tree
    let leaf_index = merkle_tree.insert(commitment)?;

    // Update pool state
    pool.update_root(merkle_tree.root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.total_shielded = pool
        .total_shielded
        .checked_add(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    msg!("Shielded {} tokens", amount);
    msg!("Commitment added at index: {}", leaf_index);
    msg!("New Merkle root: {:?}", merkle_tree.root);

    // Emit event for indexing
    emit!(ShieldEvent {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        commitment,
        leaf_index,
        new_root: merkle_tree.root,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Event emitted when tokens are shielded
#[event]
pub struct ShieldEvent {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub new_root: [u8; 32],
    pub timestamp: i64,
}
