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
///       | 1 verified | 32 public_inputs_hash.
pub const PROOF_BUF_AUTHORITY: usize = 8;
pub const PROOF_BUF_CIRCUIT_ID: usize = 40;
pub const PROOF_BUF_VERIFIED: usize = 49;
pub const PROOF_BUF_INPUTS_HASH: usize = 50;
pub const PROOF_BUF_MIN_LEN: usize = 82;

/// Circuit identifier for `confidential_balance` — used by deposit, withdraw,
/// apply_pending, and confidential_transfer (all single-commitment updates).
pub const CIRCUIT_CONFIDENTIAL_BALANCE: u8 = 4;

/// Circuit identifier for `balance_proof` (prove_balance).
pub const CIRCUIT_BALANCE_PROOF: u8 = 2;

/// Parse a verified STARK proof buffer.
/// Returns `(authority, circuit_id, verified, public_inputs_hash)`.
pub fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
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
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
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
    let (authority, circuit_id, verified, stored_inputs_hash) =
        parse_stark_proof_buffer(&proof_data)?;

    // Authority must be the payer (prevents using someone else's proof)
    require!(authority == *payer, ZkSplError::InvalidProof);

    // Must be the expected circuit
    require!(circuit_id == expected_circuit_id, ZkSplError::InvalidProof);

    // Must be verified
    require!(verified, ZkSplError::InvalidProof);

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
