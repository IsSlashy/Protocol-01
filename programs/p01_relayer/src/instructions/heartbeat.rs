use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::RelayerNode;

/// Update `last_active_slot` on the relayer node. Called by the worker
/// every ~60 s so mobile clients' liveness filter sees the node as active
/// even when no jobs have been completed recently.
///
/// Emits `HeartbeatEvent` for indexers.
#[derive(Accounts)]
pub struct Heartbeat<'info> {
    /// The relayer's operator — must sign.
    pub operator: Signer<'info>,

    /// Relayer node PDA. Boxed to keep the 1184-byte ML-KEM key off the SBF
    /// stack (same pattern as complete_job.rs).
    #[account(
        mut,
        seeds = [RelayerNode::SEED_PREFIX, operator.key().as_ref()],
        bump = relayer_node.bump,
        has_one = operator @ RelayerError::Unauthorized,
        constraint = relayer_node.is_active @ RelayerError::RelayerNotActive,
    )]
    pub relayer_node: Box<Account<'info, RelayerNode>>,
}

pub fn handler(ctx: Context<Heartbeat>) -> Result<()> {
    let clock = Clock::get()?;
    let relayer_node = &mut ctx.accounts.relayer_node;

    relayer_node.last_active_slot = clock.slot;

    emit!(HeartbeatEvent {
        operator: relayer_node.operator,
        slot: clock.slot,
    });

    Ok(())
}

#[event]
pub struct HeartbeatEvent {
    pub operator: Pubkey,
    pub slot: u64,
}
