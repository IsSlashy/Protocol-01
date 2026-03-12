use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Transfer a note within a denominated pool to a new owner.
///
/// The old note is nullified (consuming it) and a new commitment is
/// inserted into the Merkle tree. No funds move — same pool, same denomination.
///
/// This enables peer-to-peer note sharing: the sender generates a proof,
/// the program nullifies the old note and inserts the new commitment.
/// The recipient can later unshield using knowledge of the new note secrets.
///
/// Public inputs: [merkle_root, nullifier, min_epoch, token_mint, new_commitment]
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    new_commitment: [u8; 32],
    new_root: [u8; 32]
)]
pub struct TransferDenominated<'info> {
    /// Transaction submitter (sender or relayer)
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Denominated pool
    #[account(
        mut,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = denominated_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    /// Merkle tree state (mutable — new commitment is inserted)
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// Nullifier record PDA — created (init) on first use.
    /// Prevents double-spend of the old note.
    #[account(
        init,
        payer = payer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            denominated_pool.key().as_ref(),
            nullifier.as_ref()
        ],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    /// Transfer verification key data account
    /// CHECK: Validated by hash comparison + owner check
    #[account(
        constraint = verification_key_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub verification_key_data: AccountInfo<'info>,

    /// System program (required for PDA creation)
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<TransferDenominated>,
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    new_commitment: [u8; 32],
    new_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // Dynamic delay: update maturity tracking
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);

    // Enforce epoch delay for transfers (always)
    let dynamic_delay = pool.get_dynamic_delay();
    let effective_min_epoch = min_epoch
        .checked_add(dynamic_delay)
        .unwrap_or(u64::MAX);
    require!(
        current_epoch >= effective_min_epoch,
        ZkShieldedError::EpochDelayNotMet
    );

    // Initialize the nullifier record (marks the old note as spent)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // Load and validate transfer verification key
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == pool.vk_hash_transfer,
        ZkShieldedError::InvalidVerificationKey
    );

    // Verify the transfer ZK proof: 5 public inputs
    // [merkle_root, nullifier, min_epoch, token_mint, new_commitment]
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();
    let is_valid = Groth16Verifier::verify_denominated_transfer(
        &proof,
        &merkle_root,
        &nullifier,
        min_epoch,
        &token_mint_bytes,
        &new_commitment,
        &vk_data,
    )?;

    require!(is_valid, ZkShieldedError::InvalidProof);

    // Insert new commitment into the Merkle tree
    let leaf_index = merkle_tree.insert_with_root(new_commitment, new_root)?;

    // Update pool root and leaf index
    pool.update_root(new_root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.last_tx_at = clock.unix_timestamp;

    // Note count stays the same: one note consumed, one note created.
    // total_shielded stays the same: no funds move.
    // Decrement mature (old note was mature) and record new deposit.
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);
    pool.record_deposit(current_epoch);

    emit!(TransferDenominatedEvent {
        pool: pool.key(),
        nullifier,
        new_commitment,
        leaf_index,
        new_root,
        min_epoch,
        current_epoch,
        dynamic_delay,
        mature_note_count: pool.mature_note_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct TransferDenominatedEvent {
    pub pool: Pubkey,
    pub nullifier: [u8; 32],
    pub new_commitment: [u8; 32],
    pub leaf_index: u64,
    pub new_root: [u8; 32],
    pub min_epoch: u64,
    pub current_epoch: u64,
    pub dynamic_delay: u64,
    pub mature_note_count: u64,
    pub timestamp: i64,
}
