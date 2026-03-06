use anchor_lang::prelude::*;

use crate::errors::RelayerError;
use crate::state::RelayerNode;

/// Rotate the relayer's encryption keys (X25519 and/or ML-KEM-768).
///
/// Only the operator can update their own relayer's keys.
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
    new_kem_encryption_key: Option<Vec<u8>>,
) -> Result<()> {
    let relayer_node = &mut ctx.accounts.relayer_node;
    relayer_node.encryption_key = new_encryption_key;

    if let Some(kem_key) = new_kem_encryption_key {
        require!(
            kem_key.len() == crate::state::relayer_node::KEM_PUBLIC_KEY_SIZE,
            RelayerError::InvalidEncryptionKey
        );
        relayer_node.has_kem_key = true;
        relayer_node.kem_encryption_key.copy_from_slice(&kem_key);
    }
    // If None, leave KEM key unchanged (allows rotating only the X25519 key)

    msg!(
        "Relayer encryption key(s) updated: operator={}",
        relayer_node.operator
    );

    Ok(())
}
