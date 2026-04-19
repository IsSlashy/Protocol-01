use anchor_lang::prelude::*;

/// Global liquidity pool state. Holds the shared SOL reserve that prefunds
/// instant unshields, tracks LP share accounting, and exposes fee/reward
/// parameters the admin can tune.
///
/// The pool PDA's lamport balance IS the reserve — no separate vault. The
/// `reserve_lamports` mirror exists so instruction handlers can compute
/// share price in one spot without re-reading account lamports every time;
/// deposit/withdraw/prefund/settle each keep the mirror in sync with the
/// actual lamport movements.
///
/// Share pricing:
///   share_price = (pool_lamports − rent_exempt_minimum) / total_shares
///
/// An LP who withdraws mid-cycle (after prefund, before settle) forgoes the
/// yield from that cycle — this is correct and keeps the accounting single-
/// sourced. The `prefund_fee − unshield_fee` spread accrues to LPs who are
/// still in the pool at the time of settlement.
#[account]
pub struct LiquidityPool {
    /// Admin authority (can update params, pause, etc).
    pub admin: Pubkey,

    /// Total LP shares outstanding.
    pub total_shares: u128,

    /// Mirror of the pool PDA's free lamports (total − rent_exempt_minimum).
    /// Kept in sync by every handler so share-math reads are O(1).
    pub reserve_lamports: u64,

    /// Prefund fee, in bps of denomination. Charged on top of zk_shielded's
    /// own 0.5% unshield fee. User receives
    /// `denomination − prefund_fee − settler_reward` at prefund time.
    pub prefund_fee_bps: u16,

    /// Settler reward, in bps of denomination. Paid to whoever calls `settle`
    /// — creates a permissionless keeper market so settlements happen without us.
    pub settler_reward_bps: u16,

    /// If false, no new prefunds can be opened (deposits/withdrawals still fine).
    pub is_active: bool,

    pub bump: u8,
}

impl LiquidityPool {
    pub const SEED_PREFIX: &'static [u8] = b"liquidity_pool";

    /// 8 disc + 32 admin + 16 shares + 8 reserve + 2 fee + 2 reward + 1 active + 1 bump
    pub const LEN: usize = 8 + 32 + 16 + 8 + 2 + 2 + 1 + 1;

    pub const MAX_PREFUND_FEE_BPS: u16 = 300;  // 3%
    pub const MAX_SETTLER_REWARD_BPS: u16 = 100; // 1%

    /// Shares minted for a deposit of `deposit_lamports`. Bootstrap: 1 share
    /// per lamport. Subsequent: pro-rata of current reserve.
    pub fn shares_for_deposit(&self, deposit_lamports: u64) -> Option<u128> {
        if self.total_shares == 0 || self.reserve_lamports == 0 {
            return Some(deposit_lamports as u128);
        }
        (deposit_lamports as u128)
            .checked_mul(self.total_shares)?
            .checked_div(self.reserve_lamports as u128)
    }

    /// Lamport payout when burning `shares`.
    pub fn lamports_for_shares(&self, shares: u128) -> Option<u64> {
        if self.total_shares == 0 || shares == 0 {
            return Some(0);
        }
        let out = shares
            .checked_mul(self.reserve_lamports as u128)?
            .checked_div(self.total_shares)?;
        u64::try_from(out).ok()
    }
}
