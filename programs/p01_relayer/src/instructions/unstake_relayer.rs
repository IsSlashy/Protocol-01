use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::{RelayerConfig, RelayerNode};

/// Withdraw stake after the cooldown period has elapsed.
///
/// The relayer must be deactivated and the cooldown must have passed.
/// Stake lamports are transferred from the relayer_node PDA back to
/// the operator, and the relayer_node account is closed (rent returned).
#[derive(Accounts)]
pub struct UnstakeRelayer<'info> {
    /// Must be the relayer's operator (receives stake + rent)
    #[account(mut)]
    pub operator: Signer<'info>,

    /// Relayer config (for cooldown_slots)
    #[account(
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump
    )]
    pub config: Account<'info, RelayerConfig>,

    /// Relayer node to close. Stake + rent returned to operator.
    #[account(
        mut,
        seeds = [RelayerNode::SEED_PREFIX, operator.key().as_ref()],
        bump = relayer_node.bump,
        has_one = operator @ RelayerError::Unauthorized,
        constraint = !relayer_node.is_active @ RelayerError::RelayerStillActive,
        close = operator
    )]
    pub relayer_node: Account<'info, RelayerNode>,

    /// System program
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<UnstakeRelayer>) -> Result<()> {
    let clock = Clock::get()?;
    let relayer_node = &ctx.accounts.relayer_node;
    let config = &ctx.accounts.config;

    // Validate cooldown period has elapsed
    require!(
        relayer_node.can_unstake(clock.slot, config.cooldown_slots),
        RelayerError::CooldownNotElapsed
    );

    msg!(
        "Relayer unstaked: operator={}, stake={} returned",
        relayer_node.operator,
        relayer_node.stake
    );

    // Note: The `close = operator` constraint handles transferring all
    // remaining lamports (stake + rent) back to the operator when the
    // account is closed at the end of the instruction.

    Ok(())
}
