use anchor_lang::prelude::*;

/// A single in-flight prefund. Created when `prefund` is called, destroyed
/// when `settle` CPI-calls zk_shielded and receives the unshielded lamports
/// back into the liquidity pool.
///
/// Keyed by `(denominated_pool, nullifier[..8])` — the 8 bytes the circuit-1
/// public-inputs hash actually commits to. NOT the full 32: bytes 8..32 are
/// unconstrained by the proof, and keying on them turned this account, the only
/// anti-replay constraint in `prefund`, into 2^192 distinct PDAs per proof.
/// See the `prefund_record` account doc in `instructions/prefund.rs`.
#[account]
pub struct PrefundRecord {
    /// Liquidity pool this prefund draws from.
    pub pool: Pubkey,

    /// The denominated_pool this nullifier belongs to (needed by settlement CPI).
    pub denominated_pool: Pubkey,

    /// Nullifier as passed to zk_shielded. Redundantly stored for event/logging.
    pub nullifier: [u8; 32],

    /// Merkle root the user proved against.
    pub merkle_root: [u8; 32],

    /// STARK public inputs hash the verifier stored (sha256(nullifier_u64 || commitment_u64)).
    pub public_inputs_hash: [u8; 32],

    /// STARK commitment u64 — re-submitted at settlement time.
    pub stark_commitment: u64,

    /// Denomination lamports of the underlying note.
    pub amount: u64,

    /// min_epoch argument that gated the original proof (epoch the note matured in).
    pub min_epoch: u64,

    /// Stark proof buffer pubkey — settlement re-derives its authority check.
    pub proof_buffer: Pubkey,

    /// Ephemeral signer that owns the proof buffer (required for zk_shielded's
    /// authority-match check; settle CPIs with `PrefundRecord` PDA as payer,
    /// and zk_shielded validates this match against the stored value).
    pub ephemeral_signer: Pubkey,

    /// Settler reward (lamports) promised to whoever calls settle.
    pub settler_reward: u64,

    /// Slot when the prefund opened (for telemetry / timeout rescue).
    pub opened_at_slot: u64,

    pub bump: u8,
}

impl PrefundRecord {
    pub const SEED_PREFIX: &'static [u8] = b"prefund";

    /// 8 disc + 32 pool + 32 denom_pool + 32 nullifier + 32 root
    ///   + 32 inputs_hash + 8 commitment + 8 amount + 8 epoch
    ///   + 32 proof_buffer + 32 ephemeral + 8 reward + 8 slot + 1 bump
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 32 + 32 + 8 + 8 + 1;
}
