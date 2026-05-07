use anchor_lang::prelude::*;

/// Status lifecycle of a confidential relay job.
///
/// The flow is intentionally explicit so that the off-chain Arcium executor
/// (or any third party with the matching capability) can observe the PDA
/// state and act idempotently:
///
/// ```text
///                     submit_confidential_relay
///                              |
///                              v
///                          [Pending]
///                              |
///                  queue_decrypt_chunk (per ciphertext)
///                              |
///                              v
///                       [Decrypting]
///                              |
///                  N callbacks fire — chunks_decrypted == chunk_count
///                              |
///                              v
///                       [Decrypted]   <- off-chain executor picks up here
///                              |
///                              v
///                       [Submitted]
/// ```
///
/// `Expired` is set by a permissionless GC after `deadline_slot` (analogous
/// to `expire_pending_job` in `p01_relayer`).
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

/// Confidential relay job — Phase D scaffold (2026-05-07).
///
/// Stores the encrypted transaction chunks that an Arcium MPC cluster will
/// jointly decrypt. The user's wallet never appears as fee payer on the
/// final relayed tx — the MXE outputs a threshold-EdDSA-signed payload (or
/// emits the decrypted tx bytes for an off-chain executor; the integration
/// path is TBD and gated behind an Arcium feature).
///
/// **Scaffold status (2026-05-07)**: this struct + `submit_confidential_relay`
/// ix create the PDA and store the encrypted payload. The MPC orchestration
/// (per-chunk `threshold_decrypt` queue + reassembly callback + relayed-tx
/// forwarder) is intentionally NOT implemented yet — see the TODOs in
/// `submit_confidential_relay.rs`. The SDK at `arcium-sdk/src/relay/index.ts`
/// can now reach the program without `InstructionFallbackNotFound`, but
/// `awaitRelayCompletion` will still time out until orchestration ships.
#[account]
#[derive(Default)]
pub struct RelayJob {
    /// Account that submitted the job and paid rent. Receives rent refund
    /// on `expire_relay_job` (permissionless GC after deadline_slot).
    pub submitter: Pubkey,

    /// Lifecycle state — see `RelayJobStatus` doc above.
    pub status: RelayJobStatus,

    /// Number of encrypted chunks that were submitted. Each chunk is 32
    /// bytes (one 8-byte plaintext word encrypted to 32 bytes via the
    /// MXE's X25519 pubkey).
    pub chunk_count: u16,

    /// Number of chunks the MPC has decrypted so far. Reaches `chunk_count`
    /// when ready for `Decrypted` transition.
    pub chunks_decrypted: u16,

    /// X25519 ephemeral public key the SDK used for the encryption (so the
    /// MXE can derive the shared secret on its side).
    pub encryption_pubkey: [u8; 32],

    /// 16-byte AEAD nonce, encoded as u128 LE (Arcium convention).
    pub nonce: u128,

    /// Original (unpadded) length of the serialized inner transaction. Used
    /// when reassembling chunks back into bytes (last chunk may be padded).
    pub original_tx_len: u32,

    /// Fee offered to the relayer cluster (lamports). Held in the PDA's
    /// lamports balance until the job either completes or expires.
    pub fee: u64,

    /// Slot after which a permissionless GC can mark the job `Expired` and
    /// refund rent + fee to `submitter`.
    pub deadline_slot: u64,

    /// Slot the job was posted at — used for liveness / age checks.
    pub posted_at_slot: u64,

    /// PDA bump.
    pub bump: u8,

    /// Encrypted chunks. Each is 32 bytes (one MXE-encrypted u8 field
    /// element wrapper). Variable length; on-chain space is computed from
    /// `chunk_count` at init time.
    pub encrypted_chunks: Vec<[u8; 32]>,
}

impl RelayJob {
    /// Seed: [b"p01_arcium_relay", computation_offset_le_bytes(8)].
    /// Mirrors the off-chain SDK derivation in `arcium-sdk/src/relay/index.ts`.
    pub const SEED_PREFIX: &'static [u8] = b"p01_arcium_relay";

    /// Account size for `chunk_count` chunks. Matches the `space =` annotation
    /// on the `init` constraint. Layout:
    ///
    ///   8  disc
    ///  32  submitter
    ///   1  status
    ///   2  chunk_count
    ///   2  chunks_decrypted
    ///  32  encryption_pubkey
    ///  16  nonce
    ///   4  original_tx_len
    ///   8  fee
    ///   8  deadline_slot
    ///   8  posted_at_slot
    ///   1  bump
    ///   4  encrypted_chunks (Vec<...> length prefix)
    ///  N×32 encrypted_chunks data
    pub fn space(chunk_count: u16) -> usize {
        8 + 32 + 1 + 2 + 2 + 32 + 16 + 4 + 8 + 8 + 8 + 1 + 4 + (chunk_count as usize) * 32
    }

    /// Maximum chunk count we accept on-chain. Cap = 256 chunks of 8 bytes
    /// plaintext each = 2048 bytes max plaintext tx, comfortably above the
    /// Solana inner-tx cap (1232 bytes). Prevents griefing via huge PDA
    /// allocations.
    pub const MAX_CHUNK_COUNT: u16 = 256;
}
