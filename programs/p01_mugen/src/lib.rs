use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN");

#[program]
pub mod p01_mugen {
    use super::*;

    /// Initialize the global exchange configuration (one-time).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        params: InitConfigParams,
    ) -> Result<()> {
        instructions::initialize_config::handler(ctx, params)
    }

    /// Create a new P2P buy/sell order.
    /// Requires a valid ZK compliance attestation (no KYC).
    pub fn create_order(
        ctx: Context<CreateOrder>,
        params: CreateOrderParams,
    ) -> Result<()> {
        instructions::create_order::handler(ctx, params)
    }

    /// Cancel an open order (maker only).
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::cancel_order::handler(ctx)
    }

    /// Take an open order — locks crypto in escrow.
    /// Both parties must hold valid ZK compliance attestations.
    pub fn take_order(
        ctx: Context<TakeOrder>,
        stealth_recipient: Option<[u8; 32]>,
        payment_method: u16,
    ) -> Result<()> {
        instructions::take_order::handler(ctx, stealth_recipient, payment_method)
    }

    /// Buyer confirms fiat payment was sent.
    pub fn confirm_payment(ctx: Context<ConfirmPayment>) -> Result<()> {
        instructions::confirm_payment::handler(ctx)
    }

    /// Seller releases escrowed crypto after confirming fiat receipt.
    /// Protocol fee deducted. Reputation updated for both parties.
    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        instructions::release_escrow::handler(ctx)
    }

    /// Either party opens a dispute on the escrow.
    pub fn dispute_escrow(ctx: Context<DisputeEscrow>, reason: u8) -> Result<()> {
        instructions::dispute_escrow::handler(ctx, reason)
    }

    /// Authority resolves a disputed escrow.
    /// outcome: 0 = release to buyer, 1 = refund to seller.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, outcome: u8) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, outcome)
    }

    /// Permissionless: expire and refund an escrow past its timeout.
    pub fn expire_escrow(ctx: Context<ExpireEscrow>) -> Result<()> {
        instructions::expire_escrow::handler(ctx)
    }
}
