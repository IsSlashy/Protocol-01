use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, NullifierSet, ShieldedPool};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Unshield tokens: withdraw from shielded pool to a transparent address
/// Requires a valid ZK proof showing ownership of the spent notes
/// The output includes a change note back to the shielded pool if not withdrawing full amount
///
/// Supports both native SOL and SPL tokens:
/// - For native SOL: transfers lamports from pool PDA to recipient
/// - For SPL tokens: transfers tokens from pool vault to recipient token account
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32],
    amount: u64,
    new_root: [u8; 32]
)]
pub struct Unshield<'info> {
    /// Transaction submitter (can be anyone)
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Recipient of the unshielded tokens
    /// CHECK: Any address can receive tokens
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// Shielded pool
    #[account(
        mut,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump,
        constraint = shielded_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = shielded_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
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

    /// Nullifier set (zero-copy for large bloom filter)
    #[account(
        mut,
        seeds = [
            NullifierSet::SEED_PREFIX,
            shielded_pool.key().as_ref()
        ],
        bump
    )]
    pub nullifier_set: AccountLoader<'info, NullifierSet>,

    /// Verification key data account
    /// CHECK: Validated by hash comparison
    pub verification_key_data: AccountInfo<'info>,

    /// System program (required for native SOL transfers)
    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    /// CHECK: Only used when unshielding SPL tokens
    pub token_program: Option<Program<'info, Token>>,

    /// Pool's token vault (optional, only for SPL tokens)
    /// CHECK: Validated in handler when needed
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Recipient's token account (optional, only for SPL tokens)
    /// CHECK: Validated in handler when needed
    #[account(mut)]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<Unshield>,
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32],
    amount: u64,
    new_root: [u8; 32],
) -> Result<()> {
    require!(amount > 0, ZkShieldedError::InvalidAmount);

    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // Check if this is native SOL
    let is_native_sol = pool.token_mint == system_program::ID;

    // Check sufficient balance
    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Load nullifier set (zero-copy)
    let mut nullifier_set = ctx.accounts.nullifier_set.load_mut()?;

    // Check nullifiers haven't been spent
    require!(
        !nullifier_set.might_contain(&nullifier_1),
        ZkShieldedError::NullifierAlreadySpent
    );
    require!(
        !nullifier_set.might_contain(&nullifier_2),
        ZkShieldedError::NullifierAlreadySpent
    );

    // Load verification key data
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;

    // Verify VK hash matches
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == pool.vk_hash,
        ZkShieldedError::InvalidVerificationKey
    );

    // For unshield, public_amount is negative (tokens leaving the pool)
    let public_amount = -(amount as i64);
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();

    // Verify the ZK proof
    let is_valid = Groth16Verifier::verify_transfer(
        &proof,
        &merkle_root,
        &nullifier_1,
        &nullifier_2,
        &output_commitment_1,
        &output_commitment_2,
        public_amount,
        &token_mint_bytes,
        &vk_data,
    )?;

    require!(is_valid, ZkShieldedError::InvalidProof);

    // Mark nullifiers as spent
    nullifier_set.add(&nullifier_1);
    nullifier_set.add(&nullifier_2);

    // Insert change commitment if non-zero (output_commitment_1 is the change note)
    // Use insert_with_root since Poseidon syscall not available on devnet
    let leaf_index = if output_commitment_1 != [0u8; 32] {
        Some(merkle_tree.insert_with_root(output_commitment_1, new_root)?)
    } else {
        None
    };

    // Prepare pool signer seeds
    let pool_key = pool.key();
    let token_mint = pool.token_mint;
    let bump = pool.bump;

    let seeds = &[
        ShieldedPool::SEED_PREFIX,
        token_mint.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    if is_native_sol {
        // Native SOL: transfer lamports from pool PDA to recipient
        // Check pool has enough lamports
        let pool_lamports = pool.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(pool.to_account_info().data_len());

        require!(
            pool_lamports.saturating_sub(min_rent) >= amount,
            ZkShieldedError::InsufficientPoolBalance
        );

        // Transfer lamports using raw pointer manipulation (PDAs can't use SystemProgram CPI for outgoing transfers)
        **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;

        msg!("Transferred {} lamports (native SOL) from shielded pool", amount);
    } else {
        // SPL Token: transfer tokens from pool vault to recipient token account
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let recipient_token_account = ctx.accounts.recipient_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        // Validate token accounts
        require!(
            pool_vault.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            recipient_token_account.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: pool_vault.to_account_info(),
                to: recipient_token_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;

        msg!("Transferred {} SPL tokens from shielded pool", amount);
    }

    // Update pool state
    pool.update_root(merkle_tree.root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.total_shielded = pool
        .total_shielded
        .checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    msg!("Unshielded {} tokens to {}", amount, ctx.accounts.recipient.key());
    msg!("Nullifiers spent: 2");
    if let Some(idx) = leaf_index {
        msg!("Change commitment at index: {}", idx);
    }
    msg!("New Merkle root: {:?}", merkle_tree.root);

    // Emit event
    emit!(UnshieldEvent {
        pool: pool_key,
        recipient: ctx.accounts.recipient.key(),
        amount,
        nullifier_1,
        nullifier_2,
        change_commitment: output_commitment_1,
        change_leaf_index: leaf_index,
        new_root: merkle_tree.root,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Event emitted when tokens are unshielded
#[event]
pub struct UnshieldEvent {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nullifier_1: [u8; 32],
    pub nullifier_2: [u8; 32],
    pub change_commitment: [u8; 32],
    pub change_leaf_index: Option<u64>,
    pub new_root: [u8; 32],
    pub timestamp: i64,
}
