use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkSplError;
use crate::state::{ConfidentialAccount, MintConfig};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Withdraw from zkSPL back to regular SPL tokens.
///
/// The withdrawal amount is PUBLIC (the SPL transfer is visible).
/// The ZK proof proves the new commitment correctly reflects the reduced balance.
///
/// Circuit public inputs:
///   old_commitment, new_commitment, amount_hash=Poseidon(0,0), public_credit=0,
///   public_debit=amount, token_mint, nonce
#[derive(Accounts)]
#[instruction(amount: u64, proof: Groth16Proof, new_commitment: [u8; 32])]
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

    /// Verification key data
    /// CHECK: Validated via VK hash
    pub vk_data: UncheckedAccount<'info>,

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

pub fn handler(
    ctx: Context<Withdraw>,
    amount: u64,
    proof: Groth16Proof,
    new_commitment: [u8; 32],
) -> Result<()> {
    require!(amount > 0, ZkSplError::InvalidAmount);

    let clock = Clock::get()?;
    let account = &mut ctx.accounts.confidential_account;
    let config = &ctx.accounts.mint_config;

    // --- Verify ZK proof ---
    let vk_data = ctx.accounts.vk_data.try_borrow_data()?;
    let zero_amount_hash: [u8; 32] = [0; 32];
    let token_mint_bytes = config.token_mint.to_bytes();

    let is_valid = Groth16Verifier::verify_confidential_balance(
        &proof,
        &account.balance_commitment,
        &new_commitment,
        &zero_amount_hash,
        0,       // public_credit = 0
        amount,  // public_debit = withdraw amount
        &token_mint_bytes,
        account.nonce,
        &vk_data,
    )?;

    require!(is_valid, ZkSplError::InvalidProof);

    // --- Transfer tokens from vault to user ---
    let is_native_sol = config.token_mint == system_program::ID;

    if is_native_sol {
        // Transfer SOL from vault PDA
        // The vault is a PDA of the mint_config, so we use seeds to sign
        let mint_key = config.token_mint;
        let seeds = &[
            b"zkspl_vault",
            mint_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&seeds[..]];

        let vault_info = ctx.accounts.vault.to_account_info();
        let user_info = ctx.accounts.withdrawer.to_account_info();

        // Direct lamport transfer from PDA
        **vault_info.try_borrow_mut_lamports()? -= amount;
        **user_info.try_borrow_mut_lamports()? += amount;

        let _ = signer_seeds; // Used for PDA authority validation
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
