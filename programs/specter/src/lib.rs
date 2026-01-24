use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp");

#[program]
pub mod p01 {
    use super::*;

    /// Initialize a new Protocol 01 wallet with viewing and spending keys
    pub fn init_wallet(
        ctx: Context<InitWallet>,
        viewing_key: [u8; 32],
        spending_key: [u8; 32],
    ) -> Result<()> {
        instructions::init_wallet::handler(ctx, viewing_key, spending_key)
    }

    /// Send a private payment using stealth addressing
    pub fn send_private(
        ctx: Context<SendPrivate>,
        amount: u64,
        stealth_address: [u8; 32],
        encrypted_amount: [u8; 32],
        decoy_level: u8,
    ) -> Result<()> {
        instructions::send_private::handler(ctx, amount, stealth_address, encrypted_amount, decoy_level)
    }

    /// Claim a stealth payment by providing proof of ownership
    pub fn claim_stealth(
        ctx: Context<ClaimStealth>,
        proof: [u8; 64],
    ) -> Result<()> {
        instructions::claim_stealth::handler(ctx, proof)
    }

    /// Create a new streaming payment
    pub fn create_stream(
        ctx: Context<CreateStream>,
        total_amount: u64,
        duration_seconds: i64,
        is_private: bool,
    ) -> Result<()> {
        instructions::create_stream::handler(ctx, total_amount, duration_seconds, is_private)
    }

    /// Withdraw available funds from an active stream
    pub fn withdraw_stream(ctx: Context<WithdrawStream>) -> Result<()> {
        instructions::withdraw_stream::handler(ctx)
    }

    /// Cancel an active stream and return remaining funds to sender
    pub fn cancel_stream(ctx: Context<CancelStream>) -> Result<()> {
        instructions::cancel_stream::handler(ctx)
    }
}
