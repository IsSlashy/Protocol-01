use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::RefundJob;

/// Maximum ciphertext bytes carried in `RefundProcessedEvent`. Sized for
/// v1 stealth envelope (ephemeral_pub already separate; this is the
/// encrypted note payload only: ~96 B amount/secret/leaf + 40 B AEAD
/// overhead. 256 B headroom is generous).
pub const MAX_REFUND_CIPHERTEXT: usize = 256;

/// Keeper processes a pending RefundJob.
///
/// **MVP design (event-based fallback):**
/// This instruction does NOT itself CPI into `zk_shielded::shield_denominated`.
/// Reasons:
///   1. `shield_denominated` requires `depositor: Signer<'info>`. Making the
///      RefundJob PDA the depositor needs an `invoke_signed` from p01_relayer
///      with the refund_job seeds.
///   2. `shield_denominated` also touches `PROTOCOL_FEE_WALLET`, optional SPL
///      token accounts, and `merkle_tree.insert_with_root` — the account list
///      and fee math diverge from anything else in this program.
///   3. The task explicitly authorises an event-based fallback: emit a
///      `RefundReadyForKeeper`-style event and let the off-chain keeper
///      (Railway service) call `shield_denominated` directly.
///
/// What this ix DOES do:
///   • Validates the job (status, deadline, sane ciphertext length)
///   • Validates the keeper-provided pool/tree accounts match the job
///   • Pays the keeper its frozen `keeper_fee_lamports` from the PDA
///   • Drains the remaining `amount - keeper_fee` from the PDA to the
///     keeper, who is then responsible for submitting a follow-up
///     `shield_denominated` tx that deposits those lamports into the pool
///     with the supplied `commitment` and `new_root`. The keeper signs
///     that follow-up tx and pays no net out-of-pocket (it just routes
///     the lamports through).
///   • Marks the job Completed and emits `RefundProcessedEvent` with the
///     full announcement payload (commitment, ephemeral_pub, view_tag,
///     ciphertext) so the original subscriber's scanner can pick it up.
///
/// **Trust model:** the keeper is incentivised by `keeper_fee_lamports`
/// but in this MVP is also trusted to actually call `shield_denominated`.
/// If they pocket the refund and never shield, the subscriber's note is
/// lost — same risk envelope as today's relayer node pre-bond. A future
/// sprint can fold the shield into a single atomic ix via CPI once
/// `shield_denominated` is refactored to accept a PDA depositor.
#[derive(Accounts)]
pub struct ProcessRefundJob<'info> {
    /// The job being processed. Closed on success (rent → keeper).
    /// Boxed: 234-byte payload + close path keeps the stack frame small.
    #[account(
        mut,
        seeds = [RefundJob::SEED_PREFIX, refund_job.source_vault.as_ref()],
        bump = refund_job.bump,
        constraint = refund_job.status == RefundJob::STATUS_PENDING
            @ RelayerError::JobNotPending,
        close = keeper,
    )]
    pub refund_job: Box<Account<'info, RefundJob>>,

    /// Keeper paying the tx fee and receiving keeper_fee_lamports + rent
    /// + the residual amount (which the keeper MUST forward to the pool
    /// in a follow-up `shield_denominated` tx — see ix-level doc above).
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// CHECK: denominated_pool account; only its key is validated here
    /// (against `refund_job.target_pool`). Keeper will pass it to
    /// `shield_denominated` in the follow-up tx where Anchor performs
    /// the seed check.
    #[account(
        constraint = denominated_pool.key() == refund_job.target_pool
            @ RelayerError::InvalidRelayerAssignment
    )]
    pub denominated_pool: AccountInfo<'info>,

    /// CHECK: merkle_tree account; key validated against
    /// `refund_job.target_tree`. Same rationale as `denominated_pool`.
    #[account(
        constraint = merkle_tree.key() == refund_job.target_tree
            @ RelayerError::InvalidRelayerAssignment
    )]
    pub merkle_tree: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ProcessRefundJob>,
    commitment: [u8; 32],
    new_root: [u8; 32],
    ephemeral_pub: [u8; 32],
    view_tag: u8,
    ciphertext: Vec<u8>,
) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        ciphertext.len() <= MAX_REFUND_CIPHERTEXT,
        RelayerError::EncryptedTxTooLarge
    );

    let refund_job = &mut ctx.accounts.refund_job;

    require!(
        clock.slot <= refund_job.deadline_slot,
        RelayerError::JobExpired
    );

    // The keeper fee is *informational* on-chain: because we use
    // `close = keeper`, the keeper receives the full PDA balance
    // (rent + `amount` lamports) atomically when the account closes.
    // The keeper is expected to forward `amount` into the pool via
    // their own follow-up `shield_denominated` tx (paying the protocol
    // fee from those same lamports). The `keeper_fee_lamports` value
    // is preserved on the (about-to-be-closed) struct purely so the
    // emitted event reports it; off-chain accounting can verify the
    // keeper isn't over-claiming.
    let keeper_fee = refund_job.keeper_fee_lamports;
    let amount = refund_job.amount;

    refund_job.status = RefundJob::STATUS_COMPLETED;

    emit!(RefundProcessedEvent {
        source_vault: refund_job.source_vault,
        target_pool: refund_job.target_pool,
        target_tree: refund_job.target_tree,
        keeper: ctx.accounts.keeper.key(),
        amount,
        keeper_fee_lamports: keeper_fee,
        commitment,
        new_root,
        ephemeral_pub,
        view_tag,
        ciphertext,
    });

    Ok(())
}

/// Emitted on successful refund processing. The keeper publishes the
/// stealth announcement (commitment, ephemeral_pub, view_tag, ciphertext)
/// here so the recipient's existing stealth scanner picks it up via the
/// same RPC event stream as other shielded notes.
///
/// `new_root` is included for off-chain merkle replay consumers; the
/// authoritative merkle insert happens in the keeper's follow-up
/// `shield_denominated` tx (event-based MVP — see ix-level doc).
#[event]
pub struct RefundProcessedEvent {
    pub source_vault: Pubkey,
    pub target_pool: Pubkey,
    pub target_tree: Pubkey,
    pub keeper: Pubkey,
    pub amount: u64,
    pub keeper_fee_lamports: u64,
    pub commitment: [u8; 32],
    pub new_root: [u8; 32],
    pub ephemeral_pub: [u8; 32],
    pub view_tag: u8,
    pub ciphertext: Vec<u8>,
}
