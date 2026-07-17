use anchor_lang::prelude::*;

use crate::errors::P01Error;
use crate::state::{StealthAccountV2, MLKEM768_CIPHERTEXT_LEN};

/// Write a slice of the ML-KEM-768 ciphertext into a v2 stealth announcement.
///
/// The 1088-byte ciphertext does not fit in one instruction, so the sender
/// streams it in chunks (typically 2). Bound to the same
/// `["stealth_v2", sender, stealth_address]` PDA created by `init_stealth_v2`,
/// so only the original sender can fill it.
#[derive(Accounts)]
#[instruction(stealth_address: Pubkey, offset: u16)]
pub struct WriteStealthKemChunk<'info> {
    pub sender: Signer<'info>,

    #[account(
        mut,
        seeds = [StealthAccountV2::SEED_PREFIX, sender.key().as_ref(), stealth_address.as_ref()],
        bump = stealth_account.bump,
        constraint = !stealth_account.claimed @ P01Error::StealthAlreadyClaimed,
    )]
    pub stealth_account: Account<'info, StealthAccountV2>,
}

pub fn handler(
    ctx: Context<WriteStealthKemChunk>,
    _stealth_address: Pubkey,
    offset: u16,
    chunk: Vec<u8>,
) -> Result<()> {
    let offset = offset as usize;
    let end = offset
        .checked_add(chunk.len())
        .ok_or(P01Error::ArithmeticOverflow)?;

    // Must stay within the fixed 1088-byte ciphertext field.
    if end > MLKEM768_CIPHERTEXT_LEN {
        return Err(P01Error::InvalidKemCiphertextLength.into());
    }
    if chunk.is_empty() {
        return Err(P01Error::InvalidAccountData.into());
    }

    let stealth_account = &mut ctx.accounts.stealth_account;
    stealth_account.kem_ciphertext[offset..end].copy_from_slice(&chunk);

    msg!("wrote KEM chunk [{}..{}]", offset, end);
    Ok(())
}
