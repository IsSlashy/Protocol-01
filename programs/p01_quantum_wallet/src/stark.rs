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
/// [SEAM] Phase-2 flag, byte 82. `PROOF_BUF_MIN_LEN` used to be 82, which put
/// this byte OUTSIDE the slice this parser would look at — the parser could not
/// have enforced phase 2 even if a caller asked it to. `p01_zkspl` and
/// `p01_liquidity` were both moved to 83 for exactly this reason; this crate
/// was not. Every buffer the verifier can create is
/// `ProofBuffer::PROOF_DATA_OFFSET = 83` bytes or longer, so 83 rejects nothing
/// an honest caller can produce.
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

/// Decoded fields of a `ProofBuffer` account.
pub struct VerifiedProof {
    pub authority: Pubkey,
    pub circuit_id: u8,
    pub verified: bool,
    pub public_inputs_hash: [u8; 32],
    /// Phase-2 (DEEP-ALI) flag. Meaningless for circuit 0, which runs DEEP-ALI
    /// inside phase 1 and can never reach `verify_deep_ali_phase2` — that
    /// instruction gates `circuit_id` to 1..=6.
    pub deep_ali_verified: bool,
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
    public_inputs_hash
        .copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED]);
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI_VERIFIED] == 1;
    Ok(VerifiedProof {
        authority,
        circuit_id,
        verified,
        public_inputs_hash,
        deep_ali_verified,
    })
}

/// Run the full set of checks a wallet instruction needs against a proof:
///
///   1. account owner == `p01_stark_verifier`
///   2. discriminator matches
///   3. `verified == true`
///   4. proof authority equals the expected payer
///   5. circuit id equals `expected_circuit_id`
///   6. `deep_ali_verified == true` for every circuit EXCEPT 0
///   7. `inputs_hash == SHA-256(expected_public_input_bytes)`
///
/// `expected_public_input_bytes` is the byte stream the prover claims it hashed
/// for Fiat-Shamir. For circuit 0 this is the 8-byte little-endian Goldilocks
/// commitment.
///
/// # Why check 6 exists
///
/// `expected_circuit_id` is a PARAMETER. Every caller in this crate passes
/// [`WALLET_AUTH_CIRCUIT_ID`] (0) today, and for circuit 0 phase 2 does not
/// exist — `verify_deep_ali_phase2` gates `circuit_id` to 1..=6, so a C0 buffer
/// is complete at `verified = true` and its `deep_ali_verified` stays false
/// forever. The flag therefore means the OPPOSITE thing either side of that
/// boundary, and a `require!(deep_ali_verified)` written flat would reject every
/// honest C0 proof.
///
/// The rule is the boundary itself, so this helper encodes the boundary rather
/// than trusting the next caller to know it. For circuits 1..=6, phase 1 alone
/// is not an AIR check: `verify_quotient_at_query` enforces nothing since
/// 2026-07-27, and boundary constraints fire only on a query that is both
/// trace-aligned and on an assertion row. Measured, phase 1 alone accepts 31 of
/// 32 mint-from-nothing circuit-5 proofs. So the first caller that passes a
/// non-zero `expected_circuit_id` would have signed a wallet spend on a
/// half-verified proof. It now fails closed instead.
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
    require!(
        parsed.circuit_id == expected_circuit_id,
        QWalletError::ProofCircuitMismatch
    );
    // [SEAM] Phase-2 gate. See the doc comment: C0 has no phase 2, everything
    // else does and phase 1 alone binds almost nothing.
    require!(
        parsed.circuit_id == WALLET_AUTH_CIRCUIT_ID || parsed.deep_ali_verified,
        QWalletError::ProofNotVerified
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
        build_buffer_full(verified, false, circuit_id, authority, inputs_hash)
    }

    fn build_buffer_full(
        verified: bool,
        deep_ali_verified: bool,
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
        buf.push(if deep_ali_verified { 1 } else { 0 });
        assert_eq!(buf.len(), PROOF_BUF_MIN_LEN);
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

    /// [SEAM] `PROOF_BUF_MIN_LEN` was 82, one byte short of the phase-2 flag.
    /// At 82 this parser could not observe byte 82 at all, so no gate written
    /// against it could ever have fired.
    #[test]
    fn min_len_covers_the_phase_two_flag() {
        assert_eq!(PROOF_BUF_MIN_LEN, PROOF_BUF_DEEP_ALI_VERIFIED + 1);
        let buf = build_buffer_full(true, true, 0, &Pubkey::new_unique(), &[0u8; 32]);
        assert!(
            parse_proof_buffer(&buf[..82]).is_err(),
            "an 82-byte buffer cannot carry the flag and must be refused"
        );
    }

    /// The hash slice must stop BEFORE the flag, or the stored
    /// `public_inputs_hash` would start depending on phase-2 state and no
    /// consumer reconstruction could ever match.
    #[test]
    fn inputs_hash_stops_before_the_phase_two_flag() {
        let auth = Pubkey::new_unique();
        let h0 = parse_proof_buffer(&build_buffer_full(true, false, 0, &auth, &[0xABu8; 32]))
            .unwrap()
            .public_inputs_hash;
        let h1 = parse_proof_buffer(&build_buffer_full(true, true, 0, &auth, &[0xABu8; 32]))
            .unwrap()
            .public_inputs_hash;
        assert_eq!(h0, h1);
        assert_eq!(h0, [0xABu8; 32]);
    }

    #[test]
    fn parse_proof_buffer_reads_the_phase_two_flag_from_byte_82() {
        let auth = Pubkey::new_unique();
        assert!(
            !parse_proof_buffer(&build_buffer_full(true, false, 0, &auth, &[0u8; 32]))
                .unwrap()
                .deep_ali_verified
        );
        assert!(
            parse_proof_buffer(&build_buffer_full(true, true, 0, &auth, &[0u8; 32]))
                .unwrap()
                .deep_ali_verified
        );
    }

    /// [SEAM] The guard itself, driven through `validate_wallet_proof` — the
    /// real function, on a real `AccountInfo`, not a re-implementation of the
    /// predicate. Reverting the `require!` in `validate_wallet_proof` turns this
    /// red; a test that re-evaluated `circuit_id == 0 || deep_ali_verified`
    /// itself would stay green through exactly that deletion.
    ///
    /// Still not the instruction-level gate: that needs litesvm and real
    /// bytecode, the shape `p01_zkspl/tests/deep_ali_gate.rs` uses. This
    /// verifies the helper every wallet instruction routes through.
    #[test]
    fn phase_two_is_required_for_every_circuit_except_zero() {
        let auth = Pubkey::new_unique();
        let pub_bytes = 7u64.to_le_bytes();
        let inputs_hash: [u8; 32] =
            solana_sha256_hasher::hashv(&[&pub_bytes]).to_bytes();

        let accepts = |circuit_id: u8, deep: bool| -> bool {
            let mut data =
                build_buffer_full(true, deep, circuit_id, &auth, &inputs_hash);
            let mut lamports = 1_000_000u64;
            let key = Pubkey::new_unique();
            let owner = STARK_VERIFIER_PROGRAM_ID;
            let info = AccountInfo::new(
                &key,
                false,
                false,
                &mut lamports,
                &mut data,
                &owner,
                false,
                0,
            );
            validate_wallet_proof(&info, auth, circuit_id, &pub_bytes).is_ok()
        };

        // C0 has no phase 2 — `verify_deep_ali_phase2` gates `circuit_id` to
        // 1..=6, so a C0 buffer's flag stays false forever. A flat
        // `require!(deep_ali_verified)` would reject every honest C0 proof.
        assert!(accepts(0, false), "C0 must pass on phase 1 alone");
        assert!(accepts(0, true));

        // Everything else must carry phase 2. Phase 1 alone is not an AIR
        // check: measured, it accepts 31 of 32 mint-from-nothing C5 proofs.
        for circuit_id in 1u8..=6 {
            assert!(
                !accepts(circuit_id, false),
                "C{circuit_id} accepted a phase-1-only buffer — a wallet spend \
                 would have been signed on it"
            );
            assert!(accepts(circuit_id, true), "C{circuit_id} rejected a complete buffer");
        }
        // The `init_proof_buffer_v2` sentinel is not a loophole either.
        assert!(!accepts(u8::MAX, false), "the u8::MAX init sentinel must not pass");
    }

    /// A buffer that never passed phase 1 is refused whatever the phase-2 flag
    /// says — the flags are checked independently, so a planted `82 = 1` on an
    /// unverified buffer buys nothing.
    #[test]
    fn a_phase_two_flag_without_phase_one_is_still_refused() {
        let auth = Pubkey::new_unique();
        let pub_bytes = 7u64.to_le_bytes();
        let inputs_hash: [u8; 32] = solana_sha256_hasher::hashv(&[&pub_bytes]).to_bytes();
        for circuit_id in [0u8, 1, 6] {
            let mut data =
                build_buffer_full(false, true, circuit_id, &auth, &inputs_hash);
            let mut lamports = 1_000_000u64;
            let key = Pubkey::new_unique();
            let owner = STARK_VERIFIER_PROGRAM_ID;
            let info =
                AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false, 0);
            assert!(
                validate_wallet_proof(&info, auth, circuit_id, &pub_bytes).is_err(),
                "C{circuit_id}: verified=0 deep_ali=1 was accepted"
            );
        }
    }

    /// An account the STARK verifier does not own is refused before anything is
    /// parsed — otherwise an attacker could hand over a self-owned account whose
    /// bytes spell out a fully verified buffer.
    #[test]
    fn a_foreign_owned_buffer_is_refused() {
        let auth = Pubkey::new_unique();
        let pub_bytes = 7u64.to_le_bytes();
        let inputs_hash: [u8; 32] = solana_sha256_hasher::hashv(&[&pub_bytes]).to_bytes();
        let mut data = build_buffer_full(true, true, 0, &auth, &inputs_hash);
        let mut lamports = 1_000_000u64;
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique(); // NOT the verifier
        let info =
            AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false, 0);
        assert!(validate_wallet_proof(&info, auth, 0, &pub_bytes).is_err());
    }
}
