//! SPHINCS+ signature upload buffer.
//!
//! The chosen SPHINCS+ variant — `Sha2_128f` (NIST FIPS 205 / SLH-DSA-SHA2-128f)
//! — produces a 17,088-byte signature. That far exceeds the 1232-byte legacy
//! and 1644-byte v0 transaction limits, so the caller uploads it in chunks via
//! `init_sphincs_sig_buffer` + `write_sphincs_sig_chunk` before invoking
//! `emergency_recover`. The pattern mirrors `WotsSigBuffer` in `p01_quantum_vault`.

use anchor_lang::prelude::*;

/// Signature size for SPHINCS+ `Sha2_128f` (FIPS 205 SLH-DSA-SHA2-128f).
pub const SPHINCS_SHA2_128F_SIG_SIZE: usize = 17_088;

#[account]
pub struct SphincsSigBuffer {
    /// Buffer creator (typically the caller of `emergency_recover`).
    pub authority: Pubkey,
    /// Wallet this buffer is bound to. Recovery instructions check this
    /// against the wallet PDA so a signature uploaded for one wallet cannot
    /// be replayed against another.
    pub wallet: Pubkey,
    /// Declared total signature size. Variant-locked at init.
    pub sig_size: u32,
    /// Cumulative bytes written. Once `bytes_written == sig_size`, the
    /// buffer is complete.
    pub bytes_written: u32,
}

impl SphincsSigBuffer {
    pub const SEED_PREFIX: &'static [u8] = b"sphincs_sig";

    /// Anchor discriminator + struct prefix.
    pub const STRUCT_PREFIX: usize = 8 // discriminator
        + 32                            // authority
        + 32                            // wallet
        + 4                             // sig_size
        + 4;                            // bytes_written

    /// Byte offset at which the raw signature payload starts inside the
    /// account data. Anchor lays struct fields directly after the
    /// discriminator with `repr(C)` ordering for `#[account]`.
    pub const SIG_DATA_OFFSET: usize = Self::STRUCT_PREFIX;

    /// Total account size for a `Sha2_128f` signature buffer.
    pub const SPACE_SHA2_128F: usize = Self::STRUCT_PREFIX + SPHINCS_SHA2_128F_SIG_SIZE;
}
