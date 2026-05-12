use anchor_lang::prelude::*;

/// Refund job for a cancelled private subscription.
///
/// Created via CPI by `zk_shielded::cancel_private_stark` (new path, vault
/// has `client_stealth_meta`). The cancel handler transfers the residual
/// lamports into this PDA. A permissionless keeper later calls
/// `process_refund_job` to shield the funds into the target pool as a
/// stealth-encrypted note for the original subscriber.
///
/// PDA seeds: [b"refund_job", source_vault.as_ref()]
/// One RefundJob per cancelled vault — re-init is impossible until the
/// account is closed (via `process_refund_job` or `expire_refund_job`).
///
/// Wrapped in `Box<Account<...>>` at every ix site — the 64-byte
/// `stealth_meta` plus the 32-byte pubkeys push the deserialised account
/// well over the comfort zone for the 4096-byte SBF stack frame.
#[account]
pub struct RefundJob {
    /// Source vault PDA (subscription vault that was cancelled).
    /// Also the PDA seed: one RefundJob per vault.
    pub source_vault: Pubkey,

    /// Stealth meta-address v1 for the original subscriber:
    /// `[spending_pub(32) | viewing_pub(32)]`. Mirrored from the vault.
    pub stealth_meta: [u8; 64],

    /// Pool the keeper will shield into. Validated at process time
    /// against the `denominated_pool` account passed by the keeper.
    pub target_pool: Pubkey,

    /// Merkle tree associated with `target_pool`. Validated identically.
    pub target_tree: Pubkey,

    /// Residual lamports transferred into this PDA at submit time
    /// (full residual; keeper fee is deducted at process time).
    pub amount: u64,

    /// Lamports paid to the keeper that processes the job. Frozen at
    /// submit time so a keeper-fee constant bump doesn't retroactively
    /// over-pay or under-pay existing jobs.
    pub keeper_fee_lamports: u64,

    /// Slot when the RefundJob was created.
    pub created_at_slot: u64,

    /// Slot after which the job can be expired by anyone.
    pub deadline_slot: u64,

    /// Original payer (subscriber). Receives rent + remaining lamports
    /// on `expire_refund_job`. Tracked explicitly because the PDA may
    /// already be holding `amount` lamports beyond rent.
    pub original_payer: Pubkey,

    /// 0 = Pending, 1 = Completed, 2 = Expired.
    pub status: u8,

    /// PDA bump.
    pub bump: u8,
}

impl RefundJob {
    pub const SEED_PREFIX: &'static [u8] = b"refund_job";

    /// Account size:
    ///   8   discriminator
    /// + 32  source_vault
    /// + 64  stealth_meta
    /// + 32  target_pool
    /// + 32  target_tree
    /// + 8   amount
    /// + 8   keeper_fee_lamports
    /// + 8   created_at_slot
    /// + 8   deadline_slot
    /// + 32  original_payer
    /// + 1   status
    /// + 1   bump
    /// = 234 bytes
    ///
    /// NOTE: contract section C spec'd LEN = 202 with no `original_payer`
    /// field. We added `original_payer` (per task instruction "track payer
    /// in RefundJob struct if needed — add `pub original_payer: Pubkey` to
    /// struct") because `expire_refund_job` needs a verifiable target for
    /// the close = payer pattern; otherwise any caller could supply an
    /// arbitrary recipient.
    pub const LEN: usize = 8 + 32 + 64 + 32 + 32 + 8 + 8 + 8 + 8 + 32 + 1 + 1; // 234

    pub const STATUS_PENDING: u8 = 0;
    pub const STATUS_COMPLETED: u8 = 1;
    pub const STATUS_EXPIRED: u8 = 2;
}
