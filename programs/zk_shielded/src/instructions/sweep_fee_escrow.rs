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
            &Clock::get()?.slot.to_le_bytes(),
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

pub fn handler(ctx: Context<SweepFeeEscrow>, amount: u64) -> Result<()> {
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

    **escrow.try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.destination.try_borrow_mut_lamports()? += amount;

    let dest_key = ctx.accounts.destination.key();
    let mut dest_prefix = [0u8; 16];
    dest_prefix.copy_from_slice(&dest_key.to_bytes()[..16]);

    let record = &mut ctx.accounts.sweep_record;
    record.pool = ctx.accounts.denominated_pool.key();
    record.slot = Clock::get()?.slot;
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
