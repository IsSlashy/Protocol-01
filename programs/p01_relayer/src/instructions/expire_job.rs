use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::{JobStatus, RelayJob, RelayerConfig, RelayerNode};

/// Expire a timed-out job. Permissionless — anyone can call this.
///
/// If a relayer fails to complete a job before the deadline, anyone can
/// expire it. The fee is refunded to the submitter (via close) and the
/// relayer is slashed.
#[derive(Accounts)]
pub struct ExpireJob<'info> {
    /// Anyone can call this (cranker / permissionless)
    #[account(mut)]
    pub cranker: Signer<'info>,

    /// Relayer config (for slash_amount)
    #[account(
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump
    )]
    pub config: Account<'info, RelayerConfig>,

    /// The relayer that was assigned (gets slashed)
    #[account(
        mut,
        constraint = relayer_node.key() == job.assigned_relayer @ RelayerError::InvalidRelayerAssignment
    )]
    pub relayer_node: Account<'info, RelayerNode>,

    /// The expired job — fee + rent returned to submitter via close
    #[account(
        mut,
        seeds = [RelayJob::SEED_PREFIX, job.job_id.as_ref()],
        bump = job.bump,
        constraint = job.status as u8 == JobStatus::Pending as u8 @ RelayerError::JobNotPending,
        close = submitter
    )]
    pub job: Account<'info, RelayJob>,

    /// Original submitter (receives fee refund + rent + slash)
    /// CHECK: validated against job.submitter
    #[account(
        mut,
        constraint = submitter.key() == job.submitter @ RelayerError::InvalidSubmitter
    )]
    pub submitter: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ExpireJob>) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let job = &mut ctx.accounts.job;
    let relayer_node = &mut ctx.accounts.relayer_node;

    // Ensure job has actually expired
    require!(clock.slot > job.deadline_slot, RelayerError::JobNotExpired);

    // Slash the relayer: transfer slash_amount from relayer_node PDA to submitter
    let slash = config.slash_amount.min(relayer_node.stake);
    if slash > 0 {
        relayer_node.to_account_info().sub_lamports(slash)?;
        ctx.accounts
            .submitter
            .to_account_info()
            .add_lamports(slash)?;
        relayer_node.stake = relayer_node.stake.saturating_sub(slash);
    }

    // Apply pending decay before the explicit -500 penalty so total
    // reputation reflects (a) dormant time + (b) failed assignment, not
    // double-counted. last_active_slot intentionally NOT bumped to
    // clock.slot — expiring a job is failure, not activity.
    relayer_node.apply_decay(clock.slot);

    // Update status and stats
    job.status = JobStatus::Expired;
    relayer_node.jobs_failed = relayer_node.jobs_failed.saturating_add(1);
    relayer_node.decrease_reputation(500);

    msg!(
        "Job expired: relayer={} slashed={}, fee refunded to submitter",
        relayer_node.operator,
        slash
    );

    emit!(JobExpiredEvent {
        job_id: job.job_id,
        relayer: relayer_node.key(),
        slash_amount: slash,
    });

    Ok(())
}

#[event]
pub struct JobExpiredEvent {
    pub job_id: [u8; 32],
    pub relayer: Pubkey,
    pub slash_amount: u64,
}
