use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::RelayerNode;

/// Rotate the relayer's X25519 encryption key.
///
/// Only the operator can update their own relayer's encryption key.
/// The relayer must be active.
#[derive(Accounts)]
pub struct UpdateRelayerKey<'info> {
    /// Must be the relayer's operator
    pub operator: Signer<'info>,

    /// Relayer node to update
    #[account(
        mut,
        seeds = [RelayerNode::SEED_PREFIX, operator.key().as_ref()],
        bump = relayer_node.bump,
        has_one = operator @ RelayerError::Unauthorized,
        constraint = relayer_node.is_active @ RelayerError::RelayerNotActive
    )]
    pub relayer_node: Account<'info, RelayerNode>,
}

pub fn handler(
    ctx: Context<UpdateRelayerKey>,
    new_encryption_key: [u8; 32],
) -> Result<()> {
    let relayer_node = &mut ctx.accounts.relayer_node;
    relayer_node.encryption_key = new_encryption_key;

    msg!(
        "Relayer encryption key updated: operator={}",
        relayer_node.operator
    );

    Ok(())
}
