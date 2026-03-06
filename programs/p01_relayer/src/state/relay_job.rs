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
#[account]
pub struct RelayJob {
    /// Unique job identifier (32 bytes)
    pub job_id: [u8; 32],

    /// Encrypted serialized transaction (max ~1232 bytes)
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
}

/// Maximum size of the encrypted transaction payload.
/// Solana transaction max size is 1232 bytes; encrypted form may be slightly larger
/// due to nonce/tag overhead (24 + 16 = 40 bytes for XChaCha20-Poly1305).
pub const MAX_ENCRYPTED_TX_SIZE: usize = 1280;

impl RelayJob {
    pub const SEED_PREFIX: &'static [u8] = b"relay_job";

    pub const LEN: usize = 8    // discriminator
        + 32   // job_id
        + 4 + MAX_ENCRYPTED_TX_SIZE  // encrypted_tx Vec (4-byte length prefix + max payload)
        + 32   // assigned_relayer
        + 32   // submitter
        + 8    // fee_lamports
        + 8    // posted_at_slot
        + 8    // deadline_slot
        + 1    // status (u8 enum)
        + 1;   // bump

    /// Check whether this job has expired based on the current slot.
    pub fn is_expired(&self, current_slot: u64) -> bool {
        current_slot > self.deadline_slot && self.status as u8 == JobStatus::Pending as u8
    }
}
