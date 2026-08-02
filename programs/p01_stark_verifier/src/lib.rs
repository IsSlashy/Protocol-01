#![allow(unknown_lints, dead_code, unused_imports)]
#![allow(
    clippy::collapsible_if,
    clippy::derivable_impls,
    clippy::doc_lazy_continuation,
    clippy::doc_overindented_list_items,
    clippy::empty_line_after_doc_comments,
    clippy::get_first,
    clippy::if_same_then_else,
    clippy::int_plus_one,
    clippy::manual_checked_ops,
    clippy::manual_hash_one,
    clippy::manual_is_multiple_of,
    clippy::manual_range_contains,
    clippy::manual_range_patterns,
    clippy::manual_saturating_arithmetic,
    clippy::manual_unwrap_or,
    clippy::manual_unwrap_or_default,
    clippy::needless_range_loop,
    clippy::should_implement_trait,
    clippy::too_many_arguments
)]

use anchor_lang::prelude::*;

pub mod compact_proof;
pub mod goldilocks;
pub mod merkle;
pub mod periodic_consts;
pub mod periodic_ext_consts;
mod poseidon_consts;
pub mod verify;

use compact_proof::{CompactStarkProof, GenericCompactProof, get_circuit_config};
use goldilocks::Felt;

declare_id!("DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs");

/// [SEAM] The one encoder behind `ProofBuffer.public_inputs_hash`.
///
/// Phase 1 (`verify_stark_proof`, `verify_stark_proof_v2`, `verify_uniform`)
/// STORES this; phase 2 (`verify_deep_ali_phase2`) RECOMPUTES it and refuses to
/// advance `deep_ali_verified` unless the two agree. Every consumer in the tree
/// rebuilds it a fourth time from its own instruction arguments. That was four
/// hand-copied loops with nothing pinning them together; the two inside this
/// program are now literally the same code.
///
/// Injectivity: every element is a fixed 8 bytes, so `Vec<u64> -> Vec<u8>` is
/// injective and no length framing is needed — two different input lists cannot
/// produce the same byte string, and a shorter list cannot be a valid encoding
/// of a longer one because the total length would differ. This is exactly why
/// changing the encoding to anything variable-width would silently break the
/// phase binding, and why `public_inputs_hash_is_injective_over_length` exists.
///
/// What it does NOT cover: `circuit_id`. The hash binds the VALUES only. The
/// circuit is carried in a separate byte and every consumer must pin it
/// independently — see the consumer-contract test.
pub fn hash_public_inputs(public_inputs: &[u64]) -> [u8; 32] {
    let mut pub_buf: Vec<u8> = Vec::with_capacity(public_inputs.len() * 8);
    for v in public_inputs {
        pub_buf.extend_from_slice(&v.to_le_bytes());
    }
    solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes()
}

pub const CIRCUIT_SUBSCRIBER_OWNERSHIP: u8 = 0;
pub const CIRCUIT_POOL_COMMITMENT: u8 = 1;
pub const CIRCUIT_BALANCE_PROOF: u8 = 2;
pub const CIRCUIT_MERKLE_PATH: u8 = 3;
pub const CIRCUIT_CONFIDENTIAL_BALANCE: u8 = 4;
pub const CIRCUIT_TRANSFER: u8 = 5;
pub const CIRCUIT_MERKLE_UPDATE: u8 = 6;

#[program]
pub mod p01_stark_verifier {
    use super::*;

    /// Initialize a proof buffer PDA to hold STARK proof bytes.
    pub fn init_proof_buffer(
        ctx: Context<InitProofBuffer>,
        proof_size: u32,
        circuit_id: u8,
    ) -> Result<()> {
        require!(
            get_circuit_config(circuit_id).is_some(),
            StarkVerifierError::UnsupportedCircuit
        );

        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.authority = ctx.accounts.authority.key();
        buffer.circuit_id = circuit_id;
        buffer.proof_size = proof_size;
        buffer.bytes_written = 0;
        buffer.verified = false;
        buffer.public_inputs_hash = [0u8; 32];
        buffer.deep_ali_verified = false;
        Ok(())
    }

    /// Write a chunk of proof bytes to the buffer.
    pub fn write_proof_chunk(
        ctx: Context<WriteProofChunk>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.proof_buffer;

        require!(
            !buffer.verified,
            StarkVerifierError::AlreadyVerified
        );
        require!(
            offset as usize + data.len() <= buffer.proof_size as usize,
            StarkVerifierError::ChunkOutOfBounds
        );

        let new_written = offset + data.len() as u32;
        buffer.bytes_written = buffer.bytes_written.max(new_written);

        let info = buffer.to_account_info();
        let mut account_data = info.data.borrow_mut();
        let start = ProofBuffer::PROOF_DATA_OFFSET + offset as usize;
        let end = start + data.len();
        // [SEAM] The bound above is against `proof_size`, the DECLARED size.
        // `init_proof_buffer` caps its allocation at `MAX_INIT_SIZE = 10_240`
        // (`init_space`) whatever `proof_size` says, so until
        // `resize_proof_buffer` has been called enough times the account is
        // SHORTER than `proof_size` and this slice indexes past its end. That
        // was an unhandled panic, not an error — same failure, worse
        // diagnosis, and one that a client cannot distinguish from a bug in its
        // own chunking.
        require!(
            end <= account_data.len(),
            StarkVerifierError::ChunkOutOfBounds
        );
        account_data[start..end].copy_from_slice(&data);

        Ok(())
    }

    /// Verify the STARK proof stored in the buffer.
    ///
    /// For circuit 0 (subscriber_ownership): public_inputs = [commitment]
    /// For circuit 1 (pool_commitment): public_inputs = [nullifier, commitment]
    /// For circuit 2 (balance_proof): public_inputs = [commitment, token_mint]
    /// For circuit 3 (merkle_path): public_inputs = [leaf, root]
    pub fn verify_stark_proof(
        ctx: Context<VerifyStarkProof>,
        commitment: u64,
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.proof_buffer;

        require!(
            !buffer.verified,
            StarkVerifierError::AlreadyVerified
        );
        require!(
            buffer.bytes_written >= buffer.proof_size,
            StarkVerifierError::IncompleteProof
        );

        let circuit_id = buffer.circuit_id;

        // Read proof bytes from account
        let info = buffer.to_account_info();
        let account_data = info.data.borrow();
        let proof_start = ProofBuffer::PROOF_DATA_OFFSET;
        let proof_end = proof_start + buffer.proof_size as usize;
        let proof_bytes = &account_data[proof_start..proof_end];

        if circuit_id == CIRCUIT_SUBSCRIBER_OWNERSHIP {
            // Legacy path for backward compatibility
            let proof = CompactStarkProof::from_bytes(proof_bytes)
                .ok_or(StarkVerifierError::DeserializationError)?;
            let commitment_felt = Felt::new(commitment);
            verify::verify_subscriber_ownership(&proof, commitment_felt)
                .map_err(|_| StarkVerifierError::InvalidProof)?;
        } else {
            // Generic path for new circuits
            let config = get_circuit_config(circuit_id)
                .ok_or(StarkVerifierError::UnsupportedCircuit)?;
            let proof = GenericCompactProof::from_bytes(proof_bytes, config)
                .ok_or(StarkVerifierError::DeserializationError)?;

            // Build public inputs array from commitment parameter
            // For circuits with multiple public inputs, they're packed into the commitment field
            // or passed via additional accounts. For now, use commitment as primary input.
            let public_inputs = vec![commitment];

            verify::verify_generic(&proof, circuit_id, &public_inputs, config)
                .map_err(|_| StarkVerifierError::InvalidProof)?;
        }

        // Compute hash of public inputs to bind them to the proof buffer.
        // Uses sol_sha256 syscall on BPF — always-active, ~85 CU/call.
        // [SEAM] Same encoder as every other write site: `vec![commitment]` here
        // is byte-identical to what `verify_stark_proof_v2` stores for a
        // one-element `public_inputs`, so a buffer produced by either path is
        // indistinguishable to phase 2 and to consumers. That is deliberate and
        // harmless only because the generic branch above can no longer succeed:
        // every circuit 1..=6 declares an arity of 2 or more
        // (`verify::expected_public_input_count`), so `verify_generic` with one
        // input now fails closed at the boundary check instead of asserting the
        // missing inputs against zero.
        let public_inputs_hash = hash_public_inputs(&[commitment]);

        // Mark verified and store public inputs hash
        drop(account_data);
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.verified = true;
        buffer.public_inputs_hash = public_inputs_hash;

        msg!("STARK proof verified for circuit {}", circuit_id);
        Ok(())
    }

    /// Verify a STARK proof with multiple public inputs.
    ///
    /// Used for circuits that need more than one public input value.
    ///
    /// **Circuits 1..=6 only.** `circuit_id == 0` is refused here, not routed:
    /// C0 has exactly one verifier, the legacy `verify_stark_proof` path, and the
    /// generic path cannot verify an honest C0 proof (wrong vanishing polynomial,
    /// no recomputation of C0's folded boundary term). See
    /// `verify::VerifyError::CircuitZeroIsLegacyOnly`. Four shipped instructions
    /// hard-require `circuit_id == 0`
    /// (`zk_shielded::{pause,resume,cancel_private_stark}`,
    /// `p01_quantum_wallet/src/stark.rs:42`), so the legacy path stays and this
    /// one says no.
    pub fn verify_stark_proof_v2(
        ctx: Context<VerifyStarkProof>,
        public_inputs: Vec<u64>,
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.proof_buffer;

        require!(
            !buffer.verified,
            StarkVerifierError::AlreadyVerified
        );
        require!(
            buffer.bytes_written >= buffer.proof_size,
            StarkVerifierError::IncompleteProof
        );

        let circuit_id = buffer.circuit_id;
        // [C0 GATE] Fail before touching the proof bytes. `verify::verify_generic`
        // refuses circuit 0 as well; this is the same refusal surfaced as a named
        // Anchor error instead of a generic `InvalidProof`.
        require!(
            circuit_id != CIRCUIT_SUBSCRIBER_OWNERSHIP,
            StarkVerifierError::CircuitZeroIsLegacyOnly
        );
        let config = get_circuit_config(circuit_id)
            .ok_or(StarkVerifierError::UnsupportedCircuit)?;

        // Read proof bytes
        let info = buffer.to_account_info();
        let account_data = info.data.borrow();
        let proof_start = ProofBuffer::PROOF_DATA_OFFSET;
        let proof_end = proof_start + buffer.proof_size as usize;
        let proof_bytes = &account_data[proof_start..proof_end];

        let proof = GenericCompactProof::from_bytes(proof_bytes, config)
            .ok_or(StarkVerifierError::DeserializationError)?;

        verify::verify_generic(&proof, circuit_id, &public_inputs, config)
            .map_err(|_| StarkVerifierError::InvalidProof)?;

        // Compute hash of all public inputs via one sol_sha256 syscall.
        let public_inputs_hash = hash_public_inputs(&public_inputs);

        // Mark verified and store public inputs hash
        drop(account_data);
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.verified = true;
        buffer.public_inputs_hash = public_inputs_hash;

        msg!("STARK proof verified for circuit {}", circuit_id);
        Ok(())
    }

    /// [P2.2a/P2.2e/P2.2g] Phase 2: DEEP-ALI check at OOD for any generic
    /// circuit (3-6). Must run AFTER `verify_stark_proof_v2` has marked
    /// `verified = true` — split into a second instruction because phase 1
    /// (Merkle + FRI + per-query transitions) alone already approaches or
    /// exceeds Solana's 1.4M CU per-instruction cap for width=6 trace=512
    /// and width=10 circuits.
    ///
    /// DEEP-ALI binds the full AIR's transition constraints (10-23 depending
    /// on circuit) to the opened OOD trace via Schwartz–Zippel over a random
    /// z, closing the soundness gap left by trace-aligned-only per-query
    /// checks (only ~24% of blowup-16 query positions land on trace-aligned
    /// rows — without OOD RLC, the prover could fabricate non-honest
    /// transitions on the unopened 76% of rows).
    ///
    /// Public inputs must be supplied again (not stored in the buffer to save
    /// space) and must equal those used in phase 1 — the transcript binding
    /// in `derive_rlc_alpha_with_tag` means any mismatch changes α and fails
    /// the DEEP-ALI identity.
    pub fn verify_deep_ali_phase2(
        ctx: Context<VerifyStarkProof>,
        public_inputs: Vec<u64>,
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.proof_buffer;

        require!(
            buffer.verified,
            StarkVerifierError::NotYetVerified
        );
        require!(
            !buffer.deep_ali_verified,
            StarkVerifierError::AlreadyVerified
        );
        // [P2.2g] Phase 2 applies to circuits 1-6. Only C0 (subscriber_ownership,
        // width=3 trace=32) still runs DEEP-ALI inside phase 1 — its footprint
        // is tiny (~200K CU total). All other circuits were phase-split after
        // the P2.2f RLC-α-in-transcript change tipped C1/C2 phase 1 past 1.4M
        // CU (their DEEP-ALI used to live inside `verify_constraints_*`).
        let circuit_id = buffer.circuit_id;
        require!(
            matches!(circuit_id, 1 | 2 | 3 | 4 | 5 | 6),
            StarkVerifierError::UnsupportedCircuit
        );

        // Bind to the exact same public inputs as phase 1 via the hash stored
        // when phase 1 completed. Prevents a caller from changing public
        // inputs between phases (would otherwise change α silently).
        let public_inputs_hash = hash_public_inputs(&public_inputs);
        require!(
            public_inputs_hash == buffer.public_inputs_hash,
            StarkVerifierError::InvalidProof
        );

        let config = get_circuit_config(circuit_id)
            .ok_or(StarkVerifierError::UnsupportedCircuit)?;

        // Read proof bytes
        let info = buffer.to_account_info();
        let account_data = info.data.borrow();
        let proof_start = ProofBuffer::PROOF_DATA_OFFSET;
        let proof_end = proof_start + buffer.proof_size as usize;
        let proof_bytes = &account_data[proof_start..proof_end];

        let proof = GenericCompactProof::from_bytes(proof_bytes, config)
            .ok_or(StarkVerifierError::DeserializationError)?;

        match circuit_id {
            1 => verify::verify_deep_ali_circuit_1(&proof, &public_inputs),
            2 => verify::verify_deep_ali_circuit_2(&proof, &public_inputs),
            3 => verify::verify_deep_ali_circuit_3(&proof, &public_inputs),
            4 => verify::verify_deep_ali_circuit_4(&proof, &public_inputs),
            5 => verify::verify_deep_ali_circuit_5(&proof, &public_inputs),
            6 => verify::verify_deep_ali_circuit_6(&proof, &public_inputs),
            _ => unreachable!("circuit_id gated by matches! above"),
        }
        .map_err(|_| StarkVerifierError::InvalidProof)?;

        drop(account_data);
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.deep_ali_verified = true;

        msg!("DEEP-ALI phase 2 verified for circuit {}", circuit_id);
        Ok(())
    }

    /// [P2.2a/P2.2e] Legacy name for `verify_deep_ali_phase2`, pinned to
    /// circuit 6 for existing clients that already built txs against this
    /// discriminator. New code should use `verify_deep_ali_phase2`.
    pub fn verify_merkle_update_deep_ali(
        ctx: Context<VerifyStarkProof>,
        public_inputs: Vec<u64>,
    ) -> Result<()> {
        require!(
            ctx.accounts.proof_buffer.circuit_id == CIRCUIT_MERKLE_UPDATE,
            StarkVerifierError::UnsupportedCircuit
        );
        verify_deep_ali_phase2(ctx, public_inputs)
    }

    /// Resize a proof buffer to accommodate larger proofs (>10KB).
    /// Must be called after init_proof_buffer when proof_size > 10190.
    pub fn resize_proof_buffer(
        ctx: Context<ResizeProofBuffer>,
    ) -> Result<()> {
        // Reallocation is handled by Anchor's realloc constraint.
        // We just need to verify state.
        let buffer = &ctx.accounts.proof_buffer;
        require!(
            !buffer.verified,
            StarkVerifierError::AlreadyVerified
        );
        Ok(())
    }

    /// Close the proof buffer and return rent to authority.
    pub fn close_proof_buffer(
        _ctx: Context<CloseProofBuffer>,
    ) -> Result<()> {
        Ok(())
    }

    /// Phase C v1 — Initialize a proof buffer WITHOUT exposing circuit_id at
    /// init time. The buffer's PDA seed uses a 16-byte caller-supplied nonce
    /// instead of `[circuit_id]`, and `circuit_id` is stored as a sentinel
    /// (u8::MAX = "unknown") until `verify_uniform` probes it.
    ///
    /// Combined with `verify_uniform` and uniform-padding (mobile pads proofs
    /// to a fixed N bytes regardless of circuit), an indexer cannot infer
    /// which circuit the user is proving from the init/chunk/verify tx
    /// envelopes. Closes leaks L13 (circuit_id) + L14 (proof_size variable).
    pub fn init_proof_buffer_v2(
        ctx: Context<InitProofBufferV2>,
        proof_size: u32,
        _nonce: [u8; 16],
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.authority = ctx.accounts.authority.key();
        // Sentinel: circuit_id is unknown until verify_uniform probes it.
        buffer.circuit_id = u8::MAX;
        buffer.proof_size = proof_size;
        buffer.bytes_written = 0;
        buffer.verified = false;
        buffer.public_inputs_hash = [0u8; 32];
        buffer.deep_ali_verified = false;
        Ok(())
    }

    /// Phase C v1 — Verify a STARK proof without exposing `circuit_id` in the
    /// instruction data. Probes the V3 active circuit configs in fixed order
    /// (1, 3, 5, 6) — the first config whose `from_bytes` succeeds is the
    /// candidate. After parse succeeds, runs ONE `verify_generic` against
    /// that config; if it fails, errors (does NOT fall through to the next
    /// config — that would multiply CU cost beyond the 1.4M cap).
    ///
    /// CU cost: ~3-12K CU for failed parses (length-check arithmetic only)
    /// + ~700K-1.3M CU for the matched circuit's verify_generic. Stays under
    /// the per-ix 1.4M cap.
    ///
    /// On success, stores the discovered `circuit_id` in the buffer for
    /// downstream `verify_deep_ali_phase2` consumption.
    pub fn verify_uniform(
        ctx: Context<VerifyStarkProof>,
        public_inputs: Vec<u64>,
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.proof_buffer;
        require!(!buffer.verified, StarkVerifierError::AlreadyVerified);
        require!(
            buffer.bytes_written >= buffer.proof_size,
            StarkVerifierError::IncompleteProof
        );

        let info = buffer.to_account_info();
        let account_data = info.data.borrow();
        let proof_start = ProofBuffer::PROOF_DATA_OFFSET;
        let proof_end = proof_start + buffer.proof_size as usize;
        let proof_bytes = &account_data[proof_start..proof_end];

        // Probe order: V3 active circuits only (1=pool_commitment, 3=merkle_path,
        // 5=transfer, 6=merkle_update). C0/C2/C4 are not used in V3 hot paths.
        //
        // [C0 GATE] C0 must never appear in this list. It is not a "not needed
        // yet" omission: `verify::verify_generic` refuses circuit 0 outright, so
        // adding 0 here would only produce a probe that always errors. C0 goes
        // through `verify_stark_proof`.
        //
        // [SEAM 2026-08-02] What this comment used to say was stale and its
        // mechanism was wrong, so it is restated from measurement.
        //
        // Stale: "C3 and C5 share IDENTICAL config bytes (tw=6, …)". C5's trace
        // width is **7**, not 6, since the value-conservation rebake added the
        // signed-amount accumulator column. C3 and C5 have differed for a while.
        //
        // Wrong mechanism: "probing C6 first means its strict tw=10 length
        // checks reject any C3/C5-shaped proof". Length rejects almost nothing
        // here. `from_bytes` has no length equality — it accepts any buffer at
        // least as long as the proof and ignores the tail — and the client pads
        // EVERY proof to `UNIFORM_PROOF_SIZE = 145_000`, so all seven circuits
        // present exactly 145,000 bytes to this probe. Length discriminates
        // nothing.
        //
        // What DOES separate them, measured rather than asserted: two
        // exact-value fields, `num_fri_layers == folds - 1` (1 byte) and
        // `fri_final_poly_size == 16` (2 bytes), plus canonicity on `k + 16`
        // felts — all read at offsets that `trace_width`, `merkle_depth` and
        // `quotient_segments` determine. A foreign buffer reads them off bytes
        // that mean something else (Merkle roots, OOD evaluations) and has to
        // hit them by luck. `num_queries` was added to the parser by the seam
        // pass and is NOT part of this: reverting it leaves both matrices
        // diagonal (see `compact_proof.rs` for the measurement).
        //
        // The uncomfortable half, also measured
        // (`no_two_configs_share_the_tuple_the_parser_can_observe`): for C1/C2
        // and for C3/C5/C6 every wire-visible exact-value field is IDENTICAL and
        // the pairs are separated by `trace_width` ALONE — a field that never
        // travels on the wire. So the separation is ~5 exact bytes, i.e. roughly
        // 2^40 proof regenerations to force a mis-probe. Not a practical attack,
        // but probabilistic, not structural. Nothing binds circuit identity
        // cryptographically: the Fiat-Shamir transcript carries no circuit id
        // and there is no verifying-key hash in this program at all
        // (`the_transcript_does_not_bind_the_circuit_only_the_step4_dispatch_does`).
        //
        // MEASURED, `tests/cross_circuit_confusion.rs`: across all 7×7 ordered
        // pairs, under BOTH the exact-length and the 145,000-byte padded
        // envelope, and under every prefix length, no genuine proof for one
        // circuit parses under another circuit's config. The probe order is
        // therefore not load-bearing for correctness on honest inputs. Do not add
        // a circuit here without re-running that matrix.
        //
        // [C0 GATE] 0 stays out of this list, see above.
        const PROBE_ORDER: [u8; 4] = [1, 6, 3, 5];

        let mut matched: Option<(u8, GenericCompactProof)> = None;
        for &cid in PROBE_ORDER.iter() {
            let config = match get_circuit_config(cid) {
                Some(c) => c,
                None => continue,
            };
            if let Some(proof) = GenericCompactProof::from_bytes(proof_bytes, config) {
                matched = Some((cid, proof));
                break;
            }
        }

        let (circuit_id, proof) = matched.ok_or(StarkVerifierError::DeserializationError)?;
        let config = get_circuit_config(circuit_id)
            .ok_or(StarkVerifierError::UnsupportedCircuit)?;

        verify::verify_generic(&proof, circuit_id, &public_inputs, config)
            .map_err(|_| StarkVerifierError::InvalidProof)?;

        // Hash public inputs to bind them to the buffer for phase-2 use.
        let public_inputs_hash = hash_public_inputs(&public_inputs);

        drop(account_data);
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.circuit_id = circuit_id; // post-hoc; was u8::MAX
        buffer.verified = true;
        buffer.public_inputs_hash = public_inputs_hash;

        msg!("verify_uniform: probed circuit {}", circuit_id);
        Ok(())
    }
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
#[instruction(proof_size: u32, circuit_id: u8)]
pub struct InitProofBuffer<'info> {
    #[account(
        init,
        payer = authority,
        // Cap init allocation at 10KB; use resize_proof_buffer for larger proofs
        space = ProofBuffer::init_space(proof_size as usize),
        seeds = [b"stark_proof", authority.key().as_ref(), &[circuit_id]],
        bump,
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Phase C v1 init buffer — seeds use a 16-byte nonce instead of circuit_id.
#[derive(Accounts)]
#[instruction(proof_size: u32, nonce: [u8; 16])]
pub struct InitProofBufferV2<'info> {
    #[account(
        init,
        payer = authority,
        space = ProofBuffer::init_space(proof_size as usize),
        seeds = [b"stark_proof_v2", authority.key().as_ref(), &nonce],
        bump,
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResizeProofBuffer<'info> {
    #[account(
        mut,
        has_one = authority,
        realloc = (proof_buffer.to_account_info().data_len() + ProofBuffer::MAX_REALLOC_STEP)
            .min(ProofBuffer::space(proof_buffer.proof_size as usize)),
        realloc::payer = authority,
        realloc::zero = false,
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteProofChunk<'info> {
    #[account(mut, has_one = authority)]
    pub proof_buffer: Account<'info, ProofBuffer>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct VerifyStarkProof<'info> {
    #[account(mut, has_one = authority)]
    pub proof_buffer: Account<'info, ProofBuffer>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseProofBuffer<'info> {
    #[account(
        mut,
        has_one = authority,
        close = authority,
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

// ============================================================================
// State
// ============================================================================

#[account]
pub struct ProofBuffer {
    pub authority: Pubkey,
    pub circuit_id: u8,
    pub proof_size: u32,
    pub bytes_written: u32,
    pub verified: bool,
    /// Blake3 hash of the verified public inputs.
    /// Set after successful verification so consumers can confirm
    /// which inputs were actually proven.
    pub public_inputs_hash: [u8; 32],
    /// [P2.2a] Phase-2 DEEP-ALI verification flag. For circuits that need a
    /// separate DEEP-ALI instruction (currently circuit 6 only) this is
    /// advanced by `verify_merkle_update_deep_ali` after phase 1 has marked
    /// `verified = true`. Consumers (zk_shielded, etc.) must require both
    /// `verified` and `deep_ali_verified` for circuit 6 proofs.
    pub deep_ali_verified: bool,
}

impl ProofBuffer {
    pub const PROOF_DATA_OFFSET: usize = 8 + 32 + 1 + 4 + 4 + 1 + 32 + 1; // 83
    pub const MAX_INIT_SIZE: usize = 10_240; // 10KB Solana create_account limit
    /// Max growth per realloc call (Solana's MAX_PERMITTED_DATA_INCREASE = 10KB).
    /// `resize_proof_buffer` is called iteratively to reach arbitrarily large proof sizes.
    pub const MAX_REALLOC_STEP: usize = 10_240;

    pub fn space(proof_size: usize) -> usize {
        Self::PROOF_DATA_OFFSET + proof_size
    }

    /// Capped space for init (max 10KB). For larger proofs, use resize_proof_buffer after init.
    pub fn init_space(proof_size: usize) -> usize {
        let full = Self::PROOF_DATA_OFFSET + proof_size;
        if full <= Self::MAX_INIT_SIZE { full } else { Self::MAX_INIT_SIZE }
    }
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum StarkVerifierError {
    #[msg("Proof has already been verified")]
    AlreadyVerified,
    #[msg("Proof chunk exceeds buffer bounds")]
    ChunkOutOfBounds,
    #[msg("Proof upload incomplete")]
    IncompleteProof,
    #[msg("Invalid proof: verification failed")]
    InvalidProof,
    #[msg("Failed to deserialize proof bytes")]
    DeserializationError,
    #[msg("Unsupported circuit ID")]
    UnsupportedCircuit,
    #[msg("Proof has not been verified yet")]
    NotYetVerified,
    /// [C0 GATE] `circuit_id == 0` reached a generic entry point.
    ///
    /// C0 is verified only by `verify_stark_proof` (the legacy single-instruction
    /// path). The generic path cannot verify an honest C0 proof, so accepting the
    /// call and failing inside would be indistinguishable from a bad proof.
    #[msg("Circuit 0 is verified only by the legacy verify_stark_proof path")]
    CircuitZeroIsLegacyOnly,
}
