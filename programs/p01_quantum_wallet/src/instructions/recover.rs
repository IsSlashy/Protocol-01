//! Emergency recovery via SPHINCS+ signature.
//!
//! When the user has lost their seed (and therefore cannot produce a STARK
//! proof of preimage knowledge), they fall back to a hash-based,
//! post-quantum SPHINCS+ signature over a recovery payload. Both source
//! (the seed) and destination (the SPHINCS+ key) are needed at init time
//! for this path to be usable later, and the wallet must have been created
//! with `recovery_pubkey = Some(_)`.
//!
//! Lifecycle:
//!   1. `init_sphincs_sig_buffer(SPHINCS_SHA2_128F_SIG_SIZE)` — create PDA.
//!   2. `write_sphincs_sig_chunk` × N — upload the 17,088-byte signature.
//!   3. `emergency_recover(amount, recipient, new_commitment)` — verify +
//!      transfer lamports + rotate the wallet's commitment to a fresh one.
//!   4. `close_sphincs_sig_buffer` — rent refund.
//!
//! SPHINCS+ verify is NOT YET WIRED. The on-chain verify hot path uses
//! ~6,100 SHA-256 syscall invocations (per research notes 2026-05-23) which
//! is feasible but requires a `digest::Digest` adapter that routes through
//! `sol_sha256`. We ship the surface area now and stub the verify to
//! `Err(SphincsVerifierNotWired)` so the build is clean. See
//! `Cargo.toml` TODO.

use anchor_lang::prelude::*;

use crate::errors::QWalletError;
use crate::state::{
    QuantumWalletAccount, SphincsSigBuffer, SPHINCS_SHA2_128F_SIG_SIZE,
};

// ---------------------------------------------------------------------------
// init / write / close — generic buffer plumbing
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(sig_size: u32)]
pub struct InitSphincsSigBuffer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: PDA seed material for the target wallet.
    pub owner_id: AccountInfo<'info>,

    #[account(
        seeds = [QuantumWalletAccount::SEED_PREFIX, owner_id.key().as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, QuantumWalletAccount>,

    #[account(
        init,
        payer = authority,
        space = SphincsSigBuffer::SPACE_SHA2_128F,
        seeds = [
            SphincsSigBuffer::SEED_PREFIX,
            wallet.key().as_ref(),
            authority.key().as_ref(),
        ],
        bump,
    )]
    pub buffer: Account<'info, SphincsSigBuffer>,

    pub system_program: Program<'info, System>,
}

pub fn init_sphincs_sig_buffer_handler(
    ctx: Context<InitSphincsSigBuffer>,
    sig_size: u32,
) -> Result<()> {
    require!(
        sig_size as usize == SPHINCS_SHA2_128F_SIG_SIZE,
        QWalletError::InvalidSphincsSignatureSize
    );
    let buf = &mut ctx.accounts.buffer;
    buf.authority = ctx.accounts.authority.key();
    buf.wallet = ctx.accounts.wallet.key();
    buf.sig_size = sig_size;
    buf.bytes_written = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct WriteSphincsSigChunk<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [
            SphincsSigBuffer::SEED_PREFIX,
            buffer.wallet.as_ref(),
            authority.key().as_ref(),
        ],
        bump,
        has_one = authority,
    )]
    pub buffer: Account<'info, SphincsSigBuffer>,
}

pub fn write_sphincs_sig_chunk_handler(
    ctx: Context<WriteSphincsSigChunk>,
    offset: u32,
    data: Vec<u8>,
) -> Result<()> {
    let buf = &mut ctx.accounts.buffer;
    let end = (offset as usize)
        .checked_add(data.len())
        .ok_or(QWalletError::Overflow)?;
    require!(
        end <= buf.sig_size as usize,
        QWalletError::SphincsChunkOutOfBounds
    );

    buf.bytes_written = buf.bytes_written.max(end as u32);

    let info = buf.to_account_info();
    let mut account_data = info.data.borrow_mut();
    let start = SphincsSigBuffer::SIG_DATA_OFFSET + offset as usize;
    let absolute_end = SphincsSigBuffer::SIG_DATA_OFFSET + end;
    account_data[start..absolute_end].copy_from_slice(&data);
    Ok(())
}

#[derive(Accounts)]
pub struct CloseSphincsSigBuffer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [
            SphincsSigBuffer::SEED_PREFIX,
            buffer.wallet.as_ref(),
            authority.key().as_ref(),
        ],
        bump,
        has_one = authority,
        close = authority,
    )]
    pub buffer: Account<'info, SphincsSigBuffer>,
}

pub fn close_sphincs_sig_buffer_handler(_ctx: Context<CloseSphincsSigBuffer>) -> Result<()> {
    Ok(())
}

// ---------------------------------------------------------------------------
// emergency_recover
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct EmergencyRecover<'info> {
    /// Submits the recovery. Need not be the original `owner_id` — any signer
    /// who holds a valid SPHINCS+ signature can drive recovery, since the
    /// security boundary is the SPHINCS+ key, not the Ed25519 signer.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: PDA seed material.
    pub owner_id: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [QuantumWalletAccount::SEED_PREFIX, owner_id.key().as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, QuantumWalletAccount>,

    /// CHECK: recipient of the lamports.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// Buffer holding the uploaded SPHINCS+ signature.
    #[account(
        mut,
        seeds = [
            SphincsSigBuffer::SEED_PREFIX,
            wallet.key().as_ref(),
            authority.key().as_ref(),
        ],
        bump,
        has_one = authority,
    )]
    pub sig_buffer: Account<'info, SphincsSigBuffer>,

    pub system_program: Program<'info, System>,
}

pub fn emergency_recover_handler(
    ctx: Context<EmergencyRecover>,
    amount: u64,
    new_commitment_to_secret: [u8; 32],
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
    require!(
        new_commitment_to_secret != [0u8; 32],
        QWalletError::ProofInputsMismatch
    );

    // Wallet must have opted in to recovery at init.
    let recovery_pk = ctx
        .accounts
        .wallet
        .recovery_pubkey
        .ok_or(QWalletError::NoRecoveryKey)?;

    let buffer = &ctx.accounts.sig_buffer;
    require!(
        buffer.wallet == ctx.accounts.wallet.key(),
        QWalletError::SphincsBufferWalletMismatch
    );
    require!(
        buffer.sig_size as usize == SPHINCS_SHA2_128F_SIG_SIZE,
        QWalletError::InvalidSphincsSignatureSize
    );
    require!(
        buffer.bytes_written as usize == SPHINCS_SHA2_128F_SIG_SIZE,
        QWalletError::IncompleteSphincsSignature
    );

    // ---- Build the recovery payload ----
    //
    // payload = SHA-256( wallet_pubkey || amount_le || recipient || new_commit || nonce_le )
    //
    // The SPHINCS+ signature must cover this exact byte stream so the same
    // signature cannot be replayed against a different amount, recipient,
    // commitment, or nonce.
    let amount_le = amount.to_le_bytes();
    let nonce_le = ctx.accounts.wallet.nonce.to_le_bytes();
    let payload_hash: [u8; 32] = solana_sha256_hasher::hashv(&[
        ctx.accounts.wallet.key().as_ref(),
        &amount_le,
        ctx.accounts.recipient.key.as_ref(),
        &new_commitment_to_secret,
        &nonce_le,
    ])
    .to_bytes();

    // ---- Verify the SPHINCS+ signature ----
    //
    // STUB. The verify path is being held until `slh-dsa = "=0.1.0"` is wired
    // with a SHA-256 syscall `digest::Digest` adapter. Until then, this
    // instruction returns `SphincsVerifierNotWired` so the account
    // constraints and lifecycle are validated by tests, but no lamports
    // actually move.
    //
    // When wiring:
    //   1. Add `slh-dsa = { version = "=0.1.0", default-features = false }`.
    //   2. Implement `SolanaSha256` that wraps `solana_sha256_hasher::hashv`
    //      behind the `digest::Digest` trait.
    //   3. Box the FORS + hypertree intermediates onto the Solana heap
    //      (`RequestHeapFrame` + `Box<[u8; N]>`) — bare verify blows the
    //      4 KB SBF stack.
    //   4. Read the 17,088-byte signature from `sig_buffer` data starting at
    //      `SphincsSigBuffer::SIG_DATA_OFFSET`.
    //   5. Call `slh_dsa::Sha2_128f::verify(recovery_pk, payload_hash, sig)`.
    //   6. Expect ~1.2M CU. If >1.4M, split FORS / hypertree across two ixs.
    let _ = (recovery_pk, payload_hash);
    return Err(QWalletError::SphincsVerifierNotWired.into());

    // ---- Once verify is live, the post-verify mutations look like this ----
    // (kept here for clarity; unreachable today.)
    //
    // let wallet_info = ctx.accounts.wallet.to_account_info();
    // let rent = Rent::get()?;
    // let min_balance = rent.minimum_balance(wallet_info.data_len());
    // require!(
    //     wallet_info.lamports().checked_sub(amount).unwrap_or(0) >= min_balance,
    //     QWalletError::InsufficientFundsForRent
    // );
    // **wallet_info.try_borrow_mut_lamports()? -= amount;
    // **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;
    //
    // let wallet = &mut ctx.accounts.wallet;
    // wallet.balance = wallet.balance.checked_sub(amount).ok_or(QWalletError::Overflow)?;
    // wallet.commitment_to_secret = new_commitment_to_secret;
    // wallet.nonce = wallet.nonce.checked_add(1).ok_or(QWalletError::Overflow)?;
    //
    // msg!("emergency recovery: {} lamports → {}, nonce now {}", amount, ctx.accounts.recipient.key(), wallet.nonce);
    // Ok(())
}
