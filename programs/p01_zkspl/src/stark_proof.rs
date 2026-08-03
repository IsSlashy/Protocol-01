//! Shared helpers for reading verified STARK proof buffers from
//! `p01_stark_verifier`. zkSPL handlers never verify proofs inline — they only
//! check that a proof buffer was verified and that its public-inputs hash
//! matches the expected reconstruction for the instruction's arguments.
//!
//! # KNOWN GAP: this crate cannot see STARK phase 2, and it consumes circuits
//! # that need it
//!
//! `p01_stark_verifier` splits verification in two. Phase 1 sets
//! `ProofBuffer::verified`. Phase 2 (DEEP-ALI) sets a *separate* field,
//! `deep_ali_verified`, via its own instruction, and phase 2 applies to
//! **circuits 1 through 6** — `lib.rs`'s
//! `require!(matches!(circuit_id, 1 | 2 | 3 | 4 | 5 | 6), UnsupportedCircuit)`.
//! Only circuit 0 completes inside phase 1.
//!
//! This crate consumes circuit 2 (`balance_proof`) and circuit 4
//! (`confidential_balance`). Both are in that range. `verify_stark_proof`
//! requires `verified` and never looks at `deep_ali_verified` — and it could
//! not look even if it wanted to, because `PROOF_BUF_MIN_LEN` here is 82 while
//! the verifier's `ProofBuffer::PROOF_DATA_OFFSET` is 83: the phase-2 flag is
//! the byte immediately past the end of this parser's window.
//!
//! So **a proof that has only completed phase 1 is accepted as final** for
//! every zkSPL instruction. `phase2_debt` below pins that, deliberately, as a
//! standing red flag rather than a comment nobody re-reads.
//!
//! ## Why this is not simply fixed here
//!
//! Adding `require!(deep_ali_verified)` would immediately reject every client
//! that cannot yet submit the phase-2 leg, and no shipped zkSPL client
//! currently does. The fix is a client change first, program change second:
//!
//!   1. The client must call the verifier's phase-2 instruction after phase 1
//!      and before calling zkSPL, for circuits 2 and 4.
//!   2. `PROOF_BUF_MIN_LEN` must become 83 and the parser must return
//!      `deep_ali_verified`.
//!   3. `verify_stark_proof` must require it for circuits in 1..=6.
//!
//! Do steps 1 and 2 first; step 3 is the one that brings clients down.
//!
//! ## And it is not hypothetical: the program is deployed
//!
//! `p01_zkspl` is live on devnet at
//! `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah` (`Anchor.toml
//! [programs.devnet]`), deployed at slot 444402868, upgrade authority
//! `7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU`, owning 8 accounts totalling
//! 0.100251840 SOL. Measured read-only 2026-08-03 by
//! `node scripts/probe-liquidity-exposure.mjs`.
//!
//! A previous pass recorded this program as "NOT DEPLOYED, the account does
//! not exist" and downgraded this gap from exposure to debt on that basis. It
//! had probed `AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT` — the
//! `declare_id!` value, which is the `[programs.localnet]` entry. Two
//! different keys. The probe script checks both so the mistake cannot recur.

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

/// Circuits `p01_stark_verifier` requires a separate phase-2 (DEEP-ALI)
/// instruction for. Mirrors the `require!(matches!(circuit_id, 1..=6))` in
/// `p01_stark_verifier/src/lib.rs`'s DEEP-ALI handler.
///
/// NOTE: this is a hand-kept mirror, not a derived value — the verifier
/// expresses the set as an inline `matches!` and exports no constant for it.
/// `phase2_debt::zkspl_circuits_are_inside_the_phase_2_range` pins it; if the
/// verifier's range changes, that test will NOT catch it. The verifier's own
/// `ProofBuffer::deep_ali_verified` doc still claims phase 2 is "currently
/// circuit 6 only", which contradicts its handler — believe the handler.
pub const PHASE_2_CIRCUITS: [u8; 6] = [1, 2, 3, 4, 5, 6];

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

    // NOTE: phase 2 (DEEP-ALI) is NOT checked here, and `parse_stark_proof_buffer`
    // cannot report it. See this module's header for why, and for the order the
    // fix has to happen in.

    Ok(())
}

#[cfg(test)]
mod phase2_debt {
    //! Pins the phase-2 gap described in this module's header.
    //!
    //! These tests go GREEN while the gap is open. That is deliberate: they
    //! are a tripwire, not a proof of correctness. Each one names the exact
    //! edit that should make it fail, so closing the gap forces a visible
    //! decision here instead of a silent behaviour change.

    use super::*;
    use anchor_lang::AccountSerialize;
    use p01_stark_verifier::ProofBuffer;

    /// Serialize the REAL verifier account type: `try_serialize` writes the
    /// real Anchor discriminator and the real Borsh field order, so nothing in
    /// these fixtures is copied from this crate's offset table.
    fn encode(b: ProofBuffer) -> Vec<u8> {
        let mut out = Vec::new();
        b.try_serialize(&mut out).expect("ProofBuffer serializes");
        out
    }

    /// A circuit-4 buffer. `deep_ali` selects whether phase 2 has run.
    fn confidential_balance_buffer(deep_ali: bool) -> ProofBuffer {
        ProofBuffer {
            authority: Pubkey::new_from_array([0xA7; 32]),
            circuit_id: CIRCUIT_CONFIDENTIAL_BALANCE,
            proof_size: 0x1122_3344,
            bytes_written: 0x5566_7788,
            verified: true,
            public_inputs_hash: [0x5Au8; 32],
            deep_ali_verified: deep_ali,
        }
    }

    /// This crate's offsets land on the fields the verifier actually wrote.
    ///
    /// Without this, every claim below is a claim about a layout nobody
    /// checked — and a one-byte disagreement here is a verification bypass.
    #[test]
    fn offsets_match_the_real_proof_buffer() {
        let encoded = encode(confidential_balance_buffer(true));
        let (authority, circuit_id, verified, hash) =
            parse_stark_proof_buffer(&encoded).expect("parses");
        assert_eq!(authority, Pubkey::new_from_array([0xA7; 32]));
        assert_eq!(circuit_id, CIRCUIT_CONFIDENTIAL_BALANCE);
        assert!(verified);
        assert_eq!(hash, [0x5Au8; 32]);
        assert_eq!(
            &encoded[..8],
            &STARK_PROOF_BUFFER_DISCRIMINATOR[..],
            "STARK_PROOF_BUFFER_DISCRIMINATOR is not what p01_stark_verifier writes"
        );
        assert_eq!(STARK_VERIFIER_PROGRAM_ID, p01_stark_verifier::ID);
    }

    /// THE GAP, stated as an executable fact: two buffers that differ ONLY in
    /// whether phase 2 ran are indistinguishable to this crate.
    ///
    /// Turns red the moment `parse_stark_proof_buffer` starts reporting
    /// `deep_ali_verified` — which is step 2 of the fix in the module header.
    /// When it does, delete this test and add the rejection test that replaces
    /// it.
    #[test]
    fn a_phase_1_only_proof_is_indistinguishable_from_a_fully_verified_one() {
        let with_phase_2 = encode(confidential_balance_buffer(true));
        let without_phase_2 = encode(confidential_balance_buffer(false));

        assert_ne!(
            with_phase_2, without_phase_2,
            "the fixtures must actually differ on the wire, or this proves nothing"
        );
        assert_eq!(
            parse_stark_proof_buffer(&with_phase_2).unwrap(),
            parse_stark_proof_buffer(&without_phase_2).unwrap(),
            "p01_zkspl now distinguishes phase-1-only proofs — good. Delete this \
             test and require deep_ali_verified for circuits in PHASE_2_CIRCUITS."
        );
    }

    /// The phase-2 flag sits one byte past the end of this parser's window, so
    /// the gap is structural and not an oversight in one `require!`.
    #[test]
    fn the_phase_2_flag_is_outside_this_crates_parser_window() {
        // Exactly one byte short. This single equality catches BOTH ways the
        // situation can change: the verifier's header growing or shrinking
        // (re-derive every offset in this file), and someone widening
        // PROOF_BUF_MIN_LEN to 83 to expose `deep_ali_verified` (step 2 of the
        // fix is then done — finish step 3 and delete this module).
        assert_eq!(
            PROOF_BUF_MIN_LEN + 1,
            ProofBuffer::PROOF_DATA_OFFSET,
            "the parser window no longer stops exactly one byte before \
             deep_ali_verified; see this module's header before touching offsets"
        );
    }

    /// The circuits this crate consumes are exactly the ones phase 2 covers,
    /// so the gap applies to every zkSPL instruction rather than a corner.
    #[test]
    fn zkspl_circuits_are_inside_the_phase_2_range() {
        for c in [CIRCUIT_BALANCE_PROOF, CIRCUIT_CONFIDENTIAL_BALANCE] {
            assert!(
                PHASE_2_CIRCUITS.contains(&c),
                "circuit {c} is consumed here but is not in PHASE_2_CIRCUITS"
            );
        }
        assert!(
            !PHASE_2_CIRCUITS.contains(&0),
            "circuit 0 completes DEEP-ALI inside phase 1 and must stay out of this set"
        );
    }
}
