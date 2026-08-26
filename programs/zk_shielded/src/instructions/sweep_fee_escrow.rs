use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::fee::{FEE_ESCROW_SEED_PREFIX, TREASURY_AUTHORITY};
use crate::state::pool_v3::DenominatedPoolV3;

/// Drain a per-pool `fee_escrow` PDA into an arbitrary destination account
/// (Phase E v1).
///
/// Privacy property: the destination is supplied by the treasury at call time,
/// so it can rotate per sweep. Combined with the timing-decorrelation gain
/// (sweep happens minutes/hours after the actual user shields/unshields), this
/// breaks the per-tx fee-delta-to-treasury correlation pattern.
///
/// Authorization: only `TREASURY_AUTHORITY` (hardcoded admin pubkey) can sign.
/// Mainnet TODO: replace with multisig before launch.
///
/// Accounting: the SweepRecord PDA logs (slot, pool, amount, destination[..16])
/// for off-chain audit. Sweep is idempotent per (pool, slot) — re-sweeping in
/// the same slot fails on the SweepRecord init constraint.
#[derive(Accounts)]
#[instruction(amount: u64, slot: u64)]
pub struct SweepFeeEscrow<'info> {
    /// Treasury authority — must match the hardcoded `TREASURY_AUTHORITY`.
    /// Pays for tx fees + SweepRecord rent.
    #[account(
        mut,
        constraint = treasury_authority.key() == TREASURY_AUTHORITY @ ZkShieldedError::Unauthorized,
    )]
    pub treasury_authority: Signer<'info>,

    /// The denominated pool whose fee_escrow we're draining.
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    /// Per-pool fee_escrow PDA — drained.
    #[account(
        mut,
        seeds = [FEE_ESCROW_SEED_PREFIX, denominated_pool.key().as_ref()],
        bump,
    )]
    pub fee_escrow: SystemAccount<'info>,

    /// Destination — any account; rotated per sweep by the treasury for
    /// timing/address decorrelation.
    /// CHECK: arbitrary destination, no constraint beyond writability.
    #[account(mut)]
    pub destination: AccountInfo<'info>,

    /// Audit record (immutable per slot) — initialised here to make the sweep
    /// non-replayable in the same slot and to leave an off-chain trail for
    /// treasury reconciliation. Closed automatically by anyone after rent
    /// epoch (can be GC'd; the on-chain log + tx history is the canonical
    /// trail).
    #[account(
        init,
        payer = treasury_authority,
        space = SweepRecord::LEN,
        seeds = [
            b"fee_sweep",
            denominated_pool.key().as_ref(),
            &slot.to_le_bytes(),
        ],
        bump,
    )]
    pub sweep_record: Account<'info, SweepRecord>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(Default)]
pub struct SweepRecord {
    pub pool: Pubkey,
    pub slot: u64,
    pub amount: u64,
    /// First 16 bytes of the destination pubkey (full pubkey is in the tx
    /// accounts list — storing the prefix saves space and is enough for
    /// cross-referencing).
    pub destination_prefix: [u8; 16],
    pub bump: u8,
}

impl SweepRecord {
    pub const LEN: usize = 8 // discriminator
        + 32 // pool
        + 8  // slot
        + 8  // amount
        + 16 // destination_prefix
        + 1; // bump
}

pub fn handler(ctx: Context<SweepFeeEscrow>, amount: u64, slot: u64) -> Result<()> {
    // Validate the caller-supplied slot matches the current clock within a
    // small drift window. Slot must be recent (not arbitrary future grinding)
    // and not too stale (caller can't pick an old slot to bypass the per-slot
    // idempotency). 25 slots ≈ 10s, enough to absorb tx propagation jitter.
    let current_slot = Clock::get()?.slot;
    require!(
        slot <= current_slot && current_slot.saturating_sub(slot) <= 25,
        ZkShieldedError::SlotMismatch
    );

    let escrow = ctx.accounts.fee_escrow.to_account_info();
    let escrow_lamports = escrow.lamports();

    // Keep rent-exempt minimum on the escrow PDA so it stays alive (avoids
    // re-init cost on the next fee deposit). For SystemAccount with 0 data,
    // rent-exempt is ~890_880 lamports.
    let rent = Rent::get()?;
    let min_rent = rent.minimum_balance(0);

    require!(
        escrow_lamports.saturating_sub(min_rent) >= amount,
        ZkShieldedError::InsufficientPoolBalance
    );

    // 🚨 A CPI, NOT A DIRECT DEBIT, AND THE DIRECT DEBIT NEVER WORKED.
    //
    // This was `**escrow.try_borrow_mut_lamports()? -= amount;` and it failed on
    // chain every single time with "instruction spent from the balance of an
    // account it does not own". `fee_escrow` is declared `SystemAccount` above,
    // so the System Program owns it — and the runtime lets a program CREDIT an
    // account it does not own but never DEBIT one. Crediting is why
    // `shield_denominated_v3` and the two unshields could pay into this escrow
    // with a direct `+=` and look correct: the deposit half of the pattern is
    // legal and the withdrawal half is not.
    //
    // So the escrow has been a ONE-WAY SINK for as long as it has existed.
    // MEASURED 2026-08-26 on devnet: 0.268 SOL in the 1 SOL pool's escrow,
    // 0.0326 in the 0.1 pool's, and `scripts/sweep-fee-escrow.mjs` could not
    // recover a lamport of it. That is 0.5% of every withdrawal ever made,
    // permanently sunk, which turns the running cost of the whole system
    // negative in a way nobody had noticed because nothing ever tried to sweep.
    //
    // The escrow is a PDA of THIS program, so the program can sign for it: a
    // System Program transfer under `invoke_signed` moves the lamports and the
    // runtime is satisfied because the System Program owns the account it is
    // debiting. The rent floor above still applies — the transfer would fail on
    // its own rent check anyway, but failing our explicit `require!` first says
    // WHY.
    let pool_key = ctx.accounts.denominated_pool.key();
    let escrow_seeds: &[&[u8]] = &[
        FEE_ESCROW_SEED_PREFIX,
        pool_key.as_ref(),
        &[ctx.bumps.fee_escrow],
    ];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: escrow.clone(),
                to: ctx.accounts.destination.to_account_info(),
            },
            &[escrow_seeds],
        ),
        amount,
    )?;

    let dest_key = ctx.accounts.destination.key();
    let mut dest_prefix = [0u8; 16];
    dest_prefix.copy_from_slice(&dest_key.to_bytes()[..16]);

    let record = &mut ctx.accounts.sweep_record;
    record.pool = ctx.accounts.denominated_pool.key();
    record.slot = slot;
    record.amount = amount;
    record.destination_prefix = dest_prefix;
    record.bump = ctx.bumps.sweep_record;

    msg!(
        "fee_escrow swept: pool={} amount={} dest_prefix={:?}",
        record.pool,
        amount,
        &dest_prefix[..8]
    );

    Ok(())
}
