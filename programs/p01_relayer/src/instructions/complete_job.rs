use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::{JobStatus, RelayJob, RelayerConfig, RelayerNode};

/// Complete a relay job after successfully submitting the transaction.
///
/// Only the assigned relayer's operator can call this. The fee is split
/// between the protocol wallet and the relayer. The job account is closed
/// and rent is returned to the original submitter.
#[derive(Accounts)]
pub struct CompleteJob<'info> {
    /// Relayer's operator wallet (receives relayer reward)
    #[account(mut)]
    pub operator: Signer<'info>,

    /// Relayer config (for fee calculation and global stats)
    #[account(
        mut,
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump
    )]
    pub config: Account<'info, RelayerConfig>,

    /// The relayer node completing the job. Boxed — keeps the 1184-byte
    /// ML-KEM-768 key field off the SBF stack (see submit_job.rs).
    #[account(
        mut,
        seeds = [RelayerNode::SEED_PREFIX, operator.key().as_ref()],
        bump = relayer_node.bump,
        has_one = operator @ RelayerError::Unauthorized,
    )]
    pub relayer_node: Box<Account<'info, RelayerNode>>,

    /// The job being completed. Boxed — `RelayJob` carries a 1280-byte Vec.
    #[account(
        mut,
        seeds = [RelayJob::SEED_PREFIX, job.job_id.as_ref()],
        bump = job.bump,
        constraint = job.status as u8 == JobStatus::Pending as u8 @ RelayerError::JobNotPending,
        constraint = job.assigned_relayer == relayer_node.key() @ RelayerError::InvalidRelayerAssignment,
        close = submitter
    )]
    pub job: Box<Account<'info, RelayJob>>,

    /// Protocol fee wallet (receives protocol cut)
    /// CHECK: validated against config.protocol_fee_wallet
    #[account(
        mut,
        constraint = protocol_fee_wallet.key() == config.protocol_fee_wallet @ RelayerError::Unauthorized
    )]
    pub protocol_fee_wallet: UncheckedAccount<'info>,

    /// Original job submitter (receives rent back from closed account)
    /// CHECK: validated against job.submitter
    #[account(
        mut,
        constraint = submitter.key() == job.submitter @ RelayerError::InvalidSubmitter
    )]
    pub submitter: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<CompleteJob>, tx_signature: [u8; 64]) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;
    let job = &mut ctx.accounts.job;
    let relayer_node = &mut ctx.accounts.relayer_node;

    // Ensure job hasn't expired
    require!(clock.slot <= job.deadline_slot, RelayerError::JobExpired);

    // Calculate fee split
    let protocol_fee = config.protocol_fee_for(job.fee_lamports);
    let relayer_reward = job
        .fee_lamports
        .checked_sub(protocol_fee)
        .ok_or(RelayerError::ArithmeticOverflow)?;

    // Transfer protocol fee from job PDA to protocol wallet
    if protocol_fee > 0 {
        job.to_account_info().sub_lamports(protocol_fee)?;
        ctx.accounts
            .protocol_fee_wallet
            .to_account_info()
            .add_lamports(protocol_fee)?;
    }

    // Transfer relayer reward from job PDA to operator
    if relayer_reward > 0 {
        job.to_account_info().sub_lamports(relayer_reward)?;
        ctx.accounts
            .operator
            .to_account_info()
            .add_lamports(relayer_reward)?;
    }

    // Update job status
    job.status = JobStatus::Completed;

    // Update relayer stats
    relayer_node.jobs_completed = relayer_node.jobs_completed.saturating_add(1);
    relayer_node.last_active_slot = clock.slot;
    relayer_node.increase_reputation(100);

    // Update global stats
    config.total_jobs_completed = config.total_jobs_completed.saturating_add(1);

    msg!(
        "Job completed: relayer={}, reward={}, sig={:?}",
        relayer_node.operator,
        relayer_reward,
        &tx_signature[..8]
    );

    emit!(JobCompletedEvent {
        job_id: job.job_id,
        relayer: relayer_node.key(),
        tx_signature,
        relayer_reward,
        protocol_fee,
    });

    Ok(())
}

#[event]
pub struct JobCompletedEvent {
    pub job_id: [u8; 32],
    pub relayer: Pubkey,
    pub tx_signature: [u8; 64],
    pub relayer_reward: u64,
    pub protocol_fee: u64,
}
