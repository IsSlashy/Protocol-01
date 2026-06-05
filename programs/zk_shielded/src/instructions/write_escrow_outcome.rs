// === PoW & research — Groth16/SNARK path, removed from production (STARK-only flow). Re-enable requires a real ceremony + VK pinning. ===
// Sealed-bid auction write_escrow_outcome: part of the Arcium auction escrow
// cohort (paired with escrow_shield / escrow_release). Commented out wholesale
// (handler + Accounts struct + event). Not part of the v3 production path.
/*
use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::auction_escrow::AuctionEscrow;

/// Write the auction outcome to an escrow PDA.
///
/// After the Arcium MPC settles the auction and the `settle_auction_callback`
/// writes the winner's nullifier to the Auction PDA on p01_arcium, this
/// instruction reads the Auction account cross-program and determines
/// whether this escrow's bidder won or lost:
///   - If escrow.nullifier == auction.winner_nullifier → OUTCOME_PAY
///   - Otherwise → OUTCOME_REFUND
///
/// This is permissionless: anyone can crank it once the Auction PDA is finalized.
/// The Auction PDA from p01_arcium is passed as an AccountInfo and validated
/// by checking its owner == p01_arcium program ID.
#[derive(Accounts)]
pub struct WriteEscrowOutcome<'info> {
    /// Anyone can crank (permissionless)
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Auction escrow PDA (mutable — outcome is written)
    #[account(
        mut,
        seeds = [
            AuctionEscrow::SEED_PREFIX,
            auction_escrow.auction_id.as_ref(),
            auction_escrow.nullifier.as_ref()
        ],
        bump = auction_escrow.bump,
        constraint = auction_escrow.outcome == AuctionEscrow::OUTCOME_UNSETTLED @ ZkShieldedError::EscrowAlreadySettled,
    )]
    pub auction_escrow: Account<'info, AuctionEscrow>,

    /// The Auction PDA from p01_arcium program.
    /// CHECK: Validated by owner check and data parsing below.
    pub auction_account: AccountInfo<'info>,
}

/// Expected p01_arcium program ID
const P01_ARCIUM_PROGRAM_ID: &str = "FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT";

pub fn handler(ctx: Context<WriteEscrowOutcome>) -> Result<()> {
    let escrow = &mut ctx.accounts.auction_escrow;
    let auction_info = &ctx.accounts.auction_account;

    // Validate the Auction account is owned by p01_arcium
    let expected_program_id = P01_ARCIUM_PROGRAM_ID
        .parse::<Pubkey>()
        .map_err(|_| ZkShieldedError::InvalidAuctionId)?;
    require!(
        *auction_info.owner == expected_program_id,
        ZkShieldedError::InvalidAuctionId
    );

    // Parse the Auction PDA data:
    // Layout: 8 (discriminator) + 32 (authority) + 32 (auction_id) + 32 (pool)
    //       + 8 (deadline) + 1 (finalized) + 32 (winner_nullifier) + 8 (winning_bid)
    //       + 8 (total_bids) + 1 (bump)
    let auction_data = auction_info.try_borrow_data()?;
    require!(
        auction_data.len() >= 8 + 32 + 32 + 32 + 8 + 1 + 32 + 8 + 8 + 1,
        ZkShieldedError::InvalidAuctionId
    );

    // Parse auction_id (bytes 40..72) and verify it matches
    let auction_id: [u8; 32] = auction_data[40..72]
        .try_into()
        .map_err(|_| ZkShieldedError::InvalidAuctionId)?;
    require!(
        auction_id == escrow.auction_id,
        ZkShieldedError::InvalidAuctionId
    );

    // Parse finalized flag (byte 112)
    let finalized = auction_data[112] == 1;
    require!(finalized, ZkShieldedError::AuctionNotFinalized);

    // Parse winner_nullifier (bytes 113..145)
    let winner_nullifier: [u8; 32] = auction_data[113..145]
        .try_into()
        .map_err(|_| ZkShieldedError::InvalidAuctionId)?;

    // Determine outcome
    if escrow.nullifier == winner_nullifier {
        escrow.outcome = AuctionEscrow::OUTCOME_PAY;
    } else {
        escrow.outcome = AuctionEscrow::OUTCOME_REFUND;
    }

    emit!(EscrowOutcomeEvent {
        auction_id: escrow.auction_id,
        nullifier: escrow.nullifier,
        outcome: escrow.outcome,
        winner_nullifier,
    });

    Ok(())
}

#[event]
pub struct EscrowOutcomeEvent {
    pub auction_id: [u8; 32],
    pub nullifier: [u8; 32],
    pub outcome: u8,
    pub winner_nullifier: [u8; 32],
}
*/
// === end Groth16/SNARK removed block (write_escrow_outcome) ===
