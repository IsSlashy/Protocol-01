use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::stark_proof::{
    u32_bytes_to_u64_le, verify_stark_proof, CIRCUIT_CONFIDENTIAL_BALANCE,
};
use crate::state::{ConfidentialAccount, MintConfig, PendingCredit};

/// Private transfer: sender reduces their balance, creates a pending credit
/// for the recipient.
///
/// The transfer amount is HIDDEN on-chain — only the amount_hash is stored.
/// The recipient must later call `apply_pending` (with the plaintext amount
/// + salt received out-of-band) to integrate the credit into their own
/// balance commitment.
///
/// Sender verification uses STARK circuit `confidential_balance` (ID 4),
/// same as deposit / withdraw / apply_pending — this is a commitment update
/// for the sender where the amount is bound by `amount_hash`.
///
/// STARK circuit 4 public inputs (order matches AIR `to_elements`):
///   [old_commitment, new_commitment, amount_hash, token_mint]
///
/// The sender's STARK proves their new_commitment correctly follows from
/// the old commitment and a hidden `amount` whose Poseidon hash equals
/// `amount_hash`. The recipient's apply_pending proof later proves their
/// commitment integrates the same `amount_hash`.
///
/// NOTE: Circuit 5 (`transfer`, UTXO-style with nullifiers) is NOT used here.
/// That circuit belongs to the `zk_shielded` denominated-pool program.
#[derive(Accounts)]
#[instruction(new_commitment: [u8; 32], amount_hash: [u8; 32])]
pub struct ConfidentialTransfer<'info> {
    /// Sender
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Mint config
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump,
        constraint = mint_config.is_active @ ZkSplError::MintNotActive
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Sender's confidential account
    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            sender.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = sender_account.bump,
        constraint = sender_account.is_initialized @ ZkSplError::AccountNotInitialized,
        constraint = sender_account.owner == sender.key() @ ZkSplError::Unauthorized
    )]
    pub sender_account: Account<'info, ConfidentialAccount>,

    /// Recipient's confidential account
    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            recipient_account.owner.as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = recipient_account.bump,
        constraint = recipient_account.is_initialized @ ZkSplError::AccountNotInitialized
    )]
    pub recipient_account: Account<'info, ConfidentialAccount>,

    /// Verified STARK proof buffer from `p01_stark_verifier` (circuit 4:
    /// confidential_balance — sender's balance update).
    /// Must have `verified == true` and `authority == sender`.
    /// CHECK: Validated manually.
    pub stark_proof_buffer: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<ConfidentialTransfer>,
    new_commitment: [u8; 32],
    amount_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let sender_account = &mut ctx.accounts.sender_account;
    let recipient_account = &mut ctx.accounts.recipient_account;
    let config = &ctx.accounts.mint_config;

    // Check recipient has room for pending credits
    require!(
        recipient_account.pending_credits.len() < ConfidentialAccount::MAX_PENDING_CREDITS,
        ZkSplError::TooManyPendingCredits
    );

    // -----------------------------------------------------------------------
    // STARK proof verification (sender side).
    //
    // Circuit 4 (confidential_balance) public inputs in AIR order:
    //   [old_commitment, new_commitment, amount_hash, token_mint]
    // -----------------------------------------------------------------------
    let token_mint_bytes = config.token_mint.to_bytes();
    let public_inputs = [
        u32_bytes_to_u64_le(&sender_account.balance_commitment),
        u32_bytes_to_u64_le(&new_commitment),
        u32_bytes_to_u64_le(&amount_hash),
        u64::from_le_bytes(token_mint_bytes[..8].try_into().unwrap()),
    ];
    verify_stark_proof(
        &ctx.accounts.stark_proof_buffer,
        &ctx.accounts.sender.key(),
        CIRCUIT_CONFIDENTIAL_BALANCE,
        &public_inputs,
    )?;

    // --- Update sender ---
    sender_account.balance_commitment = new_commitment;
    sender_account.nonce += 1;
    sender_account.last_tx_at = clock.unix_timestamp;

    // --- Add pending credit to recipient ---
    recipient_account.pending_credits.push(PendingCredit {
        amount_hash,
        sender: ctx.accounts.sender.key(),
        timestamp: clock.unix_timestamp,
    });

    emit!(TransferEvent {
        sender: sender_account.owner,
        recipient: recipient_account.owner,
        mint: config.token_mint,
        amount_hash,
        sender_nonce: sender_account.nonce,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct TransferEvent {
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount_hash: [u8; 32],
    pub sender_nonce: u64,
    pub timestamp: i64,
}
