use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, NullifierRecord, ShieldedPool};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Transfer shielded tokens privately
/// Spends input notes (invalidated via nullifiers) and creates new output notes
/// Requires a valid ZK proof demonstrating:
/// 1. Input notes exist in the Merkle tree
/// 2. Sender owns the input notes (knows spending key)
/// 3. Nullifiers are correctly computed
/// 4. Output commitments are correctly computed
/// 5. Value is conserved (inputs = outputs for private transfer)
///
/// Uses PDA-per-nullifier for double-spend detection (replaces Bloom filter).
/// If a nullifier PDA already exists, `init` fails atomically — zero false positives.
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32],
    new_root: [u8; 32]
)]
pub struct Transfer<'info> {
    /// Transaction submitter (can be anyone, including relayer)
    #[account(mut)]
    pub payer: Signer<'info>,

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

    /// Nullifier 1 PDA — created on first use.
    /// If this PDA already exists, `init` fails → atomic double-spend rejection.
    #[account(
        init,
        payer = payer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            shielded_pool.key().as_ref(),
            nullifier_1.as_ref()
        ],
        bump
    )]
    pub nullifier_record_1: Account<'info, NullifierRecord>,

    /// Nullifier 2 PDA — created on first use.
    /// If this PDA already exists, `init` fails → atomic double-spend rejection.
    #[account(
        init,
        payer = payer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            shielded_pool.key().as_ref(),
            nullifier_2.as_ref()
        ],
        bump
    )]
    pub nullifier_record_2: Account<'info, NullifierRecord>,

    /// Verification key data account (stores the VK bytes)
    /// CHECK: This account stores the verification key and is validated by hash
    pub verification_key_data: AccountInfo<'info>,

    /// System program (required for PDA creation)
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Transfer>,
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32],
    new_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // Double-spend protection via PDA-per-nullifier.
    // The `init` constraints on nullifier_record_1 and nullifier_record_2 ensure
    // that if either nullifier was already spent, the transaction fails atomically.
    let nullifier_record_1 = &mut ctx.accounts.nullifier_record_1;
    nullifier_record_1.pool = pool.key();
    nullifier_record_1.bump = ctx.bumps.nullifier_record_1;

    let nullifier_record_2 = &mut ctx.accounts.nullifier_record_2;
    nullifier_record_2.pool = pool.key();
    nullifier_record_2.bump = ctx.bumps.nullifier_record_2;

    // Load verification key data
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;

    // Verify VK hash matches what's stored in pool
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == pool.vk_hash,
        ZkShieldedError::InvalidVerificationKey
    );

    // Verify the ZK proof
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();
    let is_valid = Groth16Verifier::verify_transfer(
        &proof,
        &merkle_root,
        &nullifier_1,
        &nullifier_2,
        &output_commitment_1,
        &output_commitment_2,
        0, // public_amount = 0 for private transfer
        &token_mint_bytes,
        &vk_data,
    )?;

    require!(is_valid, ZkShieldedError::InvalidProof);

    // Nullifiers already marked as spent via PDA creation above.

    // Insert new commitments into Merkle tree
    // NOTE: Using insert_with_root because Poseidon syscall is not yet enabled on devnet
    // First leaf uses insert_leaf_only (root is set by the second insertion)
    let leaf_index_1 = merkle_tree.insert_leaf_only(output_commitment_1)?;
    // Second insertion sets the actual new root computed by client
    let leaf_index_2 = merkle_tree.insert_with_root(output_commitment_2, new_root)?;

    // Update pool state with the client-computed root
    pool.update_root(new_root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.last_tx_at = clock.unix_timestamp;

    msg!("Private transfer completed");
    msg!("Nullifiers spent: 2");
    msg!("New commitments at indices: {}, {}", leaf_index_1, leaf_index_2);
    msg!("New Merkle root: {:?}", merkle_tree.root);

    // Emit event for indexing
    emit!(TransferEvent {
        pool: pool.key(),
        nullifier_1,
        nullifier_2,
        output_commitment_1,
        output_commitment_2,
        leaf_index_1,
        leaf_index_2,
        new_root: merkle_tree.root,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Event emitted on shielded transfer
#[event]
pub struct TransferEvent {
    pub pool: Pubkey,
    pub nullifier_1: [u8; 32],
    pub nullifier_2: [u8; 32],
    pub output_commitment_1: [u8; 32],
    pub output_commitment_2: [u8; 32],
    pub leaf_index_1: u64,
    pub leaf_index_2: u64,
    pub new_root: [u8; 32],
    pub timestamp: i64,
}
