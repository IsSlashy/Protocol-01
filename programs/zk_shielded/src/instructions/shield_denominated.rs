use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState};

/// Shield tokens into a denominated pool.
///
/// The user MUST deposit exactly `pool.denomination` lamports/tokens.
/// The commitment is Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint).
/// No amount is encoded — denomination is enforced at the program level.
///
/// Supports both native SOL and SPL tokens.
#[derive(Accounts)]
#[instruction(commitment: [u8; 32], new_root: [u8; 32])]
pub struct ShieldDenominated<'info> {
    /// User depositing tokens
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Denominated pool
    #[account(
        mut,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    /// Merkle tree state
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
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
    ctx: Context<ShieldDenominated>,
    commitment: [u8; 32],
    new_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let amount = pool.denomination;

    let is_native_sol = pool.token_mint == system_program::ID;

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
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let user_token_account = ctx.accounts.user_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;

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
    }

    // Insert commitment into Merkle tree
    let leaf_index = merkle_tree.insert_with_root(commitment, new_root)?;

    // Update pool state
    pool.update_root(merkle_tree.root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.total_shielded = pool
        .total_shielded
        .checked_add(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool
        .note_count
        .checked_add(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    // Dynamic delay: update maturity tracking and record this deposit
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    pool.record_deposit(current_epoch);

    msg!("Commitment added at index: {}", leaf_index);

    emit!(ShieldDenominatedEvent {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        denomination: amount,
        commitment,
        leaf_index,
        new_root: merkle_tree.root,
        deposit_epoch: current_epoch,
        mature_note_count: pool.mature_note_count,
        dynamic_delay: pool.get_dynamic_delay(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct ShieldDenominatedEvent {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub denomination: u64,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub new_root: [u8; 32],
    pub deposit_epoch: u64,
    pub mature_note_count: u64,
    pub dynamic_delay: u64,
    pub timestamp: i64,
}
