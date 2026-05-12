use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::RefundJob;

/// Permissionless: close a `Pending` RefundJob whose deadline has passed.
///
/// Rent + remaining lamports (the residual `amount` if no keeper ever
/// processed) go back to `original_payer` — the subscriber who paid the
/// rent in `submit_refund_job`. The caller pays only the tx fee, which
/// makes this safe to expose as a free public GC endpoint.
#[derive(Accounts)]
pub struct ExpireRefundJob<'info> {
    /// Anyone can call. Pays only the tx fee.
    pub caller: Signer<'info>,

    /// The expired job. Closed on success; rent + residual → original_payer.
    /// Boxed for stack-frame safety, same pattern as `submit_refund_job`.
    #[account(
        mut,
        seeds = [RefundJob::SEED_PREFIX, refund_job.source_vault.as_ref()],
        bump = refund_job.bump,
        constraint = refund_job.status == RefundJob::STATUS_PENDING
            @ RelayerError::JobNotPending,
        close = original_payer,
    )]
    pub refund_job: Box<Account<'info, RefundJob>>,

    /// Must match `refund_job.original_payer`. Receives rent + residual.
    /// Kept as `SystemAccount` (not `Signer`) so the caller can permissionlessly
    /// expire a stuck job on the subscriber's behalf.
    #[account(
        mut,
        constraint = original_payer.key() == refund_job.original_payer
            @ RelayerError::InvalidSubmitter,
    )]
    pub original_payer: SystemAccount<'info>,
}

pub fn handler(ctx: Context<ExpireRefundJob>) -> Result<()> {
    let clock = Clock::get()?;
    let refund_job = &mut ctx.accounts.refund_job;

    require!(
        clock.slot > refund_job.deadline_slot,
        RelayerError::JobNotExpired
    );

    refund_job.status = RefundJob::STATUS_EXPIRED;

    emit!(RefundJobExpiredEvent {
        source_vault: refund_job.source_vault,
        original_payer: refund_job.original_payer,
        amount: refund_job.amount,
        expired_at_slot: clock.slot,
    });

    Ok(())
}

#[event]
pub struct RefundJobExpiredEvent {
    pub source_vault: Pubkey,
    pub original_payer: Pubkey,
    pub amount: u64,
    pub expired_at_slot: u64,
}
