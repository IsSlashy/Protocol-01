use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::RelayerError;
use crate::instructions::submit_job::MIN_REPUTATION;
use crate::state::{RelayerConfig, RelayerNode, RelayJob};

/// Phase A.3 — Submit a chunked relay job.
///
/// Initialises the `RelayJob` PDA in chunked mode (`total_chunks > 0`,
/// `encrypted_tx` empty). The submitter then calls `submit_chunk` N times
/// to populate the ciphertext into per-index `RelayChunk` PDAs. Worker
/// reassembles chunks before decrypt.
///
/// Chunked mode unlocks oversize V3 inner txs (~947B+) and v2 hybrid
/// ML-KEM-768 envelope (1161B overhead) — both impossible inline because
/// the submit_job tx itself hits the 1232-byte Solana cap.
///
/// PDA: [b"relay_job", job_id.as_ref()] (same as legacy submit_job)
#[derive(Accounts)]
#[instruction(job_id: [u8; 32], total_chunks: u16, encryption_version: u8)]
pub struct SubmitJobChunked<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,

    #[account(
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump,
        constraint = config.is_active @ RelayerError::ProtocolPaused
    )]
    pub config: Account<'info, RelayerConfig>,

    #[account(
        mut,
        seeds = [RelayerNode::SEED_PREFIX, assigned_relayer.operator.as_ref()],
        bump = assigned_relayer.bump,
        constraint = assigned_relayer.is_active @ RelayerError::RelayerNotActive
    )]
    pub assigned_relayer: Box<Account<'info, RelayerNode>>,

    #[account(
        init,
        payer = submitter,
        space = RelayJob::LEN,
        seeds = [RelayJob::SEED_PREFIX, job_id.as_ref()],
        bump
    )]
    pub job: Box<Account<'info, RelayJob>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SubmitJobChunked>,
    job_id: [u8; 32],
    total_chunks: u16,
    encryption_version: u8,
) -> Result<()> {
    require!(total_chunks > 0, RelayerError::InvalidChunkCount);
    // Sanity cap: arbitrary upper bound to prevent griefing the relayer with
    // thousands of pending chunks. Tunable.
    require!(total_chunks <= 256, RelayerError::InvalidChunkCount);
    require!(
        encryption_version == 1 || encryption_version == 2,
        RelayerError::UnsupportedEncryptionVersion
    );

    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let fee_lamports = config.job_fee_lamports;

    // Apply lazy decay before gating on reputation (same pattern as
    // submit_job.rs). The relayer account is `mut` above for this reason.
    ctx.accounts.assigned_relayer.apply_decay(clock.slot);
    require!(
        ctx.accounts.assigned_relayer.reputation_score >= MIN_REPUTATION,
        RelayerError::InsufficientReputation
    );

    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.submitter.to_account_info(),
            to: ctx.accounts.job.to_account_info(),
        },
    );
    system_program::transfer(transfer_ctx, fee_lamports)?;

    let deadline_slot = clock
        .slot
        .checked_add(config.job_timeout_slots)
        .ok_or(RelayerError::ArithmeticOverflow)?;

    let job = &mut ctx.accounts.job;
    job.job_id = job_id;
    job.encrypted_tx = Vec::new(); // chunks live in RelayChunk PDAs
    job.assigned_relayer = ctx.accounts.assigned_relayer.key();
    job.submitter = ctx.accounts.submitter.key();
    job.fee_lamports = fee_lamports;
    job.posted_at_slot = clock.slot;
    job.deadline_slot = deadline_slot;
    job.status = crate::state::JobStatus::Pending;
    job.bump = ctx.bumps.job;
    job.total_chunks = total_chunks;
    job.chunks_received = 0;
    job.encryption_version = encryption_version;

    msg!(
        "ChunkedJob submitted: relayer={}, chunks={}, ver={}, fee={}, deadline={}",
        job.assigned_relayer,
        total_chunks,
        encryption_version,
        fee_lamports,
        deadline_slot
    );

    Ok(())
}
