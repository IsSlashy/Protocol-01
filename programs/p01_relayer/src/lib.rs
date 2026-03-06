use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW");

#[program]
pub mod p01_relayer {
    use super::*;

    // -----------------------------------------------------------------------
    // Admin — protocol configuration
    // -----------------------------------------------------------------------

    /// Initialize the global relayer config. Called once by the deployer.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        min_stake: u64,
        max_relayers: u16,
        job_fee_lamports: u64,
        protocol_fee_bps: u16,
        protocol_fee_wallet: Pubkey,
        job_timeout_slots: u64,
        slash_amount: u64,
        cooldown_slots: u64,
    ) -> Result<()> {
        instructions::initialize_config::handler(
            ctx,
            min_stake,
            max_relayers,
            job_fee_lamports,
            protocol_fee_bps,
            protocol_fee_wallet,
            job_timeout_slots,
            slash_amount,
            cooldown_slots,
        )
    }

    /// Update protocol configuration parameters.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        min_stake: Option<u64>,
        max_relayers: Option<u16>,
        job_fee_lamports: Option<u64>,
        protocol_fee_bps: Option<u16>,
        protocol_fee_wallet: Option<Pubkey>,
        job_timeout_slots: Option<u64>,
        slash_amount: Option<u64>,
        cooldown_slots: Option<u64>,
        is_active: Option<bool>,
    ) -> Result<()> {
        instructions::update_config::handler(
            ctx,
            min_stake,
            max_relayers,
            job_fee_lamports,
            protocol_fee_bps,
            protocol_fee_wallet,
            job_timeout_slots,
            slash_amount,
            cooldown_slots,
            is_active,
        )
    }

    // -----------------------------------------------------------------------
    // Relayer lifecycle
    // -----------------------------------------------------------------------

    /// Register as a relayer by staking SOL and providing an encryption key.
    pub fn register_relayer(
        ctx: Context<RegisterRelayer>,
        encryption_key: [u8; 32],
        endpoint_hash: [u8; 32],
    ) -> Result<()> {
        instructions::register_relayer::handler(ctx, encryption_key, endpoint_hash)
    }

    /// Deactivate this relayer (stops accepting jobs, begins cooldown).
    pub fn deactivate_relayer(ctx: Context<DeactivateRelayer>) -> Result<()> {
        instructions::deactivate_relayer::handler(ctx)
    }

    /// Unstake SOL after cooldown period and close the relayer account.
    pub fn unstake_relayer(ctx: Context<UnstakeRelayer>) -> Result<()> {
        instructions::unstake_relayer::handler(ctx)
    }

    /// Rotate the relayer's X25519 encryption key.
    pub fn update_relayer_key(
        ctx: Context<UpdateRelayerKey>,
        new_encryption_key: [u8; 32],
    ) -> Result<()> {
        instructions::update_relayer_key::handler(ctx, new_encryption_key)
    }

    // -----------------------------------------------------------------------
    // Job lifecycle
    // -----------------------------------------------------------------------

    /// Submit an encrypted relay job. The submitter should be an ephemeral
    /// keypair to avoid linking the job to the user's main wallet.
    pub fn submit_job(
        ctx: Context<SubmitJob>,
        job_id: [u8; 32],
        encrypted_tx: Vec<u8>,
    ) -> Result<()> {
        instructions::submit_job::handler(ctx, job_id, encrypted_tx)
    }

    /// Relayer reports successful job completion with the tx signature.
    pub fn complete_job(
        ctx: Context<CompleteJob>,
        tx_signature: [u8; 64],
    ) -> Result<()> {
        instructions::complete_job::handler(ctx, tx_signature)
    }

    /// Expire a timed-out job. Permissionless — anyone can call this.
    /// Refunds the fee to the submitter and slashes the relayer.
    pub fn expire_job(ctx: Context<ExpireJob>) -> Result<()> {
        instructions::expire_job::handler(ctx)
    }

    /// Cancel a pending job. Only the original submitter can cancel.
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        instructions::cancel_job::handler(ctx)
    }
}
