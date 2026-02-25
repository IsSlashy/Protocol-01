use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::state::{ConfidentialAccount, MintConfig, PendingCredit};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Private transfer: sender reduces their balance, creates a pending credit for recipient.
///
/// The transfer amount is HIDDEN. Only the amount_hash is stored on-chain.
/// The recipient must later call apply_pending to integrate the credit.
///
/// Circuit public inputs (sender's proof):
///   old_commitment, new_commitment, amount_hash, public_credit=0,
///   public_debit=0, token_mint, nonce
///
/// The sender also provides amount_hash which the recipient will verify.
#[derive(Accounts)]
#[instruction(proof: Groth16Proof, new_commitment: [u8; 32], amount_hash: [u8; 32])]
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

    /// Verification key data
    /// CHECK: Validated via VK hash
    pub vk_data: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<ConfidentialTransfer>,
    proof: Groth16Proof,
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

    // --- Verify sender's ZK proof ---
    // Proves: sender correctly reduced their balance by `amount`
    // is_debit = 1 in the circuit
    let vk_data = ctx.accounts.vk_data.try_borrow_data()?;
    let token_mint_bytes = config.token_mint.to_bytes();

    let is_valid = Groth16Verifier::verify_confidential_balance(
        &proof,
        &sender_account.balance_commitment,
        &new_commitment,
        &amount_hash,
        0,  // public_credit = 0 (private transfer)
        0,  // public_debit = 0 (private transfer)
        &token_mint_bytes,
        sender_account.nonce,
        &vk_data[12..],  // skip 8-byte discriminator + 4-byte size header
    )?;

    require!(is_valid, ZkSplError::InvalidProof);

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
