use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::RelayerError;
use crate::state::{RelayerConfig, RelayerNode, RelayJob};

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

    /// Assigned relayer (must be active)
    #[account(
        seeds = [RelayerNode::SEED_PREFIX, assigned_relayer.operator.as_ref()],
        bump = assigned_relayer.bump,
        constraint = assigned_relayer.is_active @ RelayerError::RelayerNotActive
    )]
    pub assigned_relayer: Account<'info, RelayerNode>,

    /// Relay job PDA (created on submission)
    #[account(
        init,
        payer = submitter,
        space = RelayJob::LEN,
        seeds = [RelayJob::SEED_PREFIX, job_id.as_ref()],
        bump
    )]
    pub job: Account<'info, RelayJob>,

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

    // Initialize the job
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
