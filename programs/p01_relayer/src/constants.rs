//! Protocol-wide constants for p01_relayer.
//!
//! Refund pipeline (sprint 2026-05-11):
//! Residual lamports from cancelled private subscriptions are routed to a
//! `RefundJob` PDA, where a permissionless keeper later shields them into the
//! recipient's stealth note. These constants govern the keeper incentive and
//! the deadline after which a RefundJob can be expired.

/// Lamports paid to the keeper that successfully calls `process_refund_job`.
/// 0.00005 SOL ~ a few cents — well under the smallest residual we'd ever
/// route (REFUND_MIN_RESIDUAL = 100_000 lamports).
pub const REFUND_KEEPER_FEE: u64 = 50_000;

/// Below this residual, zk_shielded's cancel handler forfeits the dust
/// instead of opening a RefundJob (rent + keeper fee would dominate).
/// Mirrored here so p01_relayer callers can sanity-check before submit.
pub const REFUND_MIN_RESIDUAL: u64 = 100_000;

/// Slots a RefundJob stays in `Pending` before anyone can expire it.
/// ~1 day @ 200 ms/slot. After expiry, the original payer can reclaim rent
/// + remaining lamports via `expire_refund_job`.
pub const REFUND_DEADLINE_SLOTS: u64 = 432_000;
