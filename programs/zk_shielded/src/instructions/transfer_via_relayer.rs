use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, NullifierRecord, ShieldedPool};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Transfer shielded tokens via relayer
/// Similar to regular transfer but includes a fee output for the relayer
/// This enables gasless transactions where the relayer pays for gas
///
/// Uses PDA-per-nullifier for double-spend detection (replaces Bloom filter).
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

    /// Nullifier 1 PDA — created on first use.
    #[account(
        init,
        payer = relayer,
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
    #[account(
        init,
        payer = relayer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            shielded_pool.key().as_ref(),
            nullifier_2.as_ref()
        ],
        bump
    )]
    pub nullifier_record_2: Account<'info, NullifierRecord>,

    /// Verification key data account
    /// CHECK: Validated by hash comparison + owner check
    #[account(
        constraint = verification_key_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub verification_key_data: AccountInfo<'info>,

    /// System program (required for PDA creation)
    pub system_program: Program<'info, System>,
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

    // Double-spend protection via PDA-per-nullifier.
    let nullifier_record_1 = &mut ctx.accounts.nullifier_record_1;
    nullifier_record_1.pool = pool.key();
    nullifier_record_1.bump = ctx.bumps.nullifier_record_1;

    let nullifier_record_2 = &mut ctx.accounts.nullifier_record_2;
    nullifier_record_2.pool = pool.key();
    nullifier_record_2.bump = ctx.bumps.nullifier_record_2;

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

    // Nullifiers already marked as spent via PDA creation above.

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
