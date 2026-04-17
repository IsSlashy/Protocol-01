use anchor_lang::prelude::*;

/// Maximum number of hops in a privacy route.
/// A hop is a single shield -> transfer -> unshield cycle through a pool.
/// 10 hops provides strong unlinkability even against statistical analysis.
pub const MAX_ROUTE_HOPS: usize = 10;

/// Maximum split factor per route (matches split_note_stark::MAX_SPLIT_OUTPUTS).
/// A single high-denomination note can be split into at most 20
/// lower-denomination notes in one instruction.
pub const MAX_SPLIT_OUTPUTS: usize = 20;

/// On-chain state for tracking a privacy route.
///
/// Created by the client when starting a routed send. The route represents
/// a multi-hop privacy-preserving transfer where value moves through one or
/// more intermediate pools to break the on-chain link between sender and
/// recipient.
///
/// ## Design rationale
///
/// Encrypted route data (intermediate note secrets, nullifier preimages,
/// recipient addresses) is stored **off-chain** in the device's SecureStore.
/// This account only tracks completion status so the client can:
///
/// 1. **Resume routes across app restarts** — if the app crashes mid-route,
///    the client reads this PDA to determine which hops have completed and
///    picks up from there.
///
/// 2. **Prevent duplicate execution** — the `status` field prevents a route
///    from being executed twice after completion.
///
/// 3. **Allow cancellation** — if a route stalls (e.g., RPC failure), the
///    authority can mark it cancelled so the client knows to recover funds
///    via emergency unshield.
///
/// ## Security properties
///
/// - **Authority-gated**: Only the spending key holder (authority) can
///   update or close this account. The authority is derived from the
///   spending key, never from a viewing key.
///
/// - **No sensitive data**: This account stores no secrets — no nullifier
///   preimages, no note secrets, no recipient addresses. All sensitive
///   route data lives in encrypted off-chain storage.
///
/// - **Route ID uniqueness**: The `route_id` is derived from
///   `hash(spending_key || nonce)` so it's unique per user per route
///   and cannot be correlated to the spending key without knowledge of it.
///
/// ## PDA seeds
///
/// `[b"privacy_route", authority, route_id]`
#[account]
pub struct PrivacyRoute {
    /// Owner (spending key holder) — only they can update/close this account.
    /// This is the public key derived from the user's spending key.
    pub authority: Pubkey,

    /// Unique route ID, derived from `hash(spending_key || nonce)`.
    /// Ensures each route has a unique PDA and prevents collisions
    /// when the same user runs multiple routes concurrently.
    pub route_id: [u8; 32],

    /// Source pool key — the pool where the initial note is consumed.
    /// For same-denomination routes, this equals `target_pool`.
    pub source_pool: Pubkey,

    /// Target pool key — the pool where final output notes are created.
    /// For cross-denomination splits, this differs from `source_pool`.
    pub target_pool: Pubkey,

    /// Total number of hops planned for this route.
    /// Each hop is a shield/transfer/unshield cycle through a pool.
    /// Must be <= MAX_ROUTE_HOPS (10).
    pub total_hops: u8,

    /// Number of hops that have been successfully completed.
    /// The client increments this after each hop's transaction confirms.
    /// Route is completable when `completed_hops == total_hops`.
    pub completed_hops: u8,

    /// Total number of split outputs expected.
    /// For a simple route (no split), this equals 1.
    /// For a split route, this is the `num_outputs` from the split_note
    /// instruction (1..=20).
    pub total_outputs: u8,

    /// Number of outputs that have been successfully unshielded to the
    /// recipient. Once `completed_outputs == total_outputs`, the route
    /// is fully settled and can be marked STATUS_COMPLETED.
    pub completed_outputs: u8,

    /// Unix timestamp when this route PDA was created.
    pub created_at: i64,

    /// Unix timestamp of the most recent hop completion.
    /// Used by the client to detect stalled routes (e.g., if
    /// `last_hop_at` was more than 1 hour ago and the route is
    /// still active, prompt the user to retry or cancel).
    pub last_hop_at: i64,

    /// Route status:
    /// - 0 = active (in progress)
    /// - 1 = completed (all hops + outputs done)
    /// - 2 = cancelled (user or system abort)
    pub status: u8,

    /// Privacy level (1-5) selected by the user.
    /// Determines routing behavior:
    /// - 1: Direct (1 hop, no split)
    /// - 2: Single intermediate pool (2 hops)
    /// - 3: Two intermediate pools (3 hops)
    /// - 4: Three intermediates + random delays
    /// - 5: Max hops + split + random delays + decoy transactions
    pub privacy_level: u8,

    /// PDA bump seed.
    pub bump: u8,
}

impl PrivacyRoute {
    /// PDA seed prefix.
    pub const SEED_PREFIX: &'static [u8] = b"privacy_route";

    /// Account size: discriminator + all fields.
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // route_id
        + 32  // source_pool
        + 32  // target_pool
        + 1   // total_hops
        + 1   // completed_hops
        + 1   // total_outputs
        + 1   // completed_outputs
        + 8   // created_at
        + 8   // last_hop_at
        + 1   // status
        + 1   // privacy_level
        + 1;  // bump

    /// Route is in progress and can accept more hops.
    pub const STATUS_ACTIVE: u8 = 0;
    /// All hops and outputs are complete — funds have reached the recipient.
    pub const STATUS_COMPLETED: u8 = 1;
    /// Route was cancelled before completion — funds should be recovered
    /// via emergency unshield of any in-flight notes.
    pub const STATUS_CANCELLED: u8 = 2;

    /// Returns true if the route is still active (not completed or cancelled).
    pub fn is_active(&self) -> bool {
        self.status == Self::STATUS_ACTIVE
    }

    /// Returns true if all planned hops have been completed.
    pub fn all_hops_done(&self) -> bool {
        self.completed_hops >= self.total_hops
    }

    /// Returns true if all outputs have been unshielded to the recipient.
    pub fn all_outputs_done(&self) -> bool {
        self.completed_outputs >= self.total_outputs
    }

    /// Returns true if the route is fully settled: all hops done AND
    /// all outputs unshielded. The client should mark it STATUS_COMPLETED
    /// after this returns true.
    pub fn is_fully_settled(&self) -> bool {
        self.all_hops_done() && self.all_outputs_done()
    }
}
