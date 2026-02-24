use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::state::{ConfidentialAccount, MintConfig};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Apply a pending credit to the recipient's balance.
///
/// The recipient decrypts the amount off-chain, then proves they correctly
/// integrated it into their balance commitment.
///
/// Circuit public inputs (recipient's proof):
///   old_commitment, new_commitment, amount_hash, public_credit=0,
///   public_debit=0, token_mint, nonce
///
/// The amount_hash must match one of the pending credits.
#[derive(Accounts)]
#[instruction(proof: Groth16Proof, new_commitment: [u8; 32], amount_hash: [u8; 32])]
pub struct ApplyPending<'info> {
    /// Recipient (account owner)
    pub recipient: Signer<'info>,

    /// Mint config
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Recipient's confidential account
    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            recipient.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.is_initialized @ ZkSplError::AccountNotInitialized,
        constraint = confidential_account.owner == recipient.key() @ ZkSplError::Unauthorized
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    /// Verification key data
    /// CHECK: Validated via VK hash
    pub vk_data: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<ApplyPending>,
    proof: Groth16Proof,
    new_commitment: [u8; 32],
    amount_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let account = &mut ctx.accounts.confidential_account;
    let config = &ctx.accounts.mint_config;

    // --- Find and remove matching pending credit ---
    let credit_index = account.pending_credits.iter()
        .position(|c| c.amount_hash == amount_hash)
        .ok_or(ZkSplError::PendingCreditNotFound)?;

    // --- Verify recipient's ZK proof ---
    // Proves: recipient correctly added `amount` to their balance
    // is_debit = 0 in the circuit (receiving)
    let vk_data = ctx.accounts.vk_data.try_borrow_data()?;
    let token_mint_bytes = config.token_mint.to_bytes();

    let is_valid = Groth16Verifier::verify_confidential_balance(
        &proof,
        &account.balance_commitment,
        &new_commitment,
        &amount_hash,
        0,  // public_credit = 0
        0,  // public_debit = 0
        &token_mint_bytes,
        account.nonce,
        &vk_data,
    )?;

    require!(is_valid, ZkSplError::InvalidProof);

    // --- Update account ---
    account.balance_commitment = new_commitment;
    account.nonce += 1;
    account.last_tx_at = clock.unix_timestamp;

    // Remove the applied pending credit
    account.pending_credits.remove(credit_index);

    emit!(ApplyPendingEvent {
        owner: account.owner,
        mint: config.token_mint,
        amount_hash,
        nonce: account.nonce,
        remaining_pending: account.pending_credits.len() as u8,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct ApplyPendingEvent {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount_hash: [u8; 32],
    pub nonce: u64,
    pub remaining_pending: u8,
    pub timestamp: i64,
}
