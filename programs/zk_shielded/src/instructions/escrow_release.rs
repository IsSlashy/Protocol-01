use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState};
use crate::state::auction_escrow::AuctionEscrow;

/// Release an auction escrow: insert the correct commitment into the Merkle tree.
///
/// After the Arcium MPC settles the auction and `write_escrow_outcome` sets the
/// outcome on the AuctionEscrow PDA, anyone can crank this permissionless
/// instruction to finalize the escrow:
///   - outcome == 1 (PAY):    inserts pay_commitment (seller gets the note)
///   - outcome == 2 (REFUND): inserts refund_commitment (bidder gets refund)
///
/// The other commitment is permanently discarded — it can never be spent.
#[derive(Accounts)]
#[instruction(new_root: [u8; 32])]
pub struct EscrowRelease<'info> {
    /// Anyone can crank (permissionless)
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
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    /// Merkle tree state (mutable — commitment is inserted)
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// Auction escrow PDA
    #[account(
        mut,
        seeds = [
            AuctionEscrow::SEED_PREFIX,
            auction_escrow.auction_id.as_ref(),
            auction_escrow.nullifier.as_ref()
        ],
        bump = auction_escrow.bump,
        constraint = auction_escrow.pool == denominated_pool.key() @ ZkShieldedError::InvalidAuctionId,
        constraint = !auction_escrow.is_released @ ZkShieldedError::EscrowAlreadyReleased,
        constraint = auction_escrow.outcome != AuctionEscrow::OUTCOME_UNSETTLED @ ZkShieldedError::EscrowOutcomeNotSet
    )]
    pub auction_escrow: Account<'info, AuctionEscrow>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<EscrowRelease>,
    new_root: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let escrow = &mut ctx.accounts.auction_escrow;

    // Select the correct commitment based on outcome
    let commitment = match escrow.outcome {
        AuctionEscrow::OUTCOME_PAY => escrow.pay_commitment,
        AuctionEscrow::OUTCOME_REFUND => escrow.refund_commitment,
        _ => return Err(ZkShieldedError::EscrowOutcomeNotSet.into()),
    };

    // Insert the selected commitment into the Merkle tree
    let leaf_index = merkle_tree.insert_with_root(commitment, new_root)?;

    // Update pool state
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_root(new_root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.note_count = pool.note_count.checked_add(1).unwrap();
    pool.record_deposit(current_epoch);
    pool.last_tx_at = clock.unix_timestamp;

    // Mark escrow as released
    escrow.is_released = true;

    emit!(EscrowReleaseEvent {
        pool: pool.key(),
        auction_id: escrow.auction_id,
        nullifier: escrow.nullifier,
        outcome: escrow.outcome,
        commitment,
        leaf_index,
        new_root,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct EscrowReleaseEvent {
    pub pool: Pubkey,
    pub auction_id: [u8; 32],
    pub nullifier: [u8; 32],
    pub outcome: u8,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub new_root: [u8; 32],
    pub timestamp: i64,
}
