use anchor_lang::prelude::*;

use crate::errors::QWalletError;
use crate::stark::{validate_wallet_proof, WALLET_AUTH_CIRCUIT_ID};
use crate::state::{commitment_public_input_bytes, QuantumWalletAccount};

/// Rotate the wallet's spending secret. The caller proves knowledge of the
/// CURRENT preimage via a STARK (circuit 0), and the program replaces the
/// stored commitment with a fresh one supplied off-chain. This is the
/// "hygiene" path you run periodically — and the one the user runs IMMEDIATELY
/// after recovering with SPHINCS+ (so the recovery key can be retired).
#[derive(Accounts)]
pub struct RotateSecret<'info> {
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

    /// CHECK: STARK proof buffer (validated in handler).
    pub proof_buffer: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<RotateSecret>,
    new_commitment_to_secret: [u8; 32],
    expected_nonce: u64,
) -> Result<()> {
    require!(
        new_commitment_to_secret != [0u8; 32],
        QWalletError::ProofInputsMismatch
    );
    require!(
        ctx.accounts.wallet.nonce == expected_nonce,
        QWalletError::NonceMismatch
    );
    require!(
        new_commitment_to_secret != ctx.accounts.wallet.commitment_to_secret,
        QWalletError::ProofInputsMismatch
    );

    let commitment_bytes =
        commitment_public_input_bytes(&ctx.accounts.wallet.commitment_to_secret);
    validate_wallet_proof(
        &ctx.accounts.proof_buffer,
        ctx.accounts.payer.key(),
        WALLET_AUTH_CIRCUIT_ID,
        &commitment_bytes,
    )?;

    let wallet = &mut ctx.accounts.wallet;
    wallet.commitment_to_secret = new_commitment_to_secret;
    wallet.nonce = wallet
        .nonce
        .checked_add(1)
        .ok_or(QWalletError::Overflow)?;

    msg!("secret rotated, nonce now {}", wallet.nonce);
    Ok(())
}
