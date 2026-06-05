// === PoW & research — Groth16/SNARK path, removed from production (STARK-only flow). Re-enable requires a real ceremony + VK pinning. ===
// Sealed-bid auction escrow_shield: verifies a Groth16 escrow-bid proof inline.
// Commented out wholesale (handler + Accounts struct + event). Arcium auction
// flow is not part of the v3 production path.
/*
use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};
use crate::state::auction_escrow::AuctionEscrow;
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Lock a denominated pool note into escrow for a sealed-bid auction.
///
/// The old note is consumed (nullified) and both conditional commitments
/// are stored in the AuctionEscrow PDA. Neither commitment is inserted
/// into the Merkle tree yet — that happens at `escrow_release`.
///
/// Funds stay in the pool PDA throughout escrow.
///
/// Public inputs: [merkle_root, nullifier, min_epoch, token_mint, auction_id,
///                 pay_commitment, refund_commitment]
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    auction_id: [u8; 32],
    pay_commitment: [u8; 32],
    refund_commitment: [u8; 32]
)]
pub struct EscrowShield<'info> {
    /// Transaction submitter (bidder or relayer)
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

    /// Merkle tree state (read-only — no insertion during escrow)
    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// Nullifier record PDA — marks old note as spent
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

    /// Auction escrow PDA — stores both conditional commitments
    #[account(
        init,
        payer = payer,
        space = AuctionEscrow::LEN,
        seeds = [
            AuctionEscrow::SEED_PREFIX,
            auction_id.as_ref(),
            nullifier.as_ref()
        ],
        bump
    )]
    pub auction_escrow: Account<'info, AuctionEscrow>,

    /// Escrow circuit verification key data account
    /// CHECK: Validated by hash comparison + owner check
    #[account(
        constraint = verification_key_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub verification_key_data: AccountInfo<'info>,

    /// System program (required for PDA creation)
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<EscrowShield>,
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    auction_id: [u8; 32],
    pay_commitment: [u8; 32],
    refund_commitment: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;

    // Dynamic delay: update maturity tracking
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);

    // Enforce epoch delay (always enforced for escrow)
    let dynamic_delay = pool.get_dynamic_delay();
    let effective_min_epoch = min_epoch
        .checked_add(dynamic_delay)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    require!(
        current_epoch >= effective_min_epoch,
        ZkShieldedError::EpochDelayNotMet
    );

    // Initialize nullifier record (marks old note as spent)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // Load and validate escrow verification key
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == pool.vk_hash_escrow,
        ZkShieldedError::InvalidVerificationKey
    );

    // Verify the escrow bid ZK proof: 7 public inputs
    // [merkle_root, nullifier, min_epoch, token_mint, auction_id, pay_commitment, refund_commitment]
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();
    let is_valid = Groth16Verifier::verify_escrow_bid(
        &proof,
        &merkle_root,
        &nullifier,
        min_epoch,
        &token_mint_bytes,
        &auction_id,
        &pay_commitment,
        &refund_commitment,
        &vk_data,
    )?;

    require!(is_valid, ZkShieldedError::InvalidProof);

    // Initialize the auction escrow PDA
    let escrow = &mut ctx.accounts.auction_escrow;
    escrow.auction_id = auction_id;
    escrow.pool = pool.key();
    escrow.nullifier = nullifier;
    escrow.pay_commitment = pay_commitment;
    escrow.refund_commitment = refund_commitment;
    escrow.outcome = AuctionEscrow::OUTCOME_UNSETTLED;
    escrow.is_released = false;
    escrow.created_at = clock.unix_timestamp;
    escrow.bump = ctx.bumps.auction_escrow;

    // Old note consumed: decrement note_count and mature count
    // Funds stay in pool PDA (total_shielded unchanged)
    pool.note_count = pool.note_count.saturating_sub(1);
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);
    pool.last_tx_at = clock.unix_timestamp;

    emit!(EscrowShieldEvent {
        pool: pool.key(),
        auction_id,
        nullifier,
        pay_commitment,
        refund_commitment,
        current_epoch,
        dynamic_delay,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct EscrowShieldEvent {
    pub pool: Pubkey,
    pub auction_id: [u8; 32],
    pub nullifier: [u8; 32],
    pub pay_commitment: [u8; 32],
    pub refund_commitment: [u8; 32],
    pub current_epoch: u64,
    pub dynamic_delay: u64,
    pub timestamp: i64,
}
*/
// === end Groth16/SNARK removed block (escrow_shield) ===
