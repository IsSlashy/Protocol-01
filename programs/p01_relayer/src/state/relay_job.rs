use anchor_lang::prelude::*;

/// Status of a relay job.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum JobStatus {
    Pending = 0,
    Completed = 1,
    Expired = 2,
    Cancelled = 3,
}

impl Default for JobStatus {
    fn default() -> Self {
        JobStatus::Pending
    }
}

/// An encrypted relay job submitted by a privacy-seeking user.
/// The relayer decrypts and submits the transaction on behalf of the submitter.
///
/// PDA seeds: [b"relay_job", job_id.as_ref()]
///
/// Two modes :
/// - **Legacy single-shot** (`total_chunks == 0`) : `encrypted_tx` carries the
///   full ciphertext inline. Used for tiny txs (memos) that fit the 1232-byte
///   Solana submit_job tx cap.
/// - **Chunked** (`total_chunks > 0`) : `encrypted_tx` is empty. Ciphertext
///   bytes live in N `RelayChunk` PDAs (one per chunk_index). Worker
///   reassembles before decrypt. Unlocks oversize V3 inner txs (~947B+) and
///   v2 hybrid ML-KEM-768 envelope (1161B overhead).
#[account]
pub struct RelayJob {
    /// Unique job identifier (32 bytes)
    pub job_id: [u8; 32],

    /// Encrypted serialized transaction (legacy mode only).
    /// Empty when `total_chunks > 0` — chunks live in `RelayChunk` PDAs.
    pub encrypted_tx: Vec<u8>,

    /// Relayer node PDA assigned to this job
    pub assigned_relayer: Pubkey,

    /// Ephemeral keypair that posted the job
    pub submitter: Pubkey,

    /// Fee deposited (in lamports)
    pub fee_lamports: u64,

    /// Slot when the job was posted
    pub posted_at_slot: u64,

    /// Must be completed by this slot
    pub deadline_slot: u64,

    /// Current job status
    pub status: JobStatus,

    /// PDA bump seed
    pub bump: u8,

    /// Number of chunks expected in chunked mode. 0 = legacy single-shot.
    /// Worker waits for `chunks_received == total_chunks` before decrypt.
    pub total_chunks: u16,

    /// Chunks already received (incremented by `submit_chunk`).
    pub chunks_received: u16,

    /// Encryption envelope version: 1 = X25519, 2 = X25519+ML-KEM-768 hybrid.
    /// Only chunked mode unlocks v2 (overhead too large for legacy single-shot).
    pub encryption_version: u8,
}

/// Maximum size of the encrypted transaction payload (legacy mode).
/// Solana transaction max size is 1232 bytes; encrypted form may be slightly larger
/// due to nonce/tag overhead (24 + 16 = 40 bytes for XChaCha20-Poly1305).
pub const MAX_ENCRYPTED_TX_SIZE: usize = 1280;

/// Maximum bytes per chunk in chunked mode. Sized to fit a single submit_chunk
/// tx within the 1232-byte Solana cap with reasonable overhead headroom.
///
/// Per-tx breakdown (submit_chunk) :
///   sig + header + 3 keys (signer, job, system_prog) + blockhash + ix data
///   = 64 + 3 + 96 + 32 + (8 disc + 32 jobId + 2 idx + 4 len) = 241B fixed.
/// → 1232 - 241 = 991 bytes available for chunk data.
pub const MAX_CHUNK_DATA_SIZE: usize = 990;

impl RelayJob {
    pub const SEED_PREFIX: &'static [u8] = b"relay_job";

    pub const LEN: usize = 8    // discriminator
        + 32   // job_id
        + 4 + MAX_ENCRYPTED_TX_SIZE  // encrypted_tx Vec (legacy mode max payload)
        + 32   // assigned_relayer
        + 32   // submitter
        + 8    // fee_lamports
        + 8    // posted_at_slot
        + 8    // deadline_slot
        + 1    // status (u8 enum)
        + 1    // bump
        + 2    // total_chunks
        + 2    // chunks_received
        + 1;   // encryption_version

    /// Check whether this job has expired based on the current slot.
    pub fn is_expired(&self, current_slot: u64) -> bool {
        current_slot > self.deadline_slot && self.status as u8 == JobStatus::Pending as u8
    }

    /// True when chunked mode and all chunks have been received.
    pub fn chunks_complete(&self) -> bool {
        self.total_chunks > 0 && self.chunks_received == self.total_chunks
    }

    /// True when the job is ready for the worker to decrypt + execute.
    pub fn ready_for_pickup(&self) -> bool {
        match self.status as u8 {
            x if x == JobStatus::Pending as u8 => {
                // Legacy: encrypted_tx populated.
                if self.total_chunks == 0 {
                    !self.encrypted_tx.is_empty()
                } else {
                    self.chunks_complete()
                }
            }
            _ => false,
        }
    }
}

/// A single chunk of an encrypted relay-job ciphertext.
/// Created by `submit_chunk`, read by the worker after `chunks_complete()`.
///
/// PDA seeds: [b"relay_chunk", job_id.as_ref(), &chunk_index.to_le_bytes()]
#[account]
pub struct RelayChunk {
    /// Job this chunk belongs to (binds to RelayJob.job_id)
    pub job_id: [u8; 32],
    /// 0-indexed chunk position; must be < RelayJob.total_chunks
    pub chunk_index: u16,
    /// Raw ciphertext bytes for this chunk (no length prefix — Vec<u8> handles it)
    pub data: Vec<u8>,
    /// PDA bump
    pub bump: u8,
}

impl RelayChunk {
    pub const SEED_PREFIX: &'static [u8] = b"relay_chunk";

    pub const LEN: usize = 8                        // discriminator
        + 32                                         // job_id
        + 2                                          // chunk_index
        + 4 + MAX_CHUNK_DATA_SIZE                    // data Vec
        + 1;                                          // bump
}
