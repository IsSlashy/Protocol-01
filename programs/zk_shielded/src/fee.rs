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

/// Relayer reward, in lamports, taken OUT OF THE NOTE on the relayed spend
/// path (`unshield_denominated_stark_v4_relayed`). Zero on every other path.
///
/// # Why this is a constant and not an instruction argument
///
/// Circuit 7 binds the RECIPIENT in `public_inputs_hash`, so a relayer cannot
/// re-point the payout. It does NOT bind the amount — the split is computed
/// here, on chain. A caller-supplied reward would therefore let whoever
/// submits the transaction skim the note down to dust while the proof still
/// verified: the exact shape of defect v4 just closed on the recipient, moved
/// one field over. It is a constant so that the worst a hostile submitter can
/// take is this number.
///
/// # Why this number
///
/// MEASURED on devnet 2026-08-28. Two costs, and the first version of this
/// constant counted only the cheap one:
///
/// | | |
/// |---|---|
/// | `NullifierRecord` rent (41 B) | **1,176,240 lamports (0.00118 SOL), PERMANENT** |
/// | ~84 signatures at 5,000 | 420,000 lamports |
/// | proof buffer rent (78 KB) | 544,104,960 (0.5441 SOL) — **returned** on close |
///
/// 🚨 THE NULLIFIER RENT NEVER COMES BACK. `NullifierRecord` is created with
/// `init, payer = payer` and nothing closes it — it has to outlive the spend
/// forever or the note is spendable twice. On the direct path the buyer's
/// ephemeral pays it and eats it; on the relayed path the RELAYER pays it, so
/// the reward has to reimburse it or every relay is a guaranteed loss.
///
/// The first value here was 1,000,000, costed against the proof buffer rent —
/// which is working capital and returns, and was ALSO written a thousand times
/// too small in lamports — while missing the 1,176,240 that
/// does not. That made each relay lose 596,240 lamports. Found by review
/// before deployment, not by a relayer going broke.
///
/// Real cost is therefore 1,596,240. This is ~1.57x that, which covers
/// priority fees and the occasional retry.
///
/// ⚠️ Flat, not basis points, because the cost is flat — a nullifier record is
/// 41 bytes whatever the note is worth. On the 1 SOL pool that is 0.25% of the
/// note, alongside the 0.5% protocol fee. On the 0.1 SOL pool it is 2.5%, and
/// that is stated here rather than hidden inside a rate: not naming the payer
/// costs more, proportionally, on a small note.
pub const RELAYER_REWARD_LAMPORTS: u64 = 2_500_000;

/// Basis points denominator
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Calculate fee amount from denomination and basis points.
/// Returns (fee, net_amount) where net_amount = denomination - fee.
///
/// Audit 2026-04-01 HIGH #3: the previous implementation used
/// `denomination.checked_mul(fee_bps).unwrap_or(0)` which silently zeroed the
/// fee for extreme denominations (`denomination * fee_bps` > 2^64). That would
/// let an attacker construct a giant-denomination pool that pays no protocol
/// fee at all. Widening to u128 makes overflow impossible for any u64 inputs:
/// `2^64 * 2^64 = 2^128`, which the intermediate u128 represents exactly. The
/// final divided-down result always fits back into u64 because
/// `fee = denomination * fee_bps / 10_000 <= denomination`.
pub fn calculate_fee(denomination: u64, fee_bps: u64) -> (u64, u64) {
    let fee_u128 = (denomination as u128)
        .saturating_mul(fee_bps as u128)
        / (BPS_DENOMINATOR as u128);
    // fee <= denomination (since fee_bps <= BPS_DENOMINATOR in all callers),
    // so the cast back to u64 is lossless. Clamp defensively in case a future
    // caller passes fee_bps > BPS_DENOMINATOR.
    let fee = fee_u128.min(denomination as u128) as u64;
    let net = denomination.saturating_sub(fee);
    (fee, net)
}

/// Derive the per-pool fee_escrow PDA address (off-chain helper, mirrors the
/// `seeds = [FEE_ESCROW_SEED_PREFIX, pool.key().as_ref()]` constraint in the
/// V3 instruction account structs).
pub fn derive_fee_escrow(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[FEE_ESCROW_SEED_PREFIX, pool.as_ref()], &crate::ID)
}
