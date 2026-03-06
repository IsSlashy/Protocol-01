use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::RelayerError;
use crate::state::{RelayerConfig, RelayerNode};

/// Register a new relayer node by staking SOL.
///
/// The operator stakes `config.min_stake` lamports which are held by the
/// relayer_node PDA. The relayer starts with reputation 5000 (out of 10000).
///
/// PDA: [b"relayer_node", operator.key().as_ref()]
#[derive(Accounts)]
pub struct RegisterRelayer<'info> {
    /// Operator wallet funding the stake
    #[account(mut)]
    pub operator: Signer<'info>,

    /// Relayer config (must be active, must have capacity)
    #[account(
        mut,
        seeds = [RelayerConfig::SEED_PREFIX],
        bump = config.bump,
        constraint = config.is_active @ RelayerError::ProtocolPaused,
        constraint = config.active_relayer_count < config.max_relayers @ RelayerError::MaxRelayersReached
    )]
    pub config: Account<'info, RelayerConfig>,

    /// Relayer node PDA (created on registration)
    #[account(
        init,
        payer = operator,
        space = RelayerNode::LEN,
        seeds = [RelayerNode::SEED_PREFIX, operator.key().as_ref()],
        bump
    )]
    pub relayer_node: Account<'info, RelayerNode>,

    /// System program
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterRelayer>,
    encryption_key: [u8; 32],
    endpoint_hash: [u8; 32],
    kem_encryption_key: Option<Vec<u8>>,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;
    let min_stake = config.min_stake;

    // Transfer stake from operator to relayer_node PDA
    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.operator.to_account_info(),
            to: ctx.accounts.relayer_node.to_account_info(),
        },
    );
    system_program::transfer(transfer_ctx, min_stake)?;

    // Initialize relayer node
    let relayer_node = &mut ctx.accounts.relayer_node;
    relayer_node.operator = ctx.accounts.operator.key();
    relayer_node.encryption_key = encryption_key;
    relayer_node.stake = min_stake;
    relayer_node.jobs_completed = 0;
    relayer_node.jobs_failed = 0;
    relayer_node.last_active_slot = 0;
    relayer_node.registered_at = clock.unix_timestamp;
    relayer_node.deactivated_at_slot = 0;
    relayer_node.is_active = true;
    relayer_node.reputation_score = RelayerNode::INITIAL_REPUTATION;
    relayer_node.endpoint_hash = endpoint_hash;
    relayer_node.bump = ctx.bumps.relayer_node;

    // Set ML-KEM-768 key if provided
    if let Some(kem_key) = kem_encryption_key {
        require!(
            kem_key.len() == crate::state::relayer_node::KEM_PUBLIC_KEY_SIZE,
            RelayerError::InvalidEncryptionKey
        );
        relayer_node.has_kem_key = true;
        relayer_node.kem_encryption_key.copy_from_slice(&kem_key);
    } else {
        relayer_node.has_kem_key = false;
        relayer_node.kem_encryption_key = [0u8; 1184];
    }

    // Update config
    config.active_relayer_count = config
        .active_relayer_count
        .checked_add(1)
        .ok_or(RelayerError::ArithmeticOverflow)?;

    msg!(
        "Relayer registered: operator={}, stake={}",
        relayer_node.operator,
        min_stake
    );

    emit!(RelayerRegisteredEvent {
        relayer: relayer_node.key(),
        operator: relayer_node.operator,
        stake: min_stake,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct RelayerRegisteredEvent {
    pub relayer: Pubkey,
    pub operator: Pubkey,
    pub stake: u64,
    pub timestamp: i64,
}
