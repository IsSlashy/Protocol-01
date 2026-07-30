//! Shared helpers for reading verified STARK proof buffers from
//! `p01_stark_verifier`. zkSPL handlers never verify proofs inline — they only
//! check that a proof buffer was verified and that its public-inputs hash
//! matches the expected reconstruction for the instruction's arguments.

use anchor_lang::prelude::*;

use crate::errors::ZkSplError;

/// Anchor discriminator for `p01_stark_verifier::ProofBuffer`.
pub const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// `p01_stark_verifier` program ID: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
pub const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// ProofBuffer layout offsets (must match `p01_stark_verifier::ProofBuffer`).
/// Layout: 8 disc | 32 authority | 1 circuit_id | 4 proof_size | 4 bytes_written
///       | 1 verified | 32 public_inputs_hash | 1 deep_ali_verified.
///
/// `PROOF_BUF_MIN_LEN` used to be 82, which put `deep_ali_verified` outside the
/// slice this parser would even look at. Every buffer the verifier can create
/// is `ProofBuffer::PROOF_DATA_OFFSET = 83` bytes or longer
/// (`p01_stark_verifier/src/lib.rs:556`), so requiring 83 rejects nothing an
/// honest caller can produce.
pub const PROOF_BUF_AUTHORITY: usize = 8;
pub const PROOF_BUF_CIRCUIT_ID: usize = 40;
pub const PROOF_BUF_VERIFIED: usize = 49;
pub const PROOF_BUF_INPUTS_HASH: usize = 50;
pub const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
pub const PROOF_BUF_MIN_LEN: usize = 83;

/// Circuit identifier for `confidential_balance` — used by deposit, withdraw,
/// apply_pending, and confidential_transfer (all single-commitment updates).
pub const CIRCUIT_CONFIDENTIAL_BALANCE: u8 = 4;

/// Circuit identifier for `balance_proof` (prove_balance).
pub const CIRCUIT_BALANCE_PROOF: u8 = 2;

/// Parse a verified STARK proof buffer.
/// Returns `(authority, circuit_id, verified, public_inputs_hash, deep_ali_verified)`.
pub fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32], bool)> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkSplError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkSplError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID])
        .map_err(|_| error!(ZkSplError::InvalidProof))?;
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED]);
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI_VERIFIED] == 1;
    Ok((
        authority,
        circuit_id,
        verified,
        public_inputs_hash,
        deep_ali_verified,
    ))
}

/// Extract the first 8 bytes of a `[u8; 32]` as a u64 (LE).
///
/// zkSPL uses Goldilocks-field STARK circuits: every "public input" is a u64.
/// When a caller stores a 32-byte commitment on-chain, the Goldilocks field
/// element lives in bytes 0..8 (LE), and bytes 8..32 are zero. This helper
/// exposes that u64 projection for public-inputs-hash reconstruction.
#[inline(always)]
pub fn u32_bytes_to_u64_le(bytes: &[u8; 32]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().unwrap())
}

/// Verify a STARK proof buffer and that its public-inputs hash equals
/// `sha256(public_inputs_u64_le_packed)`.
///
/// `proof_info` must be the `AccountInfo` of the proof buffer account.
/// `payer` is the wallet that uploaded the proof (stored as `authority` in the buffer).
/// `expected_circuit_id` is the circuit the instruction expects (e.g. 4 for
/// confidential_balance).
/// `public_inputs_u64` is the ordered list of u64 public inputs to reconstruct the hash.
pub fn verify_stark_proof(
    proof_info: &AccountInfo,
    payer: &Pubkey,
    expected_circuit_id: u8,
    public_inputs_u64: &[u64],
) -> Result<()> {
    // Must be owned by the STARK verifier program
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkSplError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash, deep_ali_verified) =
        parse_stark_proof_buffer(&proof_data)?;

    // Authority must be the payer (prevents using someone else's proof)
    require!(authority == *payer, ZkSplError::InvalidProof);

    // Must be the expected circuit
    require!(circuit_id == expected_circuit_id, ZkSplError::InvalidProof);

    // Must have passed phase 1 (`verify_stark_proof_v2`)
    require!(verified, ZkSplError::InvalidProof);

    // …and phase 2 (`verify_deep_ali_phase2`), which is mandatory for circuits
    // 1-6 — every circuit that reaches this helper is 2 or 4.
    //
    // Phase 1 is not an AIR check: `verify_quotient_at_query` enforces nothing
    // since 2026-07-27, and boundary constraints — the only place public inputs
    // meet the trace in phase 1 — fire only on a query that is both
    // trace-aligned and on an assertion row. A `verified`-only buffer therefore
    // does not bind the declared commitments to anything, and `withdraw` signs
    // a vault transfer on the strength of it. Same require! as the canonical
    // consumer, `zk_shielded/src/instructions/unshield_stark.rs:196`.
    //
    // This closes the "phase 1 was never an AIR check" hole. It does NOT make
    // the proof sound — DEEP-ALI is still bound to prover-chosen OOD values
    // (B1). The gate is necessary, not sufficient.
    require!(deep_ali_verified, ZkSplError::InvalidProof);

    // Reconstruct the expected public inputs hash. The STARK verifier v2 stores
    //   sha256(u64_le || u64_le || ...)
    // as a single concatenated blob (one syscall), so we rebuild the same way.
    let mut packed = Vec::with_capacity(public_inputs_u64.len() * 8);
    for v in public_inputs_u64 {
        packed.extend_from_slice(&v.to_le_bytes());
    }
    let expected_hash = solana_sha256_hasher::hashv(&[&packed]).to_bytes();

    require!(stored_inputs_hash == expected_hash, ZkSplError::InvalidProof);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These pin the BYTE LAYOUT the gate reads. They do NOT prove the
    /// `require!(deep_ali_verified, ..)` in `verify_stark_proof` is still
    /// there — that needs a real instruction against real bytecode and lives in
    /// `tests/deep_ali_gate.rs` (litesvm). Both exist because this one runs in
    /// plain `cargo test` with no Solana toolchain, and that one is the actual
    /// accept/reject gate.
    fn buffer(verified: bool, deep_ali_verified: bool) -> Vec<u8> {
        let mut d = vec![0u8; PROOF_BUF_MIN_LEN];
        d[..8].copy_from_slice(&STARK_PROOF_BUFFER_DISCRIMINATOR);
        d[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID].copy_from_slice(&[7u8; 32]);
        d[PROOF_BUF_CIRCUIT_ID] = CIRCUIT_CONFIDENTIAL_BALANCE;
        d[PROOF_BUF_VERIFIED] = u8::from(verified);
        d[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED].copy_from_slice(&[0xABu8; 32]);
        d[PROOF_BUF_DEEP_ALI_VERIFIED] = u8::from(deep_ali_verified);
        d
    }

    #[test]
    fn min_len_covers_the_deep_ali_flag() {
        // 82 would put the flag outside the slice the parser reads at all.
        assert_eq!(PROOF_BUF_MIN_LEN, PROOF_BUF_DEEP_ALI_VERIFIED + 1);
        assert!(parse_stark_proof_buffer(&buffer(true, true)[..82]).is_err());
    }

    #[test]
    fn parses_the_deep_ali_flag_from_byte_82() {
        let (_, _, verified, _, deep_ali) = parse_stark_proof_buffer(&buffer(true, false)).unwrap();
        assert!(verified, "phase-1 flag");
        assert!(!deep_ali, "phase-2 flag must read byte 82, not be assumed");

        let (_, _, _, _, deep_ali) = parse_stark_proof_buffer(&buffer(true, true)).unwrap();
        assert!(deep_ali);
    }

    #[test]
    fn inputs_hash_stops_before_the_flag() {
        // If the hash slice ran to 83 it would swallow the flag byte and the
        // hash comparison would start depending on phase-2 state.
        let (_, _, _, h0, _) = parse_stark_proof_buffer(&buffer(true, false)).unwrap();
        let (_, _, _, h1, _) = parse_stark_proof_buffer(&buffer(true, true)).unwrap();
        assert_eq!(h0, h1);
        assert_eq!(h0, [0xABu8; 32]);
    }
}
