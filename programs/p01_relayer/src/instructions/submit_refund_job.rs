use anchor_lang::prelude::*;

use crate::constants::{REFUND_DEADLINE_SLOTS, REFUND_KEEPER_FEE};
use crate::state::RefundJob;

/// Initialise a RefundJob PDA for a cancelled private subscription.
///
/// Called via CPI by `zk_shielded::cancel_private_stark` when the source
/// vault has a `client_stealth_meta` field set. This instruction only
/// initialises the PDA and records metadata — the caller is responsible
/// for transferring the residual lamports into `refund_job` separately
/// (via direct lamport manipulation on the vault PDA).
///
/// PDA: `[b"refund_job", source_vault.as_ref()]`.
#[derive(Accounts)]
pub struct SubmitRefundJob<'info> {
    /// Cancel payer (subscriber). Pays rent for the RefundJob PDA.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: source subscription vault PDA. Used as PDA seed only —
    /// any validation (ownership, status, denomination) is performed by
    /// the calling `zk_shielded::cancel_private_stark` handler before
    /// the CPI fires.
    pub source_vault: AccountInfo<'info>,

    /// The refund job PDA being initialised. Boxed to keep the 64-byte
    /// stealth_meta + 4 pubkeys off the SBF stack frame.
    #[account(
        init,
        payer = payer,
        space = RefundJob::LEN,
        seeds = [RefundJob::SEED_PREFIX, source_vault.key().as_ref()],
        bump
    )]
    pub refund_job: Box<Account<'info, RefundJob>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SubmitRefundJob>,
    amount: u64,
    stealth_meta: [u8; 64],
    target_pool: Pubkey,
    target_tree: Pubkey,
) -> Result<()> {
    let clock = Clock::get()?;
    let deadline_slot = clock
        .slot
        .checked_add(REFUND_DEADLINE_SLOTS)
        .ok_or(crate::errors::RelayerError::ArithmeticOverflow)?;

    let job = &mut ctx.accounts.refund_job;
    job.source_vault = ctx.accounts.source_vault.key();
    job.stealth_meta = stealth_meta;
    job.target_pool = target_pool;
    job.target_tree = target_tree;
    job.amount = amount;
    job.keeper_fee_lamports = REFUND_KEEPER_FEE;
    job.created_at_slot = clock.slot;
    job.deadline_slot = deadline_slot;
    job.original_payer = ctx.accounts.payer.key();
    job.status = RefundJob::STATUS_PENDING;
    job.bump = ctx.bumps.refund_job;

    emit!(RefundJobSubmittedEvent {
        source_vault: job.source_vault,
        target_pool,
        target_tree,
        amount,
        keeper_fee_lamports: job.keeper_fee_lamports,
        deadline_slot,
    });

    Ok(())
}

/// Emitted when a RefundJob is created. Used by keepers (Railway worker)
/// to discover pending jobs by scanning program logs. The `stealth_meta`
/// itself is NOT emitted — keepers fetch it from the PDA account data to
/// avoid duplicating 64 bytes on every cancel.
#[event]
pub struct RefundJobSubmittedEvent {
    pub source_vault: Pubkey,
    pub target_pool: Pubkey,
    pub target_tree: Pubkey,
    pub amount: u64,
    pub keeper_fee_lamports: u64,
    pub deadline_slot: u64,
}
