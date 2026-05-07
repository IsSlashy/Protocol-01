use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::{JobStatus, RelayChunk, RelayJob, MAX_CHUNK_DATA_SIZE};

/// Phase A.3 — Append a single ciphertext chunk to a chunked relay job.
///
/// Each chunk_index gets its own `RelayChunk` PDA, init'd here. The
/// `chunks_received` counter on the parent `RelayJob` is incremented; once
/// it reaches `total_chunks`, the worker can fetch all `RelayChunk` PDAs
/// (sequenced by chunk_index), concatenate, decrypt, and execute.
///
/// PDA: [b"relay_chunk", job_id.as_ref(), &chunk_index.to_le_bytes()]
///
/// Constraints :
/// - Caller must be the original submitter.
/// - Job must still be `Pending` (no late chunks after expire/cancel/complete).
/// - `chunk_index` must be `< job.total_chunks` and the chunk PDA must be a
///   fresh init (anchor `init` enforces non-existence).
/// - Job must NOT already have all chunks (prevents over-submission).
#[derive(Accounts)]
#[instruction(job_id: [u8; 32], chunk_index: u16, data: Vec<u8>)]
pub struct SubmitChunk<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,

    #[account(
        mut,
        seeds = [RelayJob::SEED_PREFIX, job_id.as_ref()],
        bump = job.bump,
        has_one = submitter @ RelayerError::InvalidSubmitter,
        constraint = job.status as u8 == JobStatus::Pending as u8 @ RelayerError::JobNotPending,
        constraint = job.total_chunks > 0 @ RelayerError::NotChunkedJob,
        constraint = chunk_index < job.total_chunks @ RelayerError::ChunkIndexOutOfRange,
        constraint = job.chunks_received < job.total_chunks @ RelayerError::ChunkAlreadyComplete,
    )]
    pub job: Box<Account<'info, RelayJob>>,

    #[account(
        init,
        payer = submitter,
        space = RelayChunk::LEN,
        seeds = [RelayChunk::SEED_PREFIX, job_id.as_ref(), &chunk_index.to_le_bytes()],
        bump,
    )]
    pub chunk: Box<Account<'info, RelayChunk>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SubmitChunk>,
    job_id: [u8; 32],
    chunk_index: u16,
    data: Vec<u8>,
) -> Result<()> {
    require!(
        data.len() <= MAX_CHUNK_DATA_SIZE,
        RelayerError::ChunkDataTooLarge
    );
    require!(!data.is_empty(), RelayerError::EmptyChunk);

    let chunk = &mut ctx.accounts.chunk;
    chunk.job_id = job_id;
    chunk.chunk_index = chunk_index;
    chunk.data = data;
    chunk.bump = ctx.bumps.chunk;

    let job = &mut ctx.accounts.job;
    job.chunks_received = job
        .chunks_received
        .checked_add(1)
        .ok_or(RelayerError::ArithmeticOverflow)?;

    msg!(
        "Chunk submitted: idx={}/{}, recv={}/{}",
        chunk_index,
        job.total_chunks,
        job.chunks_received,
        job.total_chunks
    );

    Ok(())
}
