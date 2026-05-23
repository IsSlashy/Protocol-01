use anchor_lang::prelude::*;

use crate::errors::QWalletError;
use crate::stark::{validate_wallet_proof, WALLET_AUTH_CIRCUIT_ID};
use crate::state::{commitment_public_input_bytes, QuantumWalletAccount};

/// Move lamports between two quantum wallets. Identical auth model to
/// `withdraw`, but the destination is another `QuantumWalletAccount` PDA so
/// the funds never re-enter an Ed25519-controlled account.
///
/// Privacy note: both source and destination are visible on-chain. For an
/// unlinkable transfer between two PQ wallets, route the lamports through a
/// shielded denominated pool — `zk_shielded` handles that flow today.
#[derive(Accounts)]
pub struct TransferQuantum<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: source wallet PDA seed material.
    pub src_owner_id: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [QuantumWalletAccount::SEED_PREFIX, src_owner_id.key().as_ref()],
        bump = src_wallet.bump,
    )]
    pub src_wallet: Account<'info, QuantumWalletAccount>,

    /// CHECK: destination wallet PDA seed material.
    pub dst_owner_id: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [QuantumWalletAccount::SEED_PREFIX, dst_owner_id.key().as_ref()],
        bump = dst_wallet.bump,
    )]
    pub dst_wallet: Account<'info, QuantumWalletAccount>,

    /// CHECK: STARK proof buffer, validated in handler.
    pub proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<TransferQuantum>,
    amount: u64,
    expected_nonce: u64,
) -> Result<()> {
    require!(amount > 0, QWalletError::ZeroAmount);
    require!(
        ctx.accounts.src_wallet.balance >= amount,
        QWalletError::InsufficientBalance
    );
    require!(
        ctx.accounts.src_wallet.nonce == expected_nonce,
        QWalletError::NonceMismatch
    );
    require!(
        ctx.accounts.src_wallet.key() != ctx.accounts.dst_wallet.key(),
        QWalletError::ProofInputsMismatch
    );

    let commitment_bytes =
        commitment_public_input_bytes(&ctx.accounts.src_wallet.commitment_to_secret);
    validate_wallet_proof(
        &ctx.accounts.proof_buffer,
        ctx.accounts.payer.key(),
        WALLET_AUTH_CIRCUIT_ID,
        &commitment_bytes,
    )?;

    // Rent-exempt floor on source.
    let src_info = ctx.accounts.src_wallet.to_account_info();
    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(src_info.data_len());
    require!(
        src_info.lamports().checked_sub(amount).unwrap_or(0) >= min_balance,
        QWalletError::InsufficientFundsForRent
    );

    let dst_info = ctx.accounts.dst_wallet.to_account_info();
    **src_info.try_borrow_mut_lamports()? -= amount;
    **dst_info.try_borrow_mut_lamports()? += amount;

    // Source side: bump nonce + decrement balance.
    let src = &mut ctx.accounts.src_wallet;
    src.balance = src
        .balance
        .checked_sub(amount)
        .ok_or(QWalletError::Overflow)?;
    src.nonce = src
        .nonce
        .checked_add(1)
        .ok_or(QWalletError::Overflow)?;

    // Destination side: credit balance (no proof needed — receiving is open).
    let dst = &mut ctx.accounts.dst_wallet;
    dst.balance = dst
        .balance
        .checked_add(amount)
        .ok_or(QWalletError::Overflow)?;

    msg!(
        "quantum→quantum transfer: {} lamports, src nonce now {}",
        amount,
        src.nonce
    );
    Ok(())
}
