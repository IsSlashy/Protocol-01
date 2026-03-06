use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::{JobStatus, RelayJob};

/// Cancel a pending job. Only the original submitter can cancel.
///
/// Fee + rent returned to submitter via close. No slash to the relayer.
#[derive(Accounts)]
pub struct CancelJob<'info> {
    /// Must be the original submitter
    #[account(mut)]
    pub submitter: Signer<'info>,

    /// The job to cancel — all lamports returned to submitter via close
    #[account(
        mut,
        seeds = [RelayJob::SEED_PREFIX, job.job_id.as_ref()],
        bump = job.bump,
        constraint = job.status as u8 == JobStatus::Pending as u8 @ RelayerError::JobNotPending,
        has_one = submitter @ RelayerError::InvalidSubmitter,
        close = submitter
    )]
    pub job: Account<'info, RelayJob>,
}

pub fn handler(ctx: Context<CancelJob>) -> Result<()> {
    let job = &mut ctx.accounts.job;

    job.status = JobStatus::Cancelled;

    msg!("Job cancelled: job_id={:?}", &job.job_id[..8]);

    emit!(JobCancelledEvent {
        job_id: job.job_id,
        submitter: ctx.accounts.submitter.key(),
    });

    Ok(())
}

#[event]
pub struct JobCancelledEvent {
    pub job_id: [u8; 32],
    pub submitter: Pubkey,
}
