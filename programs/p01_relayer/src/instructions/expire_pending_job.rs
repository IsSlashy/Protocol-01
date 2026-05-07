use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::{JobStatus, RelayJob};

/// Permissionless GC: close a `Pending` relay job whose `posted_at_slot`
/// is ≥ 150 slots in the past.  Rent is returned to the original `submitter`
/// (not the caller — the submitter paid the rent).
///
/// **Chunk cleanup decision**: RelayChunk PDAs are NOT closed here.
/// The `expire_pending_job` ix is permissionless and would need an unknown
/// number of `remaining_accounts` to close all chunks (up to 256) atomically.
/// Handling them inline would bloat CU and make the account list
/// variable-length, which breaks Anchor's static account validation.
///
/// In practice the chunk PDAs are tiny (~1040 bytes each → ~0.007 SOL/chunk).
/// The submitter can reclaim them later via a dedicated `expire_chunk` ix
/// (not implemented in this sprint) or the deployer can sweep them.
/// This is documented as a known limitation.
#[derive(Accounts)]
pub struct ExpirePendingJob<'info> {
    /// Anyone can be the caller — they pay the tx fee.
    pub caller: Signer<'info>,

    /// The stuck pending job to be closed.  Rent goes back to `submitter`.
    #[account(
        mut,
        constraint = job.status as u8 == JobStatus::Pending as u8 @ RelayerError::JobNotPending,
        close = submitter,
    )]
    pub job: Box<Account<'info, RelayJob>>,

    /// Must match `job.submitter` — receives the rent refund.
    #[account(
        mut,
        constraint = submitter.key() == job.submitter @ RelayerError::InvalidSubmitter,
    )]
    pub submitter: SystemAccount<'info>,
}

pub fn handler(ctx: Context<ExpirePendingJob>) -> Result<()> {
    let clock = Clock::get()?;
    let job = &ctx.accounts.job;

    let age = clock
        .slot
        .checked_sub(job.posted_at_slot)
        .unwrap_or(0);

    require!(age >= 150, RelayerError::JobNotExpired);

    emit!(JobPendingExpiredEvent {
        job_id: job.job_id,
        submitter: job.submitter,
        posted_at_slot: job.posted_at_slot,
        expired_at_slot: clock.slot,
    });

    Ok(())
}

#[event]
pub struct JobPendingExpiredEvent {
    pub job_id: [u8; 32],
    pub submitter: Pubkey,
    pub posted_at_slot: u64,
    pub expired_at_slot: u64,
}
