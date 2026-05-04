use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::NullifierRecord;
use crate::state::pool_v3::DenominatedPoolV3;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;

/// STARK Proof Buffer account discriminator (from p01_stark_verifier).
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
///       + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_DEEP_ALI: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

/// Parse a verified STARK proof buffer.
/// Returns (authority, circuit_id, verified, deep_ali_verified, public_inputs_hash).
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID]).unwrap();
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_INPUTS_HASH + 32]);
    Ok((authority, circuit_id, verified, deep_ali_verified, public_inputs_hash))
}

/// V3 transfer of a note within a denominated pool.
///
/// Mirrors v2's `transfer_denominated_stark` with three STARK proof buffers
/// instead of one — the same pattern the V3 design uses to close the v2 trust
/// gap (membership was never proven on-chain).
///
///   * `c1_proof_buffer` — pool_commitment. Proves the caller knows the
///     `(secret, nullifier_preimage)` for the OLD note's `(nullifier,
///     commitment)`. Same as v2.
///   * `c3_proof_buffer` — merkle_path. Proves the OLD commitment is at
///     `merkle_root` (which must be in `pool.historical_roots`). NEW in V3 —
///     v2 only checked `is_valid_root` on the supplied root, never that the
///     commitment was actually at it.
///   * `c6_proof_buffer` — merkle_update. Proves `(current_root, new_root,
///     new_commitment, new_subtrees)` is a valid insertion. Same as `shield_v3`.
///
/// On-chain checks tie all three proofs together:
///   - `c1.public_inputs.commitment == c3.public_inputs.leaf` (same `stark_commitment`).
///   - `c3.public_inputs.root` is in `pool.historical_roots` (via `is_valid_root`).
///   - `c6.public_inputs.{old_root, new_leaf, new_root}` matches the on-chain
///     `(merkle_tree.root, new_commitment, new_root)`.
///
/// Funds do not move (same pool, same denomination). Only the merkle tree
/// state and pool bookkeeping change. Universal `LeafInserted` is emitted by
/// `insert_with_root_v3`.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    new_commitment: [u8; 32],
    new_root: [u8; 32],
    new_subtrees: Vec<[u8; 32]>
)]
pub struct TransferDenominatedStarkV3<'info> {
    /// Transaction submitter — must be the note owner (signs to bind new_commitment).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Denominated pool V3
    #[account(
        mut,
        seeds = [
            DenominatedPoolV3::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = denominated_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
    )]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    /// Merkle tree V3 state (mutable — new commitment is inserted)
    #[account(
        mut,
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeStateV3>,

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

    /// C1 (pool_commitment) STARK proof buffer.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=1,
    /// verified, public_inputs_hash matches `(nullifier, stark_commitment)`).
    pub c1_proof_buffer: AccountInfo<'info>,

    /// C3 (merkle_path) STARK proof buffer — proves OLD commitment is at
    /// `merkle_root`. NEW in V3.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=3,
    /// verified, public_inputs_hash matches `(stark_commitment, merkle_root)`).
    pub c3_proof_buffer: AccountInfo<'info>,

    /// C6 (merkle_update) STARK proof buffer — proves NEW commitment insertion.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=6,
    /// verified, deep_ali_verified, public_inputs_hash matches
    /// `(0, new_commitment, current_root, new_root, depth)`).
    pub c6_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<TransferDenominatedStarkV3>,
    nullifier: [u8; 32],
    _merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    new_commitment: [u8; 32],
    new_root: [u8; 32],
    new_subtrees: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let payer_key = ctx.accounts.payer.key();

    // Dynamic delay: update maturity tracking
    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);
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

    // Initialize the nullifier record (marks the OLD note as spent)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // C1 (pool_commitment) verification — proves ownership of OLD note.
    // public_inputs = [nullifier_u64, commitment_u64], hashed as
    // sha256(nullifier_le || commitment_le) = 16 bytes (matches verifier).
    // -----------------------------------------------------------------------
    {
        let c1_info = &ctx.accounts.c1_proof_buffer;
        require!(
            *c1_info.owner == STARK_VERIFIER_PROGRAM_ID,
            ZkShieldedError::InvalidProof
        );
        let c1_data = c1_info.try_borrow_data()?;
        let (c1_authority, c1_circuit_id, c1_verified, _c1_deep, c1_inputs_hash) =
            parse_stark_proof_buffer(&c1_data)?;

        require!(c1_authority == payer_key, ZkShieldedError::InvalidProof);
        require!(c1_circuit_id == 1, ZkShieldedError::InvalidProof);
        require!(c1_verified, ZkShieldedError::InvalidProof);

        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(c1_inputs_hash == expected, ZkShieldedError::InvalidProof);
    }

    // -----------------------------------------------------------------------
    // C3 (merkle_path) verification — proves OLD commitment is at merkle_root.
    // public_inputs = [leaf_u64, root_u64], hashed as 16 bytes.
    // The `is_valid_root(&merkle_root)` constraint above already ties
    // merkle_root to the pool ring; this check ties it to the C3 proof.
    // -----------------------------------------------------------------------
    {
        let c3_info = &ctx.accounts.c3_proof_buffer;
        require!(
            *c3_info.owner == STARK_VERIFIER_PROGRAM_ID,
            ZkShieldedError::InvalidProof
        );
        let c3_data = c3_info.try_borrow_data()?;
        let (c3_authority, c3_circuit_id, c3_verified, _c3_deep, c3_inputs_hash) =
            parse_stark_proof_buffer(&c3_data)?;

        require!(c3_authority == payer_key, ZkShieldedError::InvalidProof);
        require!(c3_circuit_id == 3, ZkShieldedError::InvalidProof);
        require!(c3_verified, ZkShieldedError::InvalidProof);

        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&stark_commitment.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&_merkle_root[..8]);
        let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(c3_inputs_hash == expected, ZkShieldedError::InvalidProof);
    }

    // -----------------------------------------------------------------------
    // C6 (merkle_update) verification — proves new_commitment + new_root +
    // new_subtrees is a valid insertion from the CURRENT pool root.
    // public_inputs = [old_leaf=0, new_leaf, old_root, new_root, depth] — 5 u64s,
    // hashed as 40 bytes (matches `shield_denominated_v3::verify_c6_proof_buffer`).
    // Both phase 1 (FRI) AND phase 2 (DEEP-ALI) must be verified for C6.
    // -----------------------------------------------------------------------
    {
        let c6_info = &ctx.accounts.c6_proof_buffer;
        require!(
            *c6_info.owner == STARK_VERIFIER_PROGRAM_ID,
            ZkShieldedError::InvalidProof
        );
        let c6_data = c6_info.try_borrow_data()?;
        let (c6_authority, c6_circuit_id, c6_verified, c6_deep_ali, c6_inputs_hash) =
            parse_stark_proof_buffer(&c6_data)?;

        require!(c6_authority == payer_key, ZkShieldedError::InvalidProof);
        require!(c6_circuit_id == 6, ZkShieldedError::InvalidProof);
        require!(c6_verified, ZkShieldedError::InvalidProof);
        require!(c6_deep_ali, ZkShieldedError::InvalidProof);

        let old_leaf_u64: u64 = 0; // insertion ⇒ replacing ZEROS[0]
        let new_leaf_u64 = u64::from_le_bytes(new_commitment[..8].try_into().unwrap());
        let old_root_u64 = u64::from_le_bytes(merkle_tree.root[..8].try_into().unwrap());
        let new_root_u64 = u64::from_le_bytes(new_root[..8].try_into().unwrap());
        let depth_u64 = merkle_tree.depth as u64;

        let mut pub_buf = [0u8; 40];
        pub_buf[0..8].copy_from_slice(&old_leaf_u64.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&new_leaf_u64.to_le_bytes());
        pub_buf[16..24].copy_from_slice(&old_root_u64.to_le_bytes());
        pub_buf[24..32].copy_from_slice(&new_root_u64.to_le_bytes());
        pub_buf[32..40].copy_from_slice(&depth_u64.to_le_bytes());
        let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(c6_inputs_hash == expected, ZkShieldedError::InvalidProof);
    }

    // -----------------------------------------------------------------------
    // Insert new commitment into the V3 Merkle tree (emits LeafInserted)
    // -----------------------------------------------------------------------
    let leaf_index = merkle_tree.insert_with_root_v3(
        new_commitment,
        new_root,
        &new_subtrees,
        true, // c6_verified — see C6 block above
    )?;

    // Update pool root and leaf index (pushes old root onto historical ring)
    pool.update_root(new_root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.last_tx_at = clock.unix_timestamp;

    // Note count stays the same: one consumed, one created.
    // total_shielded stays the same: no funds move.
    // Decrement mature (old note was mature) and record new deposit.
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);
    pool.record_deposit(current_epoch);

    emit!(TransferDenominatedStarkV3Event {
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
pub struct TransferDenominatedStarkV3Event {
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
