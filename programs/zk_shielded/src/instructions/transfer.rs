use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, NullifierSet, ShieldedPool};
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
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32]
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

    /// Verification key data account (stores the VK bytes)
    /// CHECK: This account stores the verification key and is validated by hash
    pub verification_key_data: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<Transfer>,
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // Load nullifier set (zero-copy)
    let mut nullifier_set = ctx.accounts.nullifier_set.load_mut()?;

    // Check nullifiers haven't been spent (Bloom filter check)
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

    // Mark nullifiers as spent
    nullifier_set.add(&nullifier_1);
    nullifier_set.add(&nullifier_2);

    // Insert new commitments into Merkle tree
    let leaf_index_1 = merkle_tree.insert(output_commitment_1)?;
    let leaf_index_2 = merkle_tree.insert(output_commitment_2)?;

    // Update pool state
    pool.update_root(merkle_tree.root);
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
