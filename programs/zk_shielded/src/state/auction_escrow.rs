use anchor_lang::prelude::*;

/// Auction escrow: holds two conditional commitments for a sealed-bid auction.
///
/// When a bidder places a bid, their denominated pool note is consumed (nullified)
/// and both possible outcomes are recorded:
///   - pay_commitment:    note for the seller (if bidder wins)
///   - refund_commitment: note for the bidder (if bidder loses)
///
/// After the Arcium MPC settles the auction and writes the outcome,
/// a permissionless `escrow_release` instruction inserts the correct
/// commitment into the Merkle tree. The other commitment is discarded.
///
/// PDA seeds: [b"auction_escrow", auction_id, nullifier]
#[account]
pub struct AuctionEscrow {
    /// Auction identifier: Poseidon(auction_pubkey, nonce) or hash of Auction PDA
    pub auction_id: [u8; 32],
    /// The denominated pool this escrow belongs to
    pub pool: Pubkey,
    /// Nullifier of the consumed source note (serves as bidder handle)
    pub nullifier: [u8; 32],
    /// Commitment that pays the seller (winner outcome)
    pub pay_commitment: [u8; 32],
    /// Commitment that refunds the bidder (loser outcome)
    pub refund_commitment: [u8; 32],
    /// 0 = unsettled, 1 = pay (winner), 2 = refund (loser)
    pub outcome: u8,
    /// Whether the escrow has been released (commitment inserted into tree)
    pub is_released: bool,
    /// Creation timestamp
    pub created_at: i64,
    /// PDA bump
    pub bump: u8,
}

impl AuctionEscrow {
    pub const SEED_PREFIX: &'static [u8] = b"auction_escrow";
    pub const OUTCOME_UNSETTLED: u8 = 0;
    pub const OUTCOME_PAY: u8 = 1;
    pub const OUTCOME_REFUND: u8 = 2;
    // 8 (discriminator) + 32 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 1 = 179
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 1;
}
