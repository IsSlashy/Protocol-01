use anchor_lang::prelude::*;

mod compact_proof;
mod goldilocks;
mod merkle;
mod poseidon_consts;
mod verify;

use compact_proof::{CompactStarkProof, GenericCompactProof, get_circuit_config};
use goldilocks::Felt;

declare_id!("EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z");

pub const CIRCUIT_SUBSCRIBER_OWNERSHIP: u8 = 0;
pub const CIRCUIT_POOL_COMMITMENT: u8 = 1;
pub const CIRCUIT_BALANCE_PROOF: u8 = 2;
pub const CIRCUIT_MERKLE_PATH: u8 = 3;

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
            circuit_id <= CIRCUIT_MERKLE_PATH,
            StarkVerifierError::UnsupportedCircuit
        );

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

        let new_written = offset + data.len() as u32;
        buffer.bytes_written = buffer.bytes_written.max(new_written);

        let info = buffer.to_account_info();
        let mut account_data = info.data.borrow_mut();
        let start = ProofBuffer::PROOF_DATA_OFFSET + offset as usize;
        let end = start + data.len();
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

        // Mark verified
        drop(account_data);
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.verified = true;

        msg!("STARK proof verified for circuit {}", circuit_id);
        Ok(())
    }

    /// Verify a STARK proof with multiple public inputs.
    ///
    /// Used for circuits that need more than one public input value.
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

        // Mark verified
        drop(account_data);
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.verified = true;

        msg!("STARK proof verified for circuit {}", circuit_id);
        Ok(())
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

#[derive(Accounts)]
pub struct ResizeProofBuffer<'info> {
    #[account(
        mut,
        has_one = authority,
        realloc = ProofBuffer::space(proof_buffer.proof_size as usize),
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
}

impl ProofBuffer {
    pub const PROOF_DATA_OFFSET: usize = 8 + 32 + 1 + 4 + 4 + 1; // 50
    pub const MAX_INIT_SIZE: usize = 10_240; // 10KB Solana create_account limit

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
}
