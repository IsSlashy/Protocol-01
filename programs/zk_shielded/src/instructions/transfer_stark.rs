use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::stark_buffer::{
    parse_stark_proof_buffer, StarkProofBufferView, STARK_VERIFIER_PROGRAM_ID,
};
use crate::state::{MerkleTreeState, NullifierRecord, ShieldedPool};

/// Transfer shielded tokens privately using a STARK circuit 5 (transfer) proof.
///
/// Spends two input notes (nullifier_1, nullifier_2) and creates two output
/// commitments. Circuit 5 proves:
///   - Both nullifiers derive from the claimed spent notes.
///   - Output commitments are correctly formed.
///   - Value is conserved (public_amount = 0 for private transfer).
///   - All commitments + nullifiers bind to the pool's token_mint.
///
/// Public inputs (u64 LE, bound by sha256):
///   [0] nullifier_1 (u64 truncation of [u8; 32])
///   [1] nullifier_2
///   [2] output_commitment_1
///   [3] output_commitment_2
///   [4] public_amount (0 for private transfer)
///   [5] token_mint (u64 truncation of pool.token_mint)
#[derive(Accounts)]
#[instruction(
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32],
    new_root: [u8; 32]
)]
pub struct TransferStark<'info> {
    /// Transaction payer — must be the STARK proof authority.
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

    /// STARK proof buffer from p01_stark_verifier (circuit 5: transfer).
    /// CHECK: Validated by the handler.
    pub stark_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<TransferStark>,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    _merkle_root: [u8; 32],
    new_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // Double-spend protection via PDA-per-nullifier (init constraints above).
    let nullifier_record_1 = &mut ctx.accounts.nullifier_record_1;
    nullifier_record_1.pool = pool.key();
    nullifier_record_1.bump = ctx.bumps.nullifier_record_1;

    let nullifier_record_2 = &mut ctx.accounts.nullifier_record_2;
    nullifier_record_2.pool = pool.key();
    nullifier_record_2.bump = ctx.bumps.nullifier_record_2;

    // Nullifier canonicalization: each PDA is seeded on the full 32-byte
    // nullifier, but the proof only binds the low 8 bytes. Reject any
    // non-canonical nullifier whose high 24 bytes are non-zero, else a single
    // proof could be spent under multiple distinct nullifier PDAs (double-spend).
    require!(nullifier_1[8..] == [0u8; 24], ZkShieldedError::InvalidProof);
    require!(nullifier_2[8..] == [0u8; 24], ZkShieldedError::InvalidProof);

    // -----------------------------------------------------------------------
    // STARK proof verification (circuit 5: transfer)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let StarkProofBufferView {
        authority,
        circuit_id,
        verified,
        deep_ali_verified,
        public_inputs_hash: stored_inputs_hash,
    } = parse_stark_proof_buffer(&proof_data)?;

    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(circuit_id == 5, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);
    require!(deep_ali_verified, ZkShieldedError::InvalidProof);

    // Reconstruct the public-inputs hash the verifier stored.
    // Circuit 5 pub inputs: [nullifier_1, nullifier_2, out_commit_1, out_commit_2,
    //                       public_amount, token_mint] — all u64 LE.
    // On-chain [u8; 32] nullifiers/commitments pack their Goldilocks u64 in bytes 0..8.
    {
        let n1 = u64::from_le_bytes(nullifier_1[..8].try_into().unwrap());
        let n2 = u64::from_le_bytes(nullifier_2[..8].try_into().unwrap());
        let oc1 = u64::from_le_bytes(output_commitment_1[..8].try_into().unwrap());
        let oc2 = u64::from_le_bytes(output_commitment_2[..8].try_into().unwrap());
        let public_amount: u64 = 0; // private transfer: no net flow
        let token_mint_bytes = pool.token_mint.to_bytes();
        let tm = u64::from_le_bytes(token_mint_bytes[..8].try_into().unwrap());

        let mut pub_buf = [0u8; 48]; // 6 × 8
        pub_buf[0..8].copy_from_slice(&n1.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&n2.to_le_bytes());
        pub_buf[16..24].copy_from_slice(&oc1.to_le_bytes());
        pub_buf[24..32].copy_from_slice(&oc2.to_le_bytes());
        pub_buf[32..40].copy_from_slice(&public_amount.to_le_bytes());
        pub_buf[40..48].copy_from_slice(&tm.to_le_bytes());

        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // Insert new commitments into Merkle tree (client-computed new_root).
    let leaf_index_1 = merkle_tree.insert_leaf_only(output_commitment_1)?;
    let leaf_index_2 = merkle_tree.insert_with_root(output_commitment_2, new_root)?;

    pool.update_root(new_root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.last_tx_at = clock.unix_timestamp;

    emit!(TransferStarkEvent {
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

#[event]
pub struct TransferStarkEvent {
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
