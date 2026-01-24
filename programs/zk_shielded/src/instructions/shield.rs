use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, ShieldedPool};

/// Shield tokens: deposit transparent tokens into the shielded pool
/// The user provides a commitment (hash of amount, pubkey, randomness, token_mint)
/// and the tokens are transferred to the pool
/// The new_root is computed off-chain by the client (Poseidon syscall not yet enabled)
///
/// Supports both native SOL and SPL tokens:
/// - For native SOL: token_mint is System Program ID, uses SystemProgram transfer
/// - For SPL tokens: uses Token program transfer
#[derive(Accounts)]
#[instruction(amount: u64, commitment: [u8; 32], new_root: [u8; 32])]
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

    /// System program (required for native SOL transfers)
    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    /// CHECK: Only used when shielding SPL tokens
    pub token_program: Option<Program<'info, Token>>,

    /// User's token account (optional, only for SPL tokens)
    /// CHECK: Validated in handler when needed
    #[account(mut)]
    pub user_token_account: Option<Account<'info, TokenAccount>>,

    /// Pool's token vault (optional, only for SPL tokens)
    /// CHECK: Validated in handler when needed
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,
}

pub fn handler(ctx: Context<Shield>, amount: u64, commitment: [u8; 32], new_root: [u8; 32]) -> Result<()> {
    require!(amount > 0, ZkShieldedError::InvalidAmount);

    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // Check if this is native SOL or SPL token
    let is_native_sol = pool.token_mint == system_program::ID;

    if is_native_sol {
        // Native SOL: transfer lamports from depositor to pool PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        msg!("Transferred {} lamports (native SOL) to shielded pool", amount);
    } else {
        // SPL Token: transfer tokens from user account to pool vault
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let user_token_account = ctx.accounts.user_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;

        // Validate token accounts
        require!(
            user_token_account.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            user_token_account.owner == ctx.accounts.depositor.key(),
            ZkShieldedError::InvalidTokenOwner
        );
        require!(
            pool_vault.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
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

        msg!("Transferred {} SPL tokens to shielded pool", amount);
    }

    // Insert commitment into Merkle tree with client-computed root
    // NOTE: Using insert_with_root because Poseidon syscall is not yet enabled
    let leaf_index = merkle_tree.insert_with_root(commitment, new_root)?;

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
