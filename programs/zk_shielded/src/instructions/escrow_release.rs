use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::pool::SLOTS_PER_EPOCH;
use crate::state::{DenominatedPool, MerkleTreeState};
use crate::state::auction_escrow::AuctionEscrow;

/// Minimum wall-clock seconds per Solana slot. We use 2/5 = 0.4s as the cluster
/// long-term average. This is a conservative lower bound for wall-clock elapsed
/// time per slot — a real release must wait at least
/// `pool.epoch_delay * SLOTS_PER_EPOCH * (SLOT_MS_NUMERATOR / SLOT_MS_DENOMINATOR)`
/// seconds since escrow creation, which matches the maturity semantics already
/// enforced on shield/unshield via `pool.epoch_delay`.
const SLOT_MS_NUMERATOR: u64 = 2;
const SLOT_MS_DENOMINATOR: u64 = 5;

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

    // Audit 2026-04-01 HIGH #1: Maturity check between escrow creation and release.
    //
    // Without this gate, a bidder could escrow a note in slot N, have the MPC
    // settle in slot N+5, and crank `escrow_release` immediately — making the
    // released commitment's anonymity-set timing identical to the source note's
    // last-seen slot. By enforcing the same `epoch_delay` the pool requires for
    // a normal unshield, the released note sits dormant for at least one epoch
    // window, blending into the pool's regular deposit/withdraw cadence.
    //
    // We use `escrow.created_at` (unix timestamp set in `escrow_shield`) rather
    // than adding a new slot field to AuctionEscrow, so this fix requires no
    // PDA struct migration. The slot-time conversion uses a conservative 0.4s
    // floor (2/5), which means the real elapsed time is always >= the nominal
    // epoch delay — the safe direction.
    let min_delay_slots = pool
        .epoch_delay
        .checked_mul(SLOTS_PER_EPOCH)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let min_delay_seconds = min_delay_slots
        .checked_mul(SLOT_MS_NUMERATOR)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?
        / SLOT_MS_DENOMINATOR;
    let elapsed = clock
        .unix_timestamp
        .saturating_sub(escrow.created_at);
    require!(
        elapsed >= 0 && (elapsed as u64) >= min_delay_seconds,
        ZkShieldedError::EpochDelayNotMet
    );

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
