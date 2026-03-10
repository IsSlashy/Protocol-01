use anchor_lang::prelude::*;

/// Protocol fee configuration — hardcoded for security.
///
/// Fee wallet: BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN
/// Shield fee: 0.3% (30 basis points)
/// Unshield fee: 0.5% (50 basis points)
pub const PROTOCOL_FEE_WALLET: Pubkey = Pubkey::new_from_array([
    0x9a, 0xef, 0xbc, 0xf9, 0x06, 0x95, 0x58, 0x0f,
    0x6f, 0x96, 0x19, 0xeb, 0x7b, 0x6c, 0xd6, 0x3a,
    0xcd, 0xc6, 0x66, 0x1b, 0xd3, 0xed, 0xfb, 0x93,
    0xb7, 0x75, 0x23, 0x24, 0x5e, 0xb4, 0xa0, 0xcf,
]);

/// Shield fee: 30 basis points (0.3%)
pub const SHIELD_FEE_BPS: u64 = 30;

/// Unshield fee: 50 basis points (0.5%)
pub const UNSHIELD_FEE_BPS: u64 = 50;

/// Basis points denominator
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Calculate fee amount from denomination and basis points.
/// Returns (fee, net_amount) where net_amount = denomination - fee.
pub fn calculate_fee(denomination: u64, fee_bps: u64) -> (u64, u64) {
    let fee = denomination
        .checked_mul(fee_bps)
        .unwrap_or(0)
        / BPS_DENOMINATOR;
    let net = denomination.saturating_sub(fee);
    (fee, net)
}
