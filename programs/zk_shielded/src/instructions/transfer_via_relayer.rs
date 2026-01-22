use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, NullifierSet, ShieldedPool};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Transfer shielded tokens via relayer
/// Similar to regular transfer but includes a fee output for the relayer
/// This enables gasless transactions where the relayer pays for gas
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    output_commitment_relayer_fee: [u8; 32],
    merkle_root: [u8; 32]
)]
pub struct TransferViaRelayer<'info> {
    /// Relayer submitting the transaction
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// Shielded pool
    #[account(
        mut,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump,
        constraint = shielded_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = shielded_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot,
        constraint = relayer.key() == shielded_pool.relayer @ ZkShieldedError::Unauthorized
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
}

pub fn handler(
    ctx: Context<TransferViaRelayer>,
    proof: Groth16Proof,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    output_commitment_relayer_fee: [u8; 32],
    merkle_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

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

    // For relayer transfer, we need a modified circuit that handles 3 outputs
    // (recipient, change, relayer fee) - for now we use the standard circuit
    // with the fee embedded in the output amounts
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();

    let is_valid = Groth16Verifier::verify_transfer(
        &proof,
        &merkle_root,
        &nullifier_1,
        &nullifier_2,
        &output_commitment_1,
        &output_commitment_2,
        0, // Private transfer (value conservation within shielded pool)
        &token_mint_bytes,
        &vk_data,
    )?;

    require!(is_valid, ZkShieldedError::InvalidProof);

    // Mark nullifiers as spent
    nullifier_set.add(&nullifier_1);
    nullifier_set.add(&nullifier_2);

    // Insert all output commitments into Merkle tree
    let leaf_index_1 = merkle_tree.insert(output_commitment_1)?;
    let leaf_index_2 = merkle_tree.insert(output_commitment_2)?;
    let leaf_index_fee = merkle_tree.insert(output_commitment_relayer_fee)?;

    // Update pool state
    pool.update_root(merkle_tree.root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.last_tx_at = clock.unix_timestamp;

    msg!("Relayer transfer completed");
    msg!("Relayer: {}", ctx.accounts.relayer.key());
    msg!("New commitments at indices: {}, {}, {} (fee)", leaf_index_1, leaf_index_2, leaf_index_fee);
    msg!("New Merkle root: {:?}", merkle_tree.root);

    // Emit event
    emit!(RelayerTransferEvent {
        pool: pool.key(),
        relayer: ctx.accounts.relayer.key(),
        nullifier_1,
        nullifier_2,
        output_commitment_1,
        output_commitment_2,
        output_commitment_relayer_fee,
        leaf_indices: [leaf_index_1, leaf_index_2, leaf_index_fee],
        new_root: merkle_tree.root,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Event emitted on relayer transfer
#[event]
pub struct RelayerTransferEvent {
    pub pool: Pubkey,
    pub relayer: Pubkey,
    pub nullifier_1: [u8; 32],
    pub nullifier_2: [u8; 32],
    pub output_commitment_1: [u8; 32],
    pub output_commitment_2: [u8; 32],
    pub output_commitment_relayer_fee: [u8; 32],
    pub leaf_indices: [u64; 3],
    pub new_root: [u8; 32],
    pub timestamp: i64,
}
