use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::stark_proof::{
    u32_bytes_to_u64_le, verify_stark_proof, CIRCUIT_CONFIDENTIAL_BALANCE,
};
use crate::state::{ConfidentialAccount, MintConfig};

/// Apply a pending credit to the recipient's balance.
///
/// The recipient learns the plaintext amount + amount_salt out-of-band from the
/// sender, then proves (via STARK circuit `confidential_balance`, ID 4) that
/// their new commitment correctly integrates a value whose
/// `Poseidon(amount, amount_salt)` matches the stored pending credit.
///
/// STARK circuit 4 public inputs (order matches AIR `to_elements`):
///   [old_commitment, new_commitment, amount_hash, token_mint]
///
/// `amount_hash` must match exactly one of the pending credit entries.
#[derive(Accounts)]
#[instruction(new_commitment: [u8; 32], amount_hash: [u8; 32])]
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

    /// Verified STARK proof buffer from `p01_stark_verifier` (circuit 4).
    /// Must have `verified == true` and `authority == recipient`.
    /// CHECK: Validated manually.
    pub stark_proof_buffer: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<ApplyPending>,
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

    // -----------------------------------------------------------------------
    // STARK proof verification.
    //
    // Circuit 4 (confidential_balance) public inputs in AIR order:
    //   [old_commitment, new_commitment, amount_hash, token_mint]
    // -----------------------------------------------------------------------
    let token_mint_bytes = config.token_mint.to_bytes();
    let public_inputs = [
        u32_bytes_to_u64_le(&account.balance_commitment),
        u32_bytes_to_u64_le(&new_commitment),
        u32_bytes_to_u64_le(&amount_hash),
        u64::from_le_bytes(token_mint_bytes[..8].try_into().unwrap()),
    ];
    verify_stark_proof(
        &ctx.accounts.stark_proof_buffer,
        &ctx.accounts.recipient.key(),
        CIRCUIT_CONFIDENTIAL_BALANCE,
        &public_inputs,
    )?;

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
