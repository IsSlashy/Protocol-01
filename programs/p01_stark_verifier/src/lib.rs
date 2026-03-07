use anchor_lang::prelude::*;

declare_id!("hqu2QaRpNFbiaTQdThui7X714YdViNKQTsMb7WR7r12");

/// On-chain STARK proof verifier for Protocol 01.
///
/// Verifies FRI-based STARK proofs using only hash operations (Blake3).
/// No elliptic curve pairings needed — quantum-resistant by design.
///
/// # Architecture
///
/// STARK proofs are larger than Groth16 (~8-80KB vs 200 bytes), so they
/// can't be passed inline in a single Solana instruction (max 1232 bytes).
/// Instead, the proof is uploaded to a temporary PDA in chunks, then
/// verified in a separate instruction.
///
/// ## Instruction Flow
///
/// 1. `init_proof_buffer` — Create PDA to hold proof bytes
/// 2. `write_proof_chunk` — Upload proof in 800-byte chunks (multiple txs)
/// 3. `verify_stark_proof` — Verify the complete proof (~1.1M CU)
/// 4. Buffer is closed and rent returned after verification
///
/// # Compute Budget
///
/// STARK verification cost depends on:
/// - Number of FRI queries (32 for 128-bit security)
/// - Hash operations (Blake3, ~150 CU per hash)
/// - Trace width and constraint count
///
/// Estimated: ~800K-1.2M CU for subscriber_ownership circuit
/// Solana max: 1.4M CU per transaction (with priority fees)
///
/// # Status: SCAFFOLD
///
/// This program defines the account structure and instruction interfaces.
/// The actual FRI verification logic will be ported from winter-verifier
/// once the off-chain prover/verifier is fully validated.

#[program]
pub mod p01_stark_verifier {
    use super::*;

    /// Initialize a proof buffer PDA to hold STARK proof bytes.
    pub fn init_proof_buffer(
        ctx: Context<InitProofBuffer>,
        proof_size: u32,
        circuit_id: u8,
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.authority = ctx.accounts.authority.key();
        buffer.circuit_id = circuit_id;
        buffer.proof_size = proof_size;
        buffer.bytes_written = 0;
        buffer.verified = false;
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

        // Update write cursor
        let new_written = offset + data.len() as u32;
        buffer.bytes_written = buffer.bytes_written.max(new_written);

        // Write data to raw account data (after Anchor discriminator + struct fields)
        let info = buffer.to_account_info();
        let mut account_data = info.data.borrow_mut();
        let start = ProofBuffer::PROOF_DATA_OFFSET + offset as usize;
        let end = start + data.len();
        account_data[start..end].copy_from_slice(&data);

        Ok(())
    }

    /// Verify the STARK proof stored in the buffer.
    ///
    /// This is the compute-intensive instruction (~800K-1.2M CU).
    /// The proof buffer must be fully written before calling this.
    pub fn verify_stark_proof(
        ctx: Context<VerifyStarkProof>,
        _public_inputs: Vec<u8>,
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

        // TODO: Implement FRI verification
        // This will be ported from winter-verifier compiled to SBF.
        // For now, mark as scaffold.
        msg!("STARK verification not yet implemented on-chain");
        return Err(StarkVerifierError::NotImplemented.into());
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
        space = ProofBuffer::space(proof_size as usize),
        seeds = [b"stark_proof", authority.key().as_ref(), &[circuit_id]],
        bump,
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteProofChunk<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct VerifyStarkProof<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    pub authority: Signer<'info>,
}

// ============================================================================
// State
// ============================================================================

/// Temporary buffer for STARK proof upload and verification.
///
/// Proofs are uploaded in chunks (max ~800 bytes per instruction),
/// then verified in a single compute-intensive instruction.
#[account]
pub struct ProofBuffer {
    /// Who created this buffer (and can write/verify)
    pub authority: Pubkey,
    /// Which circuit this proof is for (0 = subscriber_ownership, etc.)
    pub circuit_id: u8,
    /// Total expected proof size in bytes
    pub proof_size: u32,
    /// How many bytes have been written so far
    pub bytes_written: u32,
    /// Whether verification has been completed
    pub verified: bool,
    // Proof data follows in the account data (variable length)
}

impl ProofBuffer {
    /// Offset where proof data starts in the account
    const PROOF_DATA_OFFSET: usize = 8 + 32 + 1 + 4 + 4 + 1; // discriminator + fields

    fn space(proof_size: usize) -> usize {
        Self::PROOF_DATA_OFFSET + proof_size
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
    #[msg("STARK verification not yet implemented on-chain")]
    NotImplemented,
    #[msg("Invalid proof: FRI verification failed")]
    InvalidProof,
    #[msg("Public inputs do not match")]
    PublicInputMismatch,
}
