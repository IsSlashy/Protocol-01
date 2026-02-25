use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::state::{ConfidentialAccount, MintConfig};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Prove that a confidential balance is at least `threshold` without revealing it.
///
/// This is the DeFi composability primitive:
/// - A DEX can call this to verify a user has enough funds before a trade
/// - A lending protocol can verify collateral requirements
/// - Any program can check balance sufficiency
///
/// Circuit public inputs (balance_proof circuit):
///   balance_commitment, threshold, token_mint
///
/// The proof is verified and an event is emitted. Other programs can
/// check the event or use CPI to verify.
#[derive(Accounts)]
#[instruction(threshold: u64, proof: Groth16Proof)]
pub struct ProveBalance<'info> {
    /// Account owner proving their balance
    pub prover: Signer<'info>,

    /// Mint config (for proof VK hash)
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// The confidential account
    #[account(
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            prover.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.is_initialized @ ZkSplError::AccountNotInitialized,
        constraint = confidential_account.owner == prover.key() @ ZkSplError::Unauthorized
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    /// Balance proof verification key data
    /// CHECK: Validated via proof_vk_hash in mint_config
    pub vk_data: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<ProveBalance>,
    threshold: u64,
    proof: Groth16Proof,
) -> Result<()> {
    let account = &ctx.accounts.confidential_account;
    let config = &ctx.accounts.mint_config;

    // --- Verify balance sufficiency proof ---
    let vk_data = ctx.accounts.vk_data.try_borrow_data()?;
    let token_mint_bytes = config.token_mint.to_bytes();

    let is_valid = Groth16Verifier::verify_balance_proof(
        &proof,
        &account.balance_commitment,
        threshold,
        &token_mint_bytes,
        &vk_data[12..],  // skip 8-byte discriminator + 4-byte size header
    )?;

    require!(is_valid, ZkSplError::InvalidProof);

    // Emit event for other programs to observe
    emit!(BalanceProofEvent {
        owner: account.owner,
        mint: config.token_mint,
        threshold,
        verified: true,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!("Balance proof verified: {} has >= {} tokens", account.owner, threshold);

    Ok(())
}

#[event]
pub struct BalanceProofEvent {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub threshold: u64,
    pub verified: bool,
    pub timestamp: i64,
}
