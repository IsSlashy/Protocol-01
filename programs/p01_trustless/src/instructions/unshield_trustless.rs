use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::TrustlessError;
use crate::state::{MerkleTreeState, NullifierAccount, PoolState};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Unshield tokens from the trustless pool.
///
/// TRUST THE MATH, NOT THE NODES.
///
/// The Groth16 proof is the ONLY authorization required.
/// No signer check. No relayer. No admin key.
/// If the proof verifies, the withdrawal proceeds. Period.
///
/// Double-spend prevention: The `init` constraint on `nullifier_account`
/// will fail if the PDA already exists. This is atomic and cannot race.
///
/// Public inputs: [merkle_root, nullifier, min_epoch, token_mint, enforce_maturity=1]
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64
)]
pub struct UnshieldTrustless<'info> {
    /// Transaction submitter (anyone can submit -- enables gasless patterns)
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Recipient of the unshielded tokens
    /// CHECK: Any address can receive tokens. The proof authorizes the withdrawal.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// Pool state
    #[account(
        mut,
        seeds = [
            PoolState::SEED_PREFIX,
            pool.token_mint.as_ref(),
            &pool.denomination.to_le_bytes()
        ],
        bump = pool.bump,
        constraint = pool.is_active @ TrustlessError::PoolNotActive,
        constraint = pool.is_valid_root(&merkle_root) @ TrustlessError::InvalidMerkleRoot
    )]
    pub pool: Account<'info, PoolState>,

    /// Merkle tree state (read-only for unshield)
    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// Nullifier PDA -- created (init) on first use.
    /// If this PDA already exists, the `init` constraint fails with
    /// "already in use" -- PERMANENT double-spend rejection.
    /// This is THE core safety mechanism. On-chain. Immutable. Trustless.
    #[account(
        init,
        payer = payer,
        space = NullifierAccount::LEN,
        seeds = [
            NullifierAccount::SEED_PREFIX,
            pool.key().as_ref(),
            nullifier.as_ref()
        ],
        bump
    )]
    pub nullifier_account: Account<'info, NullifierAccount>,

    /// Verification key data account
    /// CHECK: Validated by hash comparison against pool.verification_key_hash
    pub verification_key_data: AccountInfo<'info>,

    /// System program (required for PDA creation + native SOL transfers)
    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// Pool's token vault (optional, only for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Recipient's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<UnshieldTrustless>,
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.pool;
    let amount = pool.denomination;

    let is_native_sol = pool.token_mint == system_program::ID;

    // --- Check pool has sufficient balance ---
    require!(
        pool.total_shielded >= amount,
        TrustlessError::InsufficientPoolBalance
    );

    // --- Dynamic delay: update maturity before computing delay ---
    let current_epoch = PoolState::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);

    let dynamic_delay = pool.get_dynamic_delay();
    let effective_min_epoch = min_epoch
        .checked_add(dynamic_delay)
        .unwrap_or(u64::MAX);
    require!(
        current_epoch >= effective_min_epoch,
        TrustlessError::EpochDelayNotMet
    );

    // --- Initialize the nullifier record (marks as spent -- PERMANENT) ---
    let nullifier_account = &mut ctx.accounts.nullifier_account;
    nullifier_account.nullifier = nullifier;
    nullifier_account.spent_at_slot = clock.slot;
    nullifier_account.bump = ctx.bumps.nullifier_account;

    // --- Load and validate verification key ---
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == pool.verification_key_hash,
        TrustlessError::InvalidVerificationKey
    );

    // --- Verify the ZK proof ---
    // 5 public inputs: [merkle_root, nullifier, min_epoch, token_mint, enforce_maturity=1]
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();
    let is_valid = Groth16Verifier::verify_unshield(
        &proof,
        &merkle_root,
        &nullifier,
        min_epoch,
        &token_mint_bytes,
        true, // enforce_maturity = 1 (always for trustless unshield)
        &vk_data,
    )?;

    require!(is_valid, TrustlessError::InvalidProof);

    // --- Transfer tokens ---
    let token_mint = pool.token_mint;
    let denomination_bytes = pool.denomination.to_le_bytes();
    let bump = pool.bump;
    let seeds = &[
        PoolState::SEED_PREFIX,
        token_mint.as_ref(),
        denomination_bytes.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    if is_native_sol {
        // Native SOL: transfer denomination lamports from pool PDA to recipient
        let pool_lamports = pool.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(pool.to_account_info().data_len());

        require!(
            pool_lamports.saturating_sub(min_rent) >= amount,
            TrustlessError::InsufficientPoolBalance
        );

        // Direct lamport transfer from pool PDA to recipient
        **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;
    } else {
        // SPL Token: transfer from pool vault to recipient token account
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(TrustlessError::MissingTokenProgram)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(TrustlessError::MissingPoolVault)?;
        let recipient_token_account = ctx.accounts.recipient_token_account
            .as_ref()
            .ok_or(TrustlessError::MissingTokenAccount)?;

        require!(
            pool_vault.mint == pool.token_mint,
            TrustlessError::InvalidTokenMint
        );
        require!(
            recipient_token_account.mint == pool.token_mint,
            TrustlessError::InvalidTokenMint
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
    }

    // --- Update pool state ---
    pool.total_shielded = pool
        .total_shielded
        .checked_sub(amount)
        .ok_or(TrustlessError::ArithmeticOverflow)?;
    pool.note_count = pool
        .note_count
        .checked_sub(1)
        .ok_or(TrustlessError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    // The withdrawn note was mature, so decrement
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);

    emit!(UnshieldTrustlessEvent {
        pool: pool.key(),
        recipient: ctx.accounts.recipient.key(),
        denomination: amount,
        nullifier,
        min_epoch,
        current_epoch,
        dynamic_delay,
        spent_at_slot: clock.slot,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct UnshieldTrustlessEvent {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub denomination: u64,
    pub nullifier: [u8; 32],
    pub min_epoch: u64,
    pub current_epoch: u64,
    pub dynamic_delay: u64,
    pub spent_at_slot: u64,
    pub timestamp: i64,
}
