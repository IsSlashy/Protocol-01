use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkSplError;
use crate::stark_proof::{
    u32_bytes_to_u64_le, verify_stark_proof, CIRCUIT_CONFIDENTIAL_BALANCE,
};
use crate::state::{ConfidentialAccount, MintConfig};

/// Withdraw from zkSPL back to regular SPL tokens.
///
/// The withdrawal amount is PUBLIC (the SPL transfer is visible). The STARK
/// proof (circuit `confidential_balance`, ID 4) proves the new commitment
/// correctly reflects a valid balance update.
///
/// STARK circuit 4 public inputs (order matches AIR `to_elements`):
///   [old_commitment, new_commitment, amount_hash, token_mint]
///
/// For withdraw, the "amount" moved is public; the private amount / amount_salt
/// in the STARK are both zero so `amount_hash = Poseidon(0, 0)`.
///
/// NOTE: Same conservation caveat as deposit — see `deposit.rs` for details.
#[derive(Accounts)]
#[instruction(amount: u64, new_commitment: [u8; 32])]
pub struct Withdraw<'info> {
    /// User withdrawing tokens
    #[account(mut)]
    pub withdrawer: Signer<'info>,

    /// Mint config
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// User's confidential account
    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            withdrawer.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.is_initialized @ ZkSplError::AccountNotInitialized,
        constraint = confidential_account.owner == withdrawer.key() @ ZkSplError::Unauthorized
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    /// Verified STARK proof buffer from `p01_stark_verifier` (circuit 4).
    /// Must have `verified == true` and `authority == withdrawer`.
    /// CHECK: Validated manually.
    pub stark_proof_buffer: AccountInfo<'info>,

    /// Vault holding the tokens (PDA seeded by mint)
    /// CHECK: Validated as PDA via seeds
    #[account(
        mut,
        seeds = [b"zkspl_vault", mint_config.token_mint.as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub user_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,
}

/// Poseidon(0, 0) — the canonical zero amount hash (LE bytes).
const ZERO_AMOUNT_HASH: [u8; 32] = [
    100, 72, 182, 70, 132, 238, 57, 168,
    35, 213, 254, 95, 213, 36, 49, 220,
    129, 228, 129, 123, 242, 195, 234, 60,
    171, 158, 35, 158, 251, 245, 152, 32,
];

pub fn handler(
    ctx: Context<Withdraw>,
    amount: u64,
    new_commitment: [u8; 32],
) -> Result<()> {
    require!(amount > 0, ZkSplError::InvalidAmount);

    let clock = Clock::get()?;
    let account = &mut ctx.accounts.confidential_account;
    let config = &ctx.accounts.mint_config;

    // -----------------------------------------------------------------------
    // STARK proof verification.
    //
    // Circuit 4 (confidential_balance) public inputs in AIR order:
    //   [old_commitment, new_commitment, amount_hash, token_mint]
    //
    // For withdraw, amount is public; amount_hash must be Poseidon(0, 0).
    // -----------------------------------------------------------------------
    let token_mint_bytes = config.token_mint.to_bytes();
    let public_inputs = [
        u32_bytes_to_u64_le(&account.balance_commitment),
        u32_bytes_to_u64_le(&new_commitment),
        u32_bytes_to_u64_le(&ZERO_AMOUNT_HASH),
        u64::from_le_bytes(token_mint_bytes[..8].try_into().unwrap()),
    ];
    verify_stark_proof(
        &ctx.accounts.stark_proof_buffer,
        &ctx.accounts.withdrawer.key(),
        CIRCUIT_CONFIDENTIAL_BALANCE,
        &public_inputs,
    )?;

    // --- Transfer tokens from vault to user ---
    let is_native_sol = config.token_mint == system_program::ID;

    if is_native_sol {
        // Transfer SOL from vault PDA via system_program CPI with PDA signer seeds.
        // The vault is system-owned (received SOL via system_program::transfer in deposit),
        // so we must use CPI — direct lamport modification is not allowed.
        let mint_key = config.token_mint;
        let seeds = &[
            b"zkspl_vault",
            mint_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.withdrawer.to_account_info(),
            },
            signer_seeds,
        );
        system_program::transfer(cpi_context, amount)?;
    } else {
        // SPL token transfer from pool vault
        let token_program = ctx.accounts.token_program
            .as_ref().ok_or(ZkSplError::MissingTokenProgram)?;
        let user_token_account = ctx.accounts.user_token_account
            .as_ref().ok_or(ZkSplError::MissingTokenAccount)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref().ok_or(ZkSplError::MissingPoolVault)?;

        require!(user_token_account.mint == config.token_mint, ZkSplError::InvalidTokenMint);
        require!(pool_vault.mint == config.token_mint, ZkSplError::InvalidTokenMint);

        let mint_key = config.token_mint;
        let seeds = &[
            b"zkspl_vault",
            mint_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: pool_vault.to_account_info(),
                to: user_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;
    }

    // --- Update account ---
    account.balance_commitment = new_commitment;
    account.nonce += 1;
    account.last_tx_at = clock.unix_timestamp;

    emit!(WithdrawEvent {
        owner: account.owner,
        mint: config.token_mint,
        amount,
        new_commitment,
        nonce: account.nonce,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct WithdrawEvent {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub new_commitment: [u8; 32],
    pub nonce: u64,
    pub timestamp: i64,
}
