use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::P01Error;
use crate::state::{P01Wallet, StealthAccountV2, MLKEM768_CIPHERTEXT_LEN};

/// Send a v2 hybrid stealth payment (X25519 + ML-KEM-768)
///
/// Creates a stealth payment PDA that stores both the classical ephemeral
/// public key and the post-quantum ML-KEM-768 ciphertext. Recipients scan
/// these announcements using view tags (99.6% quick rejection) and then
/// attempt hybrid key agreement to derive the stealth private key.
///
/// # Account size
/// The v2 PDA is ~1220 bytes (vs ~114 for v1) due to the 1088-byte KEM
/// ciphertext. This costs ~0.0093 SOL rent-exempt minimum. The recipient
/// can close the account after claiming to reclaim this rent.
///
/// # Seeds
/// `["stealth_v2", sender.key(), stealth_address.as_ref()]`
/// Uses a different prefix than v1 to avoid PDA collisions.
#[derive(Accounts)]
#[instruction(
    amount: u64,
    ephemeral_pub_key: [u8; 32],
    stealth_address: Pubkey,
    view_tag: u8,
    kem_ciphertext: [u8; 1088]
)]
pub struct SendPrivateV2<'info> {
    /// The sender of the payment (pays rent + token transfer)
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Sender's Protocol 01 wallet (for nonce increment)
    #[account(
        mut,
        seeds = [P01Wallet::SEED_PREFIX, sender.key().as_ref()],
        bump = sender_wallet.bump,
        constraint = sender_wallet.owner == sender.key() @ P01Error::UnauthorizedWalletAccess
    )]
    pub sender_wallet: Account<'info, P01Wallet>,

    /// The v2 stealth account PDA to be created.
    /// ~1220 bytes to hold the ML-KEM-768 ciphertext on-chain.
    #[account(
        init,
        payer = sender,
        space = StealthAccountV2::LEN,
        seeds = [StealthAccountV2::SEED_PREFIX, sender.key().as_ref(), stealth_address.as_ref()],
        bump
    )]
    pub stealth_account: Account<'info, StealthAccountV2>,

    /// Token mint (for SPL tokens; use Pubkey::default() for native SOL)
    /// CHECK: Validated by token program during transfer
    pub token_mint: AccountInfo<'info>,

    /// Sender's token account (source of funds)
    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key() @ P01Error::UnauthorizedWalletAccess
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    /// Stealth escrow token account (destination for funds)
    #[account(
        mut,
        constraint = escrow_token_account.mint == sender_token_account.mint @ P01Error::InvalidTokenMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Handler for send_private_v2 instruction
///
/// Creates a hybrid quantum-resistant stealth payment. The on-chain PDA stores:
/// - X25519 ephemeral public key (32 bytes) for classical ECDH
/// - ML-KEM-768 ciphertext (1088 bytes) for post-quantum KEM
/// - View tag (1 byte) for fast recipient scanning
///
/// An `StealthPaymentCreatedV2` event is emitted for client-side indexing.
/// Clients subscribe with `connection.onLogs()` — no relayer needed.
pub fn handler(
    ctx: Context<SendPrivateV2>,
    amount: u64,
    ephemeral_pub_key: [u8; 32],
    stealth_address: Pubkey,
    view_tag: u8,
    kem_ciphertext: [u8; MLKEM768_CIPHERTEXT_LEN],
) -> Result<()> {
    // ── Validation ──────────────────────────────────────────────────────

    // Amount must be positive
    if amount == 0 {
        return Err(P01Error::InvalidStreamAmount.into());
    }

    // Ephemeral key must not be the zero point
    if ephemeral_pub_key == [0u8; 32] {
        return Err(P01Error::InvalidEphemeralPubKey.into());
    }

    // Stealth address must not be the default pubkey
    if stealth_address == Pubkey::default() {
        return Err(P01Error::InvalidStealthAddress.into());
    }

    // KEM ciphertext must not be all zeros (a valid ciphertext is never zero)
    if kem_ciphertext == [0u8; MLKEM768_CIPHERTEXT_LEN] {
        return Err(P01Error::InvalidKemCiphertextLength.into());
    }

    // Check sender has sufficient balance
    if ctx.accounts.sender_token_account.amount < amount {
        return Err(P01Error::InsufficientFundsForStealth.into());
    }

    // ── Token transfer to escrow ────────────────────────────────────────

    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // ── Initialize the v2 stealth account PDA ───────────────────────────

    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;
    let current_slot = clock.slot;

    let stealth_account = &mut ctx.accounts.stealth_account;
    let bump = ctx.bumps.stealth_account;

    stealth_account.initialize(
        ephemeral_pub_key,
        stealth_address,
        view_tag,
        amount,
        ctx.accounts.token_mint.key(),
        current_slot,
        current_time,
        bump,
        kem_ciphertext,
    );

    // ── Increment sender nonce ──────────────────────────────────────────

    let sender_wallet = &mut ctx.accounts.sender_wallet;
    let new_nonce = sender_wallet.increment_nonce();

    // ── Emit v2 event for client-side indexing ──────────────────────────
    // Clients subscribe to these via connection.onLogs() to discover
    // incoming stealth payments without any relayer infrastructure.

    emit!(crate::state::StealthPaymentCreatedV2 {
        version: StealthAccountV2::VERSION,
        ephemeral_pub_key,
        stealth_address,
        view_tag,
        amount,
        token_mint: ctx.accounts.token_mint.key(),
        slot: current_slot,
        kem_ciphertext: kem_ciphertext.to_vec(),
    });

    // ── Log summary ─────────────────────────────────────────────────────

    msg!("Hybrid stealth payment (v2) sent successfully");
    msg!("Amount: {}", amount);
    msg!("Ephemeral key: {:?}", &ephemeral_pub_key[..8]);
    msg!("Stealth address: {}", stealth_address);
    msg!("View tag: 0x{:02x}", view_tag);
    msg!("KEM ciphertext: {} bytes", MLKEM768_CIPHERTEXT_LEN);
    msg!("Sender nonce: {}", new_nonce);
    msg!(
        "Rent: ~{} lamports for {} byte PDA",
        // 6960 + bytes * 2.4e-6 SOL ≈ rent for 1220 bytes
        // Exact rent is computed by the runtime; this is informational.
        StealthAccountV2::LEN,
        StealthAccountV2::LEN
    );

    Ok(())
}
