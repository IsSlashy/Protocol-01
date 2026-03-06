use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::{RelayerConfig, RelayerNode};

/// Deactivate a relayer node.
///
/// Only the operator can deactivate their own relayer. After deactivation,
/// the relayer stops receiving jobs and must wait `config.cooldown_slots`
/// before unstaking.
#[derive(Accounts)]
pub struct DeactivateRelayer<'info> {
    /// Must be the relayer's operator
    pub operator: Signer<'info>,

    /// Relayer config (for decrementing active count)
    #[account(
        mut,
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump
    )]
    pub config: Account<'info, RelayerConfig>,

    /// Relayer node to deactivate
    #[account(
        mut,
        seeds = [RelayerNode::SEED_PREFIX, operator.key().as_ref()],
        bump = relayer_node.bump,
        has_one = operator @ RelayerError::Unauthorized,
        constraint = relayer_node.is_active @ RelayerError::RelayerNotActive
    )]
    pub relayer_node: Account<'info, RelayerNode>,
}

pub fn handler(ctx: Context<DeactivateRelayer>) -> Result<()> {
    let clock = Clock::get()?;
    let relayer_node = &mut ctx.accounts.relayer_node;
    let config = &mut ctx.accounts.config;

    relayer_node.is_active = false;
    relayer_node.deactivated_at_slot = clock.slot;

    config.active_relayer_count = config.active_relayer_count.saturating_sub(1);

    msg!(
        "Relayer deactivated: operator={}, slot={}",
        relayer_node.operator,
        clock.slot
    );

    Ok(())
}
