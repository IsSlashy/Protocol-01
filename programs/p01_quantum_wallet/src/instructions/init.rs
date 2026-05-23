use anchor_lang::prelude::*;

use crate::errors::QWalletError;
use crate::state::QuantumWalletAccount;

/// Initialize a quantum-safe wallet.
///
/// `owner_id` is the PDA seed identifier (typically the caller's Ed25519
/// pubkey at the moment of creation). It is NOT a spending key — funds are
/// only releasable by a STARK proof of preimage knowledge of
/// `commitment_to_secret`. The caller can pass an arbitrary pubkey here
/// (e.g. a one-time identifier) without compromising fund security.
#[derive(Accounts)]
#[instruction(commitment_to_secret: [u8; 32], recovery_pubkey: Option<[u8; 32]>)]
pub struct InitQuantumWallet<'info> {
    /// Pays the rent. May or may not equal `owner_id`.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: pure seed material. Bound only via PDA derivation.
    pub owner_id: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = QuantumWalletAccount::SIZE,
        seeds = [QuantumWalletAccount::SEED_PREFIX, owner_id.key().as_ref()],
        bump,
    )]
    pub wallet: Account<'info, QuantumWalletAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitQuantumWallet>,
    commitment_to_secret: [u8; 32],
    recovery_pubkey: Option<[u8; 32]>,
) -> Result<()> {
    require!(
        commitment_to_secret != [0u8; 32],
        QWalletError::ProofInputsMismatch
    );

    let wallet = &mut ctx.accounts.wallet;
    wallet.owner_id = ctx.accounts.owner_id.key();
    wallet.commitment_to_secret = commitment_to_secret;
    wallet.balance = 0;
    wallet.nonce = 0;
    wallet.recovery_pubkey = recovery_pubkey;
    wallet.created_slot = Clock::get()?.slot;
    wallet.bump = ctx.bumps.wallet;

    msg!(
        "quantum wallet initialized — owner_id={}, recovery={}",
        wallet.owner_id,
        wallet.recovery_pubkey.is_some()
    );
    Ok(())
}
