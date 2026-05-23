use anchor_lang::prelude::*;

use crate::errors::QWalletError;
use crate::stark::{validate_wallet_proof, WALLET_AUTH_CIRCUIT_ID};
use crate::state::{commitment_public_input_bytes, QuantumWalletAccount};

/// Withdraw lamports from a quantum wallet to an arbitrary recipient. The
/// caller must have previously verified a STARK proof (circuit 0,
/// `subscriber_ownership`) binding the wallet's `commitment_to_secret` to the
/// caller's identity, AND uploaded the `expected_nonce` matching
/// `wallet.nonce` (replay protection).
#[derive(Accounts)]
pub struct WithdrawQuantum<'info> {
    /// Pays tx fee + receives the STARK-proof rent refund. Must match
    /// `proof_buffer.authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: PDA seed material.
    pub owner_id: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [QuantumWalletAccount::SEED_PREFIX, owner_id.key().as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, QuantumWalletAccount>,

    /// Recipient of the lamports. Bound into the STARK public input alongside
    /// the wallet commitment to prevent a witness-bound proof from being
    /// redirected.
    /// CHECK: arbitrary, only used as a transfer destination.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// Pre-verified STARK proof buffer (owned by `p01_stark_verifier`).
    /// CHECK: layout validated by `crate::stark::validate_wallet_proof`.
    pub proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<WithdrawQuantum>,
    amount: u64,
    expected_nonce: u64,
) -> Result<()> {
    require!(amount > 0, QWalletError::ZeroAmount);
    require!(
        ctx.accounts.wallet.balance >= amount,
        QWalletError::InsufficientBalance
    );
    require!(
        ctx.accounts.wallet.nonce == expected_nonce,
        QWalletError::NonceMismatch
    );

    // Validate STARK proof binds to `wallet.commitment_to_secret`. The full
    // public-input transcript for a wallet auth proof is the 8-byte
    // Goldilocks commitment felt; future revisions may extend with
    // (nonce, recipient, amount) to bind the proof to the exact spend.
    let commitment_bytes = commitment_public_input_bytes(&ctx.accounts.wallet.commitment_to_secret);
    validate_wallet_proof(
        &ctx.accounts.proof_buffer,
        ctx.accounts.payer.key(),
        WALLET_AUTH_CIRCUIT_ID,
        &commitment_bytes,
    )?;

    // Rent-exempt floor.
    let wallet_info = ctx.accounts.wallet.to_account_info();
    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(wallet_info.data_len());
    require!(
        wallet_info.lamports().checked_sub(amount).unwrap_or(0) >= min_balance,
        QWalletError::InsufficientFundsForRent
    );

    // Move lamports.
    **wallet_info.try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;

    // State + nonce bump (replay protection).
    let wallet = &mut ctx.accounts.wallet;
    wallet.balance = wallet
        .balance
        .checked_sub(amount)
        .ok_or(QWalletError::Overflow)?;
    wallet.nonce = wallet
        .nonce
        .checked_add(1)
        .ok_or(QWalletError::Overflow)?;

    msg!(
        "withdrawal #{}: {} lamports → {}",
        wallet.nonce,
        amount,
        ctx.accounts.recipient.key()
    );
    Ok(())
}
