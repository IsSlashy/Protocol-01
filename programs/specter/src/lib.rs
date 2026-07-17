use anchor_lang::prelude::*;

pub mod airdrop;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
pub use airdrop::*;

declare_id!("FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL");

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
    // Stealth Payments — v2 (hybrid X25519 + ML-KEM-768), chunked transport
    // =========================================================================
    // The single-shot `send_private_v2` was removed: passing the 1088-byte KEM
    // ciphertext as one instruction arg overflowed both the 1232-byte tx cap and
    // the 4096-byte SBF stack. The chunked init + write pair below replaces it.

    /// Initialize a v2 hybrid stealth announcement (native SOL), header only.
    ///
    /// Replaces the uncallable single-shot `send_private_v2`: the 1088-byte KEM
    /// ciphertext is too large for one transaction, so it is streamed with
    /// `write_stealth_kem_chunk` after this creates the PDA. The payment funds
    /// are a separate `SystemProgram::transfer` to `stealth_address`.
    pub fn init_stealth_v2(
        ctx: Context<InitStealthV2>,
        amount: u64,
        ephemeral_pub_key: [u8; 32],
        stealth_address: Pubkey,
        view_tag: u8,
    ) -> Result<()> {
        instructions::init_stealth_v2::handler(ctx, amount, ephemeral_pub_key, stealth_address, view_tag)
    }

    /// Write a slice of the ML-KEM-768 ciphertext into a v2 announcement PDA.
    pub fn write_stealth_kem_chunk(
        ctx: Context<WriteStealthKemChunk>,
        stealth_address: Pubkey,
        offset: u16,
        chunk: Vec<u8>,
    ) -> Result<()> {
        instructions::write_stealth_kem_chunk::handler(ctx, stealth_address, offset, chunk)
    }

    // Native-SOL v2 claim needs no program instruction: the recipient derives
    // the stealth keypair and signs a SystemProgram::transfer out of the
    // one-time address. (Rent reclaim / close of the announcement PDA is a
    // follow-up.)

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
        ctx: Context<CreateAirdrop>,
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
        ctx: Context<ClaimAirdrop>,
        amount: u64,
        salt: [u8; 32],
        leaf_index: u32,
        proof_elements: Vec<[u8; 32]>,
        proof_indices: Vec<u8>,
    ) -> Result<()> {
        airdrop::handler_claim_airdrop(ctx, amount, salt, leaf_index, proof_elements, proof_indices)
    }

    /// Close an expired airdrop campaign and reclaim remaining tokens.
    pub fn close_airdrop(ctx: Context<CloseAirdrop>) -> Result<()> {
        airdrop::handler_close_airdrop(ctx)
    }
}
