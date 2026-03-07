use anchor_lang::prelude::*;

/// Commit-then-reveal record for quantum-safe transaction authorization
///
/// Two-phase protocol:
/// 1. COMMIT: User submits H(action || nonce) on-chain
/// 2. REVEAL: User reveals action + nonce, program verifies hash match
///
/// A quantum attacker who breaks Ed25519 from the COMMIT tx signature
/// still cannot forge the committed hash (SHA-256 preimage resistance).
/// They cannot submit a competing action because the hash is already on-chain.
#[account]
pub struct CommitRecord {
    /// Who made the commitment
    pub committer: Pubkey,
    /// SHA-256(action_data || nonce)
    pub commitment: [u8; 32],
    /// Slot at which the commitment was made
    pub commit_slot: u64,
    /// Minimum slots to wait before reveal (prevents same-slot front-running)
    pub min_reveal_delay: u64,
    /// Maximum slots before commitment expires (prevents stale commitments)
    pub max_reveal_window: u64,
    /// Whether this commitment has been revealed/consumed
    pub revealed: bool,
    /// The action type (0=transfer, 1=unshield, 2=claim)
    pub action_type: u8,
    /// Bump seed for PDA
    pub bump: u8,
}

impl CommitRecord {
    /// 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 = 99
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1;
}

/// Minimum reveal delay (2 slots ~= 800ms, prevents same-slot attacks)
pub const MIN_REVEAL_DELAY: u64 = 2;
/// Default reveal window (450 slots ~= 3 minutes)
pub const DEFAULT_REVEAL_WINDOW: u64 = 450;
/// Maximum reveal window (6750 slots ~= 45 minutes)
pub const MAX_REVEAL_WINDOW: u64 = 6750;
