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
///   • Pays the keeper ONLY its frozen `keeper_fee_lamports` plus the PDA
///     rent (legitimate compensation for processing the job + paying tx fee).
///   • Returns the refund PRINCIPAL (`amount - keeper_fee`) to the original
///     subscriber (`original_payer`) on-chain. The keeper CANNOT pocket the
///     principal: lamports are moved explicitly, the PDA is zeroed, and the
///     recipient is the verified `original_payer` recorded at submit time.
///   • Marks the job Completed and emits `RefundProcessedEvent` with the
///     full announcement payload (commitment, ephemeral_pub, view_tag,
///     ciphertext) so the original subscriber's scanner can pick it up.
///
/// **Why principal → `original_payer` (not a pool CPI):** re-shielding via
/// `shield_denominated` is impossible from here (PDA-depositor / fee-account
/// divergence, see reasons 1–2). The only on-chain-enforceable rightful
/// recipient of the principal is the subscriber who funded the cancelled
/// vault, recorded as `original_payer` at submit time and already used by
/// `expire_refund_job` for exactly this purpose. The keeper still publishes
/// the stealth announcement event so an off-chain shield can re-privatise
/// the funds if desired, but the on-chain settlement no longer trusts the
/// keeper with the principal.
#[derive(Accounts)]
pub struct ProcessRefundJob<'info> {
    /// The job being processed. Closed manually on success: rent + keeper_fee
    /// → keeper, principal → original_payer. (We do NOT use Anchor's
    /// `close = ...` because the balance must be split between two recipients;
    /// the account is zeroed + discriminator-cleared explicitly in the handler.)
    /// Boxed: 234-byte payload keeps the stack frame small.
    #[account(
        mut,
        seeds = [RefundJob::SEED_PREFIX, refund_job.source_vault.as_ref()],
        bump = refund_job.bump,
        constraint = refund_job.status == RefundJob::STATUS_PENDING
            @ RelayerError::JobNotPending,
    )]
    pub refund_job: Box<Account<'info, RefundJob>>,

    /// Keeper paying the tx fee. Receives ONLY `keeper_fee_lamports` + the
    /// PDA rent as compensation — never the refund principal.
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// Original subscriber recorded on the job. Receives the refund principal
    /// (`amount - keeper_fee`). `SystemAccount` (not `Signer`) so the
    /// permissionless keeper can settle on the subscriber's behalf; the key is
    /// pinned to `refund_job.original_payer` so the keeper cannot redirect it.
    #[account(
        mut,
        constraint = original_payer.key() == refund_job.original_payer
            @ RelayerError::InvalidSubmitter,
    )]
    pub original_payer: SystemAccount<'info>,

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

    // Snapshot the fields we need before any mutable-borrow gymnastics.
    let (source_vault, target_pool, target_tree, keeper_fee, amount, deadline_slot) = {
        let refund_job = &ctx.accounts.refund_job;
        (
            refund_job.source_vault,
            refund_job.target_pool,
            refund_job.target_tree,
            refund_job.keeper_fee_lamports,
            refund_job.amount,
            refund_job.deadline_slot,
        )
    };

    require!(clock.slot <= deadline_slot, RelayerError::JobExpired);

    // Settlement split (HIGH-severity fix — bug #4):
    //   • The keeper earns ONLY `keeper_fee` + the PDA rent.
    //   • The refund PRINCIPAL (`amount - keeper_fee`) goes back to the
    //     verified `original_payer` (the subscriber), NOT the keeper.
    //
    // The PDA holds `rent + amount` lamports (the cancel handler funded it
    // with the full residual at submit time). We move lamports manually and
    // then close the account ourselves, because Anchor's `close = X` can only
    // pay a single recipient and we must split the balance two ways.
    let pda_ai = ctx.accounts.refund_job.to_account_info();
    let keeper_ai = ctx.accounts.keeper.to_account_info();
    let payer_ai = ctx.accounts.original_payer.to_account_info();

    let pda_balance = pda_ai.lamports();
    // Rent = whatever sits in the PDA above the recorded refund `amount`.
    // (`amount` was transferred in on top of the rent-exempt minimum.)
    let rent_portion = pda_balance.saturating_sub(amount);

    // The keeper fee can never exceed the principal it is carved from.
    let keeper_fee = keeper_fee.min(amount);
    let principal = amount.saturating_sub(keeper_fee);

    // Keeper take = keeper_fee + rent (account is being closed, rent is freed).
    let keeper_take = keeper_fee
        .checked_add(rent_portion)
        .ok_or(RelayerError::ArithmeticOverflow)?;

    // Sanity: we must never try to move more than the PDA holds.
    require!(
        keeper_take.checked_add(principal).ok_or(RelayerError::ArithmeticOverflow)?
            <= pda_balance,
        RelayerError::ArithmeticOverflow
    );

    // Mark completed before draining (defensive; the account is closed below
    // so re-entry is impossible regardless).
    ctx.accounts.refund_job.status = RefundJob::STATUS_COMPLETED;

    // Move lamports out of the PDA. Direct lamport math is safe here because
    // the PDA is owned by this program and is closed in the same instruction.
    {
        let mut pda_lamports = pda_ai.try_borrow_mut_lamports()?;
        let mut keeper_lamports = keeper_ai.try_borrow_mut_lamports()?;
        let mut payer_lamports = payer_ai.try_borrow_mut_lamports()?;

        **keeper_lamports = keeper_lamports
            .checked_add(keeper_take)
            .ok_or(RelayerError::ArithmeticOverflow)?;
        **payer_lamports = payer_lamports
            .checked_add(principal)
            .ok_or(RelayerError::ArithmeticOverflow)?;
        // Drain the PDA to zero (rent + amount fully distributed).
        **pda_lamports = 0;
    }

    // Close the account: zeroed lamports + wiped discriminator so it cannot be
    // re-used or re-processed, and the runtime GCs it at end of tx.
    pda_ai.assign(&anchor_lang::system_program::ID);
    pda_ai.resize(0)?;

    emit!(RefundProcessedEvent {
        source_vault,
        target_pool,
        target_tree,
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
