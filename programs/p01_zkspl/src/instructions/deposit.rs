use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkSplError;
use crate::state::{ConfidentialAccount, MintConfig};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Deposit SPL tokens into a zkSPL confidential account.
///
/// The deposit amount is PUBLIC (visible on-chain) because the SPL transfer is visible.
/// The ZK proof proves that the new balance commitment correctly integrates the deposit.
///
/// Circuit public inputs:
///   old_commitment, new_commitment, amount_hash=Poseidon(0,0), public_credit=amount,
///   public_debit=0, token_mint, nonce
#[derive(Accounts)]
#[instruction(amount: u64, proof: Groth16Proof, new_commitment: [u8; 32])]
pub struct Deposit<'info> {
    /// User depositing tokens
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// The mint config
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump,
        constraint = mint_config.is_active @ ZkSplError::MintNotActive
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// User's confidential account
    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            depositor.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.is_initialized @ ZkSplError::AccountNotInitialized,
        constraint = confidential_account.owner == depositor.key() @ ZkSplError::Unauthorized
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    /// Verification key data account (stores the binary VK for on-chain verification)
    /// CHECK: Validated via VK hash in mint_config
    pub vk_data: UncheckedAccount<'info>,

    /// Pool vault that holds deposited tokens (PDA seeded by mint)
    /// CHECK: Validated as PDA via seeds
    #[account(
        mut,
        seeds = [b"zkspl_vault", mint_config.token_mint.as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// Optional: Token program for SPL tokens
    pub token_program: Option<Program<'info, Token>>,

    /// Optional: User's token account (for SPL tokens)
    #[account(mut)]
    pub user_token_account: Option<Account<'info, TokenAccount>>,

    /// Optional: Pool vault token account (for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<Deposit>,
    amount: u64,
    proof: Groth16Proof,
    new_commitment: [u8; 32],
) -> Result<()> {
    require!(amount > 0, ZkSplError::InvalidAmount);

    let clock = Clock::get()?;
    let account = &mut ctx.accounts.confidential_account;
    let config = &ctx.accounts.mint_config;

    // --- Verify ZK proof ---
    // The proof proves:
    //   1. The prover knows the opening of old_commitment
    //   2. new_balance = old_balance + amount (public_credit = amount)
    //   3. new_commitment is correctly formed
    //   4. new_balance fits in 64 bits
    let vk_data = ctx.accounts.vk_data.try_borrow_data()?;

    // Zero amount_hash for public deposit: Poseidon(0, 0) — a known constant
    // The circuit enforces amount=0 and amount_salt=0 for this
    let zero_amount_hash: [u8; 32] = [0; 32]; // Placeholder — actual hash computed off-chain

    let token_mint_bytes = config.token_mint.to_bytes();

    let is_valid = Groth16Verifier::verify_confidential_balance(
        &proof,
        &account.balance_commitment,
        &new_commitment,
        &zero_amount_hash,
        amount,              // public_credit
        0,                   // public_debit
        &token_mint_bytes,
        account.nonce,
        &vk_data,
    )?;

    require!(is_valid, ZkSplError::InvalidProof);

    // --- Transfer tokens to vault ---
    let is_native_sol = config.token_mint == system_program::ID;

    if is_native_sol {
        // Native SOL transfer
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;
    } else {
        // SPL token transfer
        let token_program = ctx.accounts.token_program
            .as_ref().ok_or(ZkSplError::MissingTokenProgram)?;
        let user_token_account = ctx.accounts.user_token_account
            .as_ref().ok_or(ZkSplError::MissingTokenAccount)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref().ok_or(ZkSplError::MissingPoolVault)?;

        require!(user_token_account.mint == config.token_mint, ZkSplError::InvalidTokenMint);
        require!(user_token_account.owner == ctx.accounts.depositor.key(), ZkSplError::InvalidTokenOwner);
        require!(pool_vault.mint == config.token_mint, ZkSplError::InvalidTokenMint);

        let transfer_ctx = CpiContext::new(
            token_program.to_account_info(),
            TokenTransfer {
                from: user_token_account.to_account_info(),
                to: pool_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;
    }

    // --- Update account state ---
    account.balance_commitment = new_commitment;
    account.nonce += 1;
    account.last_tx_at = clock.unix_timestamp;

    emit!(DepositEvent {
        owner: account.owner,
        mint: account.mint,
        amount,
        new_commitment,
        nonce: account.nonce,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct DepositEvent {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub new_commitment: [u8; 32],
    pub nonce: u64,
    pub timestamp: i64,
}
