use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};

/// STARK Proof Buffer account layout (from p01_stark_verifier).
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_MIN_LEN: usize = 82;

fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID]).unwrap();
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
}

/// Transfer a note within a denominated pool using STARK proof verification.
///
/// The old note is nullified (consuming it) and a new commitment is
/// inserted into the Merkle tree. No funds move — same pool, same denomination.
///
/// This enables peer-to-peer note sharing: the sender generates a STARK proof
/// for the OLD note (circuit 1: pool_commitment), the program nullifies the
/// old note and inserts the new commitment. The recipient can later unshield
/// using knowledge of the new note secrets.
///
/// The `new_commitment` is not bound to the STARK proof itself — instead,
/// it is authenticated by the payer's signature on the transaction data.
/// Because `payer: Signer` must sign the whole instruction, the new_commitment
/// cannot be modified by a relayer or intermediary.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    new_commitment: [u8; 32],
    new_root: [u8; 32]
)]
pub struct TransferDenominatedStark<'info> {
    /// Transaction submitter — must be the note owner (signs to bind new_commitment).
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

    /// STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).
    /// CHECK: Validated manually by reading account data:
    /// - Owner is p01_stark_verifier program
    /// - Discriminator matches ProofBuffer
    /// - Authority matches payer
    /// - Circuit ID is 1 (pool_commitment)
    /// - Verified flag is true
    /// - Public inputs hash matches sha256([nullifier_u64_le || stark_commitment_u64_le])
    pub stark_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<TransferDenominatedStark>,
    nullifier: [u8; 32],
    _merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
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

    // -----------------------------------------------------------------------
    // STARK proof verification (circuit 1: pool_commitment)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash) =
        parse_stark_proof_buffer(&proof_data)?;

    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(circuit_id == 1, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);

    // Verify the proof binds to THIS nullifier + stark_commitment.
    // For pool_commitment (circuit 1), public inputs = [nullifier_u64, commitment_u64].
    // The on-chain nullifier [u8; 32] stores the Goldilocks u64 in bytes 0..8.
    {
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // -----------------------------------------------------------------------
    // Insert new commitment into the Merkle tree
    // -----------------------------------------------------------------------
    let leaf_index = merkle_tree.insert_with_root(new_commitment, new_root)?;

    // Update pool root and leaf index
    pool.update_root(new_root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.last_tx_at = clock.unix_timestamp;

    // Note count stays the same: one consumed, one created.
    // total_shielded stays the same: no funds move.
    // Decrement mature (old note was mature) and record new deposit.
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);
    pool.record_deposit(current_epoch);

    emit!(TransferDenominatedStarkEvent {
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
pub struct TransferDenominatedStarkEvent {
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
