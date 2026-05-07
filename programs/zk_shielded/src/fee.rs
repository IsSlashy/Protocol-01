use anchor_lang::prelude::*;

/// Legacy hardcoded protocol fee wallet (V2 paths only).
///
/// Address: BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN
///
/// V3 paths (`shield_denominated_v3`, `unshield_denominated_stark_v3`) MIGRATED
/// to per-pool `fee_escrow` PDAs. See `derive_fee_escrow` below. The constant
/// stays for V2 backward compat during the deprecation window.
pub const PROTOCOL_FEE_WALLET: Pubkey = Pubkey::new_from_array([
    0x9a, 0xef, 0xbc, 0xf9, 0x06, 0x95, 0x58, 0x0f,
    0x6f, 0x96, 0x19, 0xeb, 0x7b, 0x6c, 0xd6, 0x3a,
    0xcd, 0xc6, 0x66, 0x1b, 0xd3, 0xed, 0xfb, 0x93,
    0xb7, 0x75, 0x23, 0x24, 0x5e, 0xb4, 0xa0, 0xcf,
]);

/// Treasury authority — only this signer can call `sweep_fee_escrow` to drain
/// accumulated fees out of any `fee_escrow` PDA. Set to admin/devnet key.
///
/// Address: 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU (devnet admin)
///
/// Mainnet TODO: rotate to a multisig or governance-controlled key before launch.
pub const TREASURY_AUTHORITY: Pubkey = Pubkey::new_from_array([
    0x63, 0x45, 0x7f, 0xc3, 0xeb, 0xa4, 0x0e, 0x69,
    0x13, 0x9c, 0xea, 0xa0, 0xaa, 0x19, 0x96, 0xa4,
    0x9d, 0xe9, 0xae, 0x35, 0x37, 0x16, 0x3e, 0x16,
    0xb0, 0xb8, 0x42, 0xda, 0xd8, 0xdd, 0x62, 0xd7,
]);

/// Seed prefix for the per-pool `fee_escrow` PDA.
/// Full seed: `[FEE_ESCROW_SEED_PREFIX, pool.key().as_ref()]` under `zk_shielded`.
///
/// Privacy property: the escrow address is fully determined by the pool —
/// independent of depositor / recipient / amount. An indexer who fetches the
/// V3 unshield tx sees `recipient: <user-or-claim-PDA>` and `fee_escrow: <pool-derived>`.
/// Cross-pool linkability of fee revenue is broken (each pool has its own
/// escrow). Per-tx fee delta on the escrow is still correlatable with the
/// unshield amount within the same pool, which is closed by Phase E.2 (timing
/// decorrelation via batched sweep).
pub const FEE_ESCROW_SEED_PREFIX: &[u8] = b"fee_escrow";

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

/// Derive the per-pool fee_escrow PDA address (off-chain helper, mirrors the
/// `seeds = [FEE_ESCROW_SEED_PREFIX, pool.key().as_ref()]` constraint in the
/// V3 instruction account structs).
pub fn derive_fee_escrow(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[FEE_ESCROW_SEED_PREFIX, pool.as_ref()], &crate::ID)
}
