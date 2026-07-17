use anchor_lang::prelude::*;

use crate::errors::P01Error;
use crate::state::{StealthAccountV2, MLKEM768_CIPHERTEXT_LEN};

/// Initialize a v2 hybrid stealth announcement account (native SOL).
///
/// The single-shot `send_private_v2` cannot be used because passing the full
/// 1088-byte ML-KEM-768 ciphertext as instruction data pushes the transaction
/// past the 1232-byte cap. This instruction only writes the small header
/// (~132 bytes); the ciphertext is filled afterwards with
/// `write_stealth_kem_chunk`.
///
/// The payment funds themselves are a plain `SystemProgram::transfer` to the
/// one-time `stealth_address` (a normal account controlled by the recipient's
/// derived key) — the client adds that transfer instruction alongside this one.
/// This announcement PDA only stores the metadata a recipient needs to detect
/// and derive the payment.
///
/// # Seeds
/// `["stealth_v2", sender.key(), stealth_address.as_ref()]`
#[derive(Accounts)]
#[instruction(amount: u64, ephemeral_pub_key: [u8; 32], stealth_address: Pubkey, view_tag: u8)]
pub struct InitStealthV2<'info> {
    /// The sender of the payment (pays the announcement PDA rent).
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The v2 stealth announcement PDA (~1220 bytes, holds the KEM ciphertext).
    #[account(
        init,
        payer = sender,
        space = StealthAccountV2::LEN,
        seeds = [StealthAccountV2::SEED_PREFIX, sender.key().as_ref(), stealth_address.as_ref()],
        bump
    )]
    pub stealth_account: Account<'info, StealthAccountV2>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitStealthV2>,
    amount: u64,
    ephemeral_pub_key: [u8; 32],
    stealth_address: Pubkey,
    view_tag: u8,
) -> Result<()> {
    if amount == 0 {
        return Err(P01Error::InvalidStreamAmount.into());
    }
    if ephemeral_pub_key == [0u8; 32] {
        return Err(P01Error::InvalidEphemeralPubKey.into());
    }
    if stealth_address == Pubkey::default() {
        return Err(P01Error::InvalidStealthAddress.into());
    }

    let clock = Clock::get()?;
    let stealth_account = &mut ctx.accounts.stealth_account;
    let bump = ctx.bumps.stealth_account;

    // Header only — kem_ciphertext stays zeroed until the chunks are written.
    // token_mint = default() marks a native-SOL payment.
    stealth_account.initialize(
        ephemeral_pub_key,
        stealth_address,
        view_tag,
        amount,
        Pubkey::default(),
        clock.slot,
        clock.unix_timestamp,
        bump,
        [0u8; MLKEM768_CIPHERTEXT_LEN],
    );

    msg!("v2 stealth announcement initialized (header); awaiting KEM chunks");
    Ok(())
}
