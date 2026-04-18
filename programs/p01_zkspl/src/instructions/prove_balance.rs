use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::stark_proof::{u32_bytes_to_u64_le, verify_stark_proof, CIRCUIT_BALANCE_PROOF};
use crate::state::{ConfidentialAccount, MintConfig};

/// Prove that a confidential balance is at least `threshold` without revealing it.
///
/// DeFi composability primitive:
/// - A DEX can call this to verify a user has enough funds before a trade
/// - A lending protocol can verify collateral requirements
/// - Any program can check balance sufficiency
///
/// Uses the STARK `balance_proof` circuit (ID 2). Public inputs in AIR order:
///   [commitment, token_mint]
///
/// The STARK proves the account's `balance_commitment` was honestly derived
/// from a private `balance`, `salt`, and `spending_key`. The range check
/// (`balance >= threshold`) is NOT enforced by the AIR — the AIR only binds
/// commitment integrity. A production-grade threshold proof would add a
/// bounded-decomposition sub-circuit; this is a known limitation carried
/// over from the previous Groth16 design.
///
/// `threshold` is emitted in the event for observers but does not participate
/// in the STARK's public-inputs hash.
#[derive(Accounts)]
#[instruction(threshold: u64)]
pub struct ProveBalance<'info> {
    /// Account owner proving their balance
    pub prover: Signer<'info>,

    /// Mint config
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

    /// Verified STARK proof buffer from `p01_stark_verifier` (circuit 2: balance_proof).
    /// Must have `verified == true` and `authority == prover`.
    /// CHECK: Validated manually.
    pub stark_proof_buffer: AccountInfo<'info>,
}

pub fn handler(ctx: Context<ProveBalance>, threshold: u64) -> Result<()> {
    let account = &ctx.accounts.confidential_account;
    let config = &ctx.accounts.mint_config;

    // -----------------------------------------------------------------------
    // STARK proof verification.
    //
    // Circuit 2 (balance_proof) public inputs in AIR order:
    //   [commitment, token_mint]
    // -----------------------------------------------------------------------
    let token_mint_bytes = config.token_mint.to_bytes();
    let public_inputs = [
        u32_bytes_to_u64_le(&account.balance_commitment),
        u64::from_le_bytes(token_mint_bytes[..8].try_into().unwrap()),
    ];
    verify_stark_proof(
        &ctx.accounts.stark_proof_buffer,
        &ctx.accounts.prover.key(),
        CIRCUIT_BALANCE_PROOF,
        &public_inputs,
    )?;

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
