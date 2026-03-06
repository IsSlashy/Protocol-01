use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::TrustlessError;
use crate::state::{ConfidentialAccount, PoolState};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Trustless zkSPL confidential balance operation.
///
/// A single instruction that handles all three modes:
/// - Deposit:  public_credit > 0, public_debit = 0 (tokens flow in)
/// - Withdraw: public_credit = 0, public_debit > 0 (tokens flow out)
/// - Transfer: public_credit = 0, public_debit = 0 (commitment update only)
///
/// The ZK proof verifies that the new commitment correctly reflects the
/// balance change. The on-chain program only needs to:
/// 1. Verify the proof
/// 2. Move tokens (if deposit/withdrawal)
/// 3. Update the commitment
///
/// Public inputs (7): old_commitment, new_commitment, amount_hash,
///                     public_credit, public_debit, token_mint, nonce
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    new_commitment: [u8; 32],
    amount_hash: [u8; 32],
    public_credit: u64,
    public_debit: u64
)]
pub struct ZkSplTrustless<'info> {
    /// Account owner (must sign for deposits/withdrawals; can be anyone for pure transfers)
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Pool state (holds the zkSPL VK hash)
    #[account(
        seeds = [
            PoolState::SEED_PREFIX,
            pool.token_mint.as_ref(),
            &pool.denomination.to_le_bytes()
        ],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,

    /// User's confidential account
    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            confidential_account.owner.as_ref(),
            pool.token_mint.as_ref()
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.is_initialized @ TrustlessError::AccountNotInitialized,
        constraint = confidential_account.owner == owner.key() @ TrustlessError::Unauthorized
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    /// Verification key data account for zkSPL circuit
    /// CHECK: Validated by hash comparison against pool.zkspl_vk_hash
    pub vk_data: UncheckedAccount<'info>,

    /// Vault PDA for token custody (for deposits/withdrawals)
    /// CHECK: Validated as PDA via seeds
    #[account(
        mut,
        seeds = [b"trustless_vault", pool.token_mint.as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token operations)
    pub token_program: Option<Program<'info, Token>>,

    /// User's token account (optional, for SPL token deposits/withdrawals)
    #[account(mut)]
    pub user_token_account: Option<Account<'info, TokenAccount>>,

    /// Pool vault token account (optional, for SPL token operations)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<ZkSplTrustless>,
    proof: Groth16Proof,
    new_commitment: [u8; 32],
    amount_hash: [u8; 32],
    public_credit: u64,
    public_debit: u64,
) -> Result<()> {
    // Cannot deposit and withdraw simultaneously
    require!(
        !(public_credit > 0 && public_debit > 0),
        TrustlessError::InvalidCreditDebit
    );

    let clock = Clock::get()?;
    let account = &mut ctx.accounts.confidential_account;
    let pool = &ctx.accounts.pool;

    // --- Verify ZK proof ---
    let vk_data_info = ctx.accounts.vk_data.try_borrow_data()?;

    // Skip account header: 8-byte discriminator + 4-byte size for Anchor-managed accounts
    // For raw PDA accounts (created via system_program::create_account), use full data
    let vk_bytes = if vk_data_info.len() > 12 && vk_data_info[0..8] != [0u8; 8] {
        &vk_data_info[12..]
    } else {
        &vk_data_info[..]
    };

    let computed_vk_hash = Groth16Verifier::hash_verification_key(vk_bytes);
    require!(
        computed_vk_hash == pool.zkspl_vk_hash,
        TrustlessError::InvalidVerificationKey
    );

    let token_mint_bytes = pool.token_mint.to_bytes();

    let is_valid = Groth16Verifier::verify_confidential_balance(
        &proof,
        &account.balance_commitment,
        &new_commitment,
        &amount_hash,
        public_credit,
        public_debit,
        &token_mint_bytes,
        account.nonce,
        vk_bytes,
    )?;

    require!(is_valid, TrustlessError::InvalidProof);

    // --- Handle token movement ---
    let is_native_sol = pool.token_mint == system_program::ID;

    if public_credit > 0 {
        // DEPOSIT: transfer tokens from user to vault
        if is_native_sol {
            let cpi_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            );
            system_program::transfer(cpi_context, public_credit)?;
        } else {
            let token_program = ctx.accounts.token_program
                .as_ref().ok_or(TrustlessError::MissingTokenProgram)?;
            let user_token_account = ctx.accounts.user_token_account
                .as_ref().ok_or(TrustlessError::MissingTokenAccount)?;
            let pool_vault_account = ctx.accounts.pool_vault
                .as_ref().ok_or(TrustlessError::MissingPoolVault)?;

            require!(user_token_account.mint == pool.token_mint, TrustlessError::InvalidTokenMint);
            require!(user_token_account.owner == ctx.accounts.owner.key(), TrustlessError::InvalidTokenOwner);
            require!(pool_vault_account.mint == pool.token_mint, TrustlessError::InvalidTokenMint);

            let transfer_ctx = CpiContext::new(
                token_program.to_account_info(),
                TokenTransfer {
                    from: user_token_account.to_account_info(),
                    to: pool_vault_account.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            );
            token::transfer(transfer_ctx, public_credit)?;
        }
    } else if public_debit > 0 {
        // WITHDRAW: transfer tokens from vault to user
        let mint_key = pool.token_mint;
        let vault_seeds = &[
            b"trustless_vault" as &[u8],
            mint_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        if is_native_sol {
            let cpi_context = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                signer_seeds,
            );
            system_program::transfer(cpi_context, public_debit)?;
        } else {
            let token_program = ctx.accounts.token_program
                .as_ref().ok_or(TrustlessError::MissingTokenProgram)?;
            let user_token_account = ctx.accounts.user_token_account
                .as_ref().ok_or(TrustlessError::MissingTokenAccount)?;
            let pool_vault_account = ctx.accounts.pool_vault
                .as_ref().ok_or(TrustlessError::MissingPoolVault)?;

            require!(user_token_account.mint == pool.token_mint, TrustlessError::InvalidTokenMint);
            require!(pool_vault_account.mint == pool.token_mint, TrustlessError::InvalidTokenMint);

            let transfer_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                TokenTransfer {
                    from: pool_vault_account.to_account_info(),
                    to: user_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, public_debit)?;
        }
    }
    // else: pure transfer -- no token movement, just commitment update

    // --- Update account state ---
    account.balance_commitment = new_commitment;
    account.nonce += 1;
    account.last_tx_at = clock.unix_timestamp;

    emit!(ZkSplTrustlessEvent {
        owner: account.owner,
        mint: account.mint,
        new_commitment,
        amount_hash,
        public_credit,
        public_debit,
        nonce: account.nonce,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct ZkSplTrustlessEvent {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub new_commitment: [u8; 32],
    pub amount_hash: [u8; 32],
    pub public_credit: u64,
    pub public_debit: u64,
    pub nonce: u64,
    pub timestamp: i64,
}
