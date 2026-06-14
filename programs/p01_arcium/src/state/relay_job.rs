use anchor_lang::prelude::*;

/// Status lifecycle of a confidential relay job (Alt 1 — recipient-only MPC).
///
/// ```text
///                     submit_confidential_relay
///                              |
///                              v
///                          [Pending]
///                              |
///                  queue_computation(decrypt_recipient)
///                              |
///                              v
///                       [Decrypted]   <- off-chain executor picks up here
///                              |
///                              v
///                       [Submitted]
/// ```
///
/// `Expired` is set by a permissionless GC after `deadline_slot`
/// (analogous to `expire_pending_job` in `p01_relayer`).
///
/// The intermediate `Decrypting` variant from the maximal scaffold is
/// retained for backward-compat of the discriminator layout but is no
/// longer reachable: Alt 1 issues a single `queue_computation` per
/// submit, so the callback transitions `Pending → Decrypted` directly.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum RelayJobStatus {
    Pending = 0,
    Decrypting = 1,
    Decrypted = 2,
    Submitted = 3,
    Expired = 4,
    Failed = 5,
}

impl Default for RelayJobStatus {
    fn default() -> Self {
        RelayJobStatus::Pending
    }
}

/// Confidential relay job — Phase D Alt 1 (recipient-only MPC sidecar).
///
/// The Phase D goal is to hide the unshield recipient from the off-chain
/// relayer service until an Arcium MXE cluster threshold-decrypts it.
/// Everything else about the unshield (amount, nullifier, root, STARK
/// proof) keeps flowing through the existing `p01_relayer` (Phase A,
/// shipped) — Phase D Alt 1 is a sidecar, not a replacement.
///
/// The encrypted payload is exactly the 32-byte recipient pubkey,
/// encoded as 4 u64 fields (matching `TxChunk` in encrypted-ixs). The
/// `relayer_job_id` links this MPC sidecar to the matching Phase A
/// `RelayJob` PDA in `p01_relayer`. After the callback fires and
/// `decrypted_recipient` is populated, the existing relayer worker
/// joins the two and broadcasts the unshield.
#[account]
#[derive(Default)]
pub struct RelayJob {
    /// Account that submitted the job and paid rent. Receives the rent +
    /// `fee` refund on `expire_relay_job` (permissionless GC after
    /// `deadline_slot`).
    pub submitter: Pubkey,

    /// Lifecycle state — see [`RelayJobStatus`].
    pub status: RelayJobStatus,

    /// PDA of the matching Phase A `p01_relayer::RelayJob` that carries
    /// the rest of the unshield payload (amount, nullifier, root, proof).
    /// The off-chain executor joins this MPC sidecar to that Phase A
    /// job after the recipient is decrypted.
    pub relayer_job_id: Pubkey,

    /// The 4 X25519-encrypted u64 chunks of the recipient pubkey, in
    /// little-endian order. Submitted in plaintext-equivalent shape so
    /// that one `queue_computation(decrypt_recipient)` call can decrypt
    /// the whole pubkey at once (the MXE circuit batches 8 u64 per
    /// call; we use 4 and ignore the trailing 4 — see encrypted-ixs).
    pub encrypted_recipient: [[u8; 32]; 4],

    /// Populated by `decrypt_recipient_callback` once the MPC reveals
    /// the plaintext. Zeroed pre-decrypt. Off-chain executor reads from
    /// here (or from the `RecipientDecrypted` event).
    pub decrypted_recipient: [u8; 32],

    /// X25519 ephemeral public key the SDK used for the encryption (so
    /// the MXE derives the shared secret on its side).
    pub encryption_pubkey: [u8; 32],

    /// 16-byte AEAD nonce, encoded as u128 LE (Arcium convention).
    pub nonce: u128,

    /// Fee offered to the relayer cluster (lamports). Held in the PDA's
    /// lamports balance until the job completes or expires.
    pub fee: u64,

    /// Slot after which a permissionless GC can mark the job `Expired`
    /// and refund rent + fee to `submitter`.
    pub deadline_slot: u64,

    /// Slot the job was posted at — used for liveness / age checks.
    pub posted_at_slot: u64,

    /// PDA bump.
    pub bump: u8,
}

impl RelayJob {
    /// Seed: `[b"p01_arcium_relay", computation_offset_le_bytes(8)]`.
    /// Mirrors the off-chain SDK derivation in
    /// `arcium-sdk/src/relay/index.ts`.
    pub const SEED_PREFIX: &'static [u8] = b"p01_arcium_relay";

    /// Account size for the Alt 1 fixed-shape struct. Layout:
    ///
    /// ```text
    ///   8  disc
    ///  32  submitter
    ///   1  status
    ///  32  relayer_job_id
    /// 128  encrypted_recipient (4 × 32)
    ///  32  decrypted_recipient
    ///  32  encryption_pubkey
    ///  16  nonce
    ///   8  fee
    ///   8  deadline_slot
    ///   8  posted_at_slot
    ///   1  bump
    /// ```
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 128 + 32 + 32 + 16 + 8 + 8 + 8 + 1;
}
