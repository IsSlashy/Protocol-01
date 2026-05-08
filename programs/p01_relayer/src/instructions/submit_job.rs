use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::RelayerError;
use crate::state::{RelayerConfig, RelayerNode, RelayJob};

/// Minimum reputation score (out of 10,000) required for job assignment.
/// Relayers below this threshold cannot receive new jobs until their
/// reputation recovers through successful completions.
pub const MIN_REPUTATION: u32 = 50;

/// Submit an encrypted relay job.
///
/// A privacy-seeking user posts an encrypted transaction and deposits a fee.
/// The assigned relayer will decrypt and submit the transaction on-chain.
///
/// PDA: [b"relay_job", job_id.as_ref()]
#[derive(Accounts)]
#[instruction(job_id: [u8; 32], encrypted_tx: Vec<u8>)]
pub struct SubmitJob<'info> {
    /// User submitting the relay job (pays fee + rent)
    #[account(mut)]
    pub submitter: Signer<'info>,

    /// Relayer config (must be active)
    #[account(
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump,
        constraint = config.is_active @ RelayerError::ProtocolPaused
    )]
    pub config: Account<'info, RelayerConfig>,

    /// Assigned relayer (must be active; reputation gate enforced in handler
    /// after `apply_decay`).
    /// Wrapped in `Box` to keep the 1184-byte ML-KEM-768 public-key field
    /// off the SBF stack — `Account<'info, RelayerNode>` directly would
    /// blow the 4096-byte stack frame limit in `try_accounts`, causing
    /// undefined behavior at runtime ("Access violation in stack frame N").
    #[account(
        mut,
        seeds = [RelayerNode::SEED_PREFIX, assigned_relayer.operator.as_ref()],
        bump = assigned_relayer.bump,
        constraint = assigned_relayer.is_active @ RelayerError::RelayerNotActive
    )]
    pub assigned_relayer: Box<Account<'info, RelayerNode>>,

    /// Relay job PDA (created on submission). Boxed for the same reason —
    /// `RelayJob` carries a 1280-byte `Vec<u8>` capacity.
    #[account(
        init,
        payer = submitter,
        space = RelayJob::LEN,
        seeds = [RelayJob::SEED_PREFIX, job_id.as_ref()],
        bump
    )]
    pub job: Box<Account<'info, RelayJob>>,

    /// System program
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SubmitJob>,
    job_id: [u8; 32],
    encrypted_tx: Vec<u8>,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let fee_lamports = config.job_fee_lamports;

    // Apply lazy decay before gating on reputation. Mutates the relayer
    // node, which is why this account is `mut` above. A dormant relayer
    // sees its score collapse here and is rejected by the MIN_REPUTATION
    // gate below.
    ctx.accounts.assigned_relayer.apply_decay(clock.slot);
    require!(
        ctx.accounts.assigned_relayer.reputation_score >= MIN_REPUTATION,
        RelayerError::InsufficientReputation
    );

    // Validate encrypted tx size
    require!(
        encrypted_tx.len() <= crate::state::MAX_ENCRYPTED_TX_SIZE,
        RelayerError::EncryptedTxTooLarge
    );

    // Transfer fee from submitter to job PDA
    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.submitter.to_account_info(),
            to: ctx.accounts.job.to_account_info(),
        },
    );
    system_program::transfer(transfer_ctx, fee_lamports)?;

    // Calculate deadline
    let deadline_slot = clock
        .slot
        .checked_add(config.job_timeout_slots)
        .ok_or(RelayerError::ArithmeticOverflow)?;

    // Initialize the job (legacy single-shot mode — encrypted_tx inline).
    // `encryption_version` derived from the first byte of encrypted_tx
    // (0x01 = X25519, 0x02 = ML-KEM-768 hybrid). Defaults to 1 if absent.
    let enc_version = encrypted_tx.first().copied().unwrap_or(1);
    let job = &mut ctx.accounts.job;
    job.job_id = job_id;
    job.encrypted_tx = encrypted_tx;
    job.assigned_relayer = ctx.accounts.assigned_relayer.key();
    job.submitter = ctx.accounts.submitter.key();
    job.fee_lamports = fee_lamports;
    job.posted_at_slot = clock.slot;
    job.deadline_slot = deadline_slot;
    job.status = crate::state::JobStatus::Pending;
    job.bump = ctx.bumps.job;
    // Phase A.3 — chunked-mode metadata; legacy single-shot ⇒ total_chunks=0.
    job.total_chunks = 0;
    job.chunks_received = 0;
    job.encryption_version = enc_version;

    msg!(
        "Job submitted: relayer={}, fee={}, deadline={}",
        job.assigned_relayer,
        fee_lamports,
        deadline_slot
    );

    emit!(JobSubmittedEvent {
        job_id,
        assigned_relayer: job.assigned_relayer,
        fee: fee_lamports,
        deadline_slot,
    });

    Ok(())
}

#[event]
pub struct JobSubmittedEvent {
    pub job_id: [u8; 32],
    pub assigned_relayer: Pubkey,
    pub fee: u64,
    pub deadline_slot: u64,
}
