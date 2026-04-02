use anchor_lang::prelude::*;

pub mod airdrop;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("8rywsvheQZPp8efQ4bsZ37J9GWMLY2ER76f3o8opPsYh");

#[program]
pub mod p01 {
    use super::*;

    // =========================================================================
    // Wallet
    // =========================================================================

    /// Initialize a new Protocol 01 wallet with viewing and spending keys
    pub fn init_wallet(
        ctx: Context<InitWallet>,
        viewing_key: [u8; 32],
        spending_key: [u8; 32],
    ) -> Result<()> {
        instructions::init_wallet::handler(ctx, viewing_key, spending_key)
    }

    // =========================================================================
    // Stealth Payments — v1 (classical X25519)
    // =========================================================================

    /// Send a private payment using stealth addressing (v1, classical)
    pub fn send_private(
        ctx: Context<SendPrivate>,
        amount: u64,
        stealth_address: [u8; 32],
        encrypted_amount: [u8; 32],
        decoy_level: u8,
    ) -> Result<()> {
        instructions::send_private::handler(ctx, amount, stealth_address, encrypted_amount, decoy_level)
    }

    /// Claim a stealth payment by providing proof of ownership (v1)
    pub fn claim_stealth(
        ctx: Context<ClaimStealth>,
        proof: [u8; 64],
    ) -> Result<()> {
        instructions::claim_stealth::handler(ctx, proof)
    }

    // =========================================================================
    // Stealth Payments — v2 (hybrid X25519 + ML-KEM-768)
    // =========================================================================

    /// Send a hybrid quantum-resistant stealth payment (v2).
    ///
    /// Stores both an X25519 ephemeral public key (32 bytes) and an
    /// ML-KEM-768 ciphertext (1088 bytes) on-chain. The recipient uses
    /// both to derive the stealth private key, ensuring security against
    /// both classical and quantum adversaries.
    ///
    /// PDA size: ~1220 bytes (~0.0093 SOL rent).
    /// The account can be closed after claiming to reclaim rent.
    ///
    /// Emits: `StealthPaymentCreatedV2` event for client-side indexing.
    pub fn send_private_v2(
        ctx: Context<SendPrivateV2>,
        amount: u64,
        ephemeral_pub_key: [u8; 32],
        stealth_address: Pubkey,
        view_tag: u8,
        kem_ciphertext: [u8; 1088],
    ) -> Result<()> {
        instructions::send_private_v2::handler(
            ctx,
            amount,
            ephemeral_pub_key,
            stealth_address,
            view_tag,
            kem_ciphertext,
        )
    }

    /// Claim a v2 hybrid stealth payment and close the announcement account.
    ///
    /// After the recipient decapsulates the ML-KEM-768 shared secret and
    /// derives the stealth private key, they call this instruction to:
    /// 1. Transfer escrowed tokens to their wallet
    /// 2. Close the 1220-byte PDA and reclaim ~0.0093 SOL rent
    ///
    /// Emits: `StealthPaymentClaimed` event.
    pub fn claim_stealth_v2(
        ctx: Context<ClaimStealthV2>,
        proof: [u8; 64],
    ) -> Result<()> {
        instructions::claim_stealth_v2::handler(ctx, proof)
    }

    // =========================================================================
    // Streaming Payments
    // =========================================================================

    /// Create a new streaming payment
    pub fn create_stream(
        ctx: Context<CreateStream>,
        total_amount: u64,
        duration_seconds: i64,
        is_private: bool,
        stream_timestamp: i64,
    ) -> Result<()> {
        instructions::create_stream::handler(ctx, total_amount, duration_seconds, is_private, stream_timestamp)
    }

    /// Withdraw available funds from an active stream
    pub fn withdraw_stream(ctx: Context<WithdrawStream>) -> Result<()> {
        instructions::withdraw_stream::handler(ctx)
    }

    /// Cancel an active stream and return remaining funds to sender
    pub fn cancel_stream(ctx: Context<CancelStream>) -> Result<()> {
        instructions::cancel_stream::handler(ctx)
    }

    // =========================================================================
    // Stealth Airdrops (Merkle-based private distribution)
    // =========================================================================

    /// Create a new Merkle-based private airdrop campaign.
    /// Escrows SPL tokens into a PDA; no recipient data stored on-chain.
    pub fn create_airdrop(
        ctx: Context<airdrop::CreateAirdrop>,
        merkle_root: [u8; 32],
        total_amount: u64,
        total_recipients: u32,
        name: [u8; 32],
        expires_in_seconds: i64,
        campaign_nonce: [u8; 16],
    ) -> Result<()> {
        airdrop::handler_create_airdrop(ctx, merkle_root, total_amount, total_recipients, name, expires_in_seconds, campaign_nonce)
    }

    /// Claim tokens from a private airdrop using a SHA-256 Merkle proof.
    pub fn claim_airdrop(
        ctx: Context<airdrop::ClaimAirdrop>,
        amount: u64,
        salt: [u8; 32],
        leaf_index: u32,
        proof_elements: Vec<[u8; 32]>,
        proof_indices: Vec<u8>,
    ) -> Result<()> {
        airdrop::handler_claim_airdrop(ctx, amount, salt, leaf_index, proof_elements, proof_indices)
    }

    /// Close an expired airdrop campaign and reclaim remaining tokens.
    pub fn close_airdrop(ctx: Context<airdrop::CloseAirdrop>) -> Result<()> {
        airdrop::handler_close_airdrop(ctx)
    }
}
