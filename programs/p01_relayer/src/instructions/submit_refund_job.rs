use anchor_lang::prelude::*;

use crate::constants::{REFUND_DEADLINE_SLOTS, REFUND_KEEPER_FEE};
use crate::state::RefundJob;

/// Initialise a RefundJob PDA for a cancelled private subscription.
///
/// ORPHANED. It had exactly one caller, `zk_shielded::cancel_private_stark`,
/// invoked by CPI when the source vault carried a `client_stealth_meta`.
/// That instruction has been DELETED along with cancellation and refunds —
/// a subscription is now a one-way prepaid envelope and `claim_period` is
/// the only exit — and `subscribe_private_stark` no longer writes
/// `client_stealth_meta` at all, so no vault created from here on could
/// select this path even if the caller came back.
///
/// Nothing on chain reaches this instruction any more. It is left in place
/// rather than deleted because `#[program]` dispatches on a discriminator
/// derived from the instruction NAME and the surviving refund-pipeline
/// instructions (`process_refund_job`, `expire_refund_job`) still have to
/// drain any RefundJob PDA already created on devnet. Removing the whole
/// pipeline is a decision about those live accounts, not a cleanup.
///
/// This instruction only initialises the PDA and records metadata — the
/// caller was responsible for transferring the residual lamports into
/// `refund_job` separately (via direct lamport manipulation on the vault
/// PDA). Since the caller is gone, a call today would be an externally
/// funded PDA with no vault behind it.
///
/// PDA: `[b"refund_job", source_vault.as_ref()]`.
#[derive(Accounts)]
pub struct SubmitRefundJob<'info> {
    /// Cancel payer (subscriber). Pays rent for the RefundJob PDA.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: source subscription vault PDA. Used as PDA seed only — every
    /// validation (ownership, status, denomination) was performed by the
    /// calling `zk_shielded::cancel_private_stark` handler before the CPI
    /// fired. That handler is deleted, so nothing validates this account
    /// any more; see the struct doc for why the instruction is still here.
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
