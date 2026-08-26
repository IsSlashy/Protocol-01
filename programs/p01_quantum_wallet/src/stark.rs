//! Shared STARK proof buffer parsing.
//!
//! Mirrors the layout used by `zk_shielded::instructions::subscribe_private_stark`
//! and `p01_zkspl::stark_proof`. We do NOT CPI into `p01_stark_verifier`; instead,
//! the caller is expected to verify the proof in a prior transaction via the
//! upload + verify flow, then pass the resulting `ProofBuffer` account here.
//!
//! Layout (must match `p01_stark_verifier::ProofBuffer`):
//!   0..8    discriminator   [u8; 8]
//!   8..40   authority       [u8; 32]
//!   40      circuit_id      u8
//!   ..49    (padding)
//!   49      verified        u8 (0 or 1)
//!   50..82  inputs_hash     [u8; 32]
//!
//! `inputs_hash = SHA-256(public_input_bytes...)`. For wallet auth the AIR is
//! circuit 0 (subscriber_ownership) which proves `Poseidon(secret) == commitment`,
//! and the public input is the 8-byte Goldilocks felt of the commitment. The
//! caller reconstructs the same SHA-256 input and compares.

use anchor_lang::prelude::*;

use crate::errors::QWalletError;

/// Anchor account discriminator for `p01_stark_verifier::ProofBuffer`.
/// Hard-coded so we do not pull the verifier crate as a dep.
pub const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// `p01_stark_verifier` program id — `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`.
/// Matches the `declare_id!` in `programs/p01_stark_verifier/src/lib.rs` and the
/// hard-coded constant used everywhere else in the workspace (see
/// `programs/zk_shielded/src/instructions/subscribe_private_stark.rs`).
pub const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// Circuit id for `subscriber_ownership` (Poseidon(secret) == commitment) — the
/// AIR we reuse for wallet authorization.
pub const WALLET_AUTH_CIRCUIT_ID: u8 = 0;

// Offsets inside `ProofBuffer`.
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_MIN_LEN: usize = 82;

/// Decoded fields of a `ProofBuffer` account.
pub struct VerifiedProof {
    pub authority: Pubkey,
    pub circuit_id: u8,
    pub verified: bool,
    pub public_inputs_hash: [u8; 32],
}

/// Parse a raw `ProofBuffer` account payload.
pub fn parse_proof_buffer(data: &[u8]) -> Result<VerifiedProof> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, QWalletError::InvalidProofDiscriminator);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        QWalletError::InvalidProofDiscriminator
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID])
        .map_err(|_| QWalletError::InvalidProofDiscriminator)?;
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok(VerifiedProof {
        authority,
        circuit_id,
        verified,
        public_inputs_hash,
    })
}

/// Run the full set of checks a wallet instruction needs against a proof:
///
///   1. account owner == `p01_stark_verifier`
///   2. discriminator matches
///   3. `verified == true`
///   4. proof authority equals the expected payer
///   5. circuit id equals `expected_circuit_id`
///   6. `inputs_hash == SHA-256(expected_public_input_bytes)`
///
/// `expected_public_input_bytes` is the byte stream the prover claims it hashed
/// for Fiat-Shamir. For circuit 0 this is the 8-byte little-endian Goldilocks
/// commitment.
pub fn validate_wallet_proof(
    proof_info: &AccountInfo,
    expected_authority: Pubkey,
    expected_circuit_id: u8,
    expected_public_input_bytes: &[u8],
) -> Result<()> {
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        QWalletError::InvalidProofOwner
    );

    let data = proof_info.try_borrow_data()?;
    let parsed = parse_proof_buffer(&data)?;

    require!(parsed.verified, QWalletError::ProofNotVerified);
    require!(
        parsed.authority == expected_authority,
        QWalletError::ProofAuthorityMismatch
    );

    // 🚨 `verified` ABOVE IS PHASE 1 ONLY, AND THIS FUNCTION NEVER LOOKS AT THE
    // PHASE-2 FLAG. That is correct for exactly one circuit and unsafe for the
    // other seven.
    //
    // Circuit 0 is the only one whose DEEP-ALI runs INSIDE phase 1 —
    // `verify_deep_ali_phase2` refuses circuit 0 by name, so byte 82 is never
    // set for it and requiring it here would brick every wallet instruction.
    // For circuits 1..7 phase 2 is a separate instruction, and phase 1 alone is
    // not an AIR check.
    //
    // So the C0-ness is pinned HERE rather than left to the callers. All three
    // of them (rotate, transfer, withdraw) pass `WALLET_AUTH_CIRCUIT_ID`, which
    // is 0 — but that is a fact about today's call sites, not a property of this
    // function, and a fourth caller passing anything else would silently get a
    // half-verified proof accepted. `phase_binding_seam` flagged this file for
    // that reason and deliberately would not accept a constant reached through a
    // parameter as the pin.
    let circuit_id = expected_circuit_id;
    require!(circuit_id == 0, QWalletError::ProofCircuitMismatch);
    require!(
        parsed.circuit_id == expected_circuit_id,
        QWalletError::ProofCircuitMismatch
    );

    let expected_hash: [u8; 32] = solana_sha256_hasher::hashv(&[expected_public_input_bytes]).to_bytes();
    require!(
        parsed.public_inputs_hash == expected_hash,
        QWalletError::ProofInputsMismatch
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_buffer(
        verified: bool,
        circuit_id: u8,
        authority: &Pubkey,
        inputs_hash: &[u8; 32],
    ) -> Vec<u8> {
        let mut buf = Vec::with_capacity(PROOF_BUF_MIN_LEN);
        buf.extend_from_slice(&STARK_PROOF_BUFFER_DISCRIMINATOR);
        buf.extend_from_slice(authority.as_ref());
        buf.push(circuit_id);
        // padding bytes 41..49
        for _ in PROOF_BUF_CIRCUIT_ID + 1..PROOF_BUF_VERIFIED {
            buf.push(0);
        }
        buf.push(if verified { 1 } else { 0 });
        buf.extend_from_slice(inputs_hash);
        buf
    }

    #[test]
    fn parse_proof_buffer_round_trips_a_valid_buffer() {
        let auth = Pubkey::new_unique();
        let inputs_hash = [0xABu8; 32];
        let buf = build_buffer(true, WALLET_AUTH_CIRCUIT_ID, &auth, &inputs_hash);

        let parsed = parse_proof_buffer(&buf).expect("valid buffer must parse");
        assert_eq!(parsed.authority, auth);
        assert_eq!(parsed.circuit_id, WALLET_AUTH_CIRCUIT_ID);
        assert!(parsed.verified);
        assert_eq!(parsed.public_inputs_hash, inputs_hash);
    }

    #[test]
    fn parse_proof_buffer_rejects_a_too_short_payload() {
        let buf = vec![0u8; PROOF_BUF_MIN_LEN - 1];
        assert!(parse_proof_buffer(&buf).is_err());
    }

    #[test]
    fn parse_proof_buffer_rejects_an_unknown_discriminator() {
        let mut buf = build_buffer(true, 0, &Pubkey::new_unique(), &[0u8; 32]);
        buf[0] ^= 0xFF;
        assert!(parse_proof_buffer(&buf).is_err());
    }

    #[test]
    fn parse_proof_buffer_reports_unverified() {
        let buf = build_buffer(false, 0, &Pubkey::new_unique(), &[0u8; 32]);
        let parsed = parse_proof_buffer(&buf).expect("must parse");
        assert!(!parsed.verified);
    }
}
