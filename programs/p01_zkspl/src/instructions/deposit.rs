use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkSplError;
use crate::stark_proof::{
    u32_bytes_to_u64_le, verify_stark_proof, CIRCUIT_CONFIDENTIAL_BALANCE,
};
use crate::state::{ConfidentialAccount, MintConfig};

/// Deposit SPL tokens into a zkSPL confidential account.
///
/// The deposit amount is PUBLIC (visible on-chain) because the SPL transfer is
/// visible. The STARK proof (circuit `confidential_balance`, ID 4) proves that
/// the new balance commitment correctly commits a balance derived from the
/// same `old_balance` + `new_balance` private witnesses that the AIR enforces
/// via chained Poseidon hashes.
///
/// The caller must upload + verify the proof via `p01_stark_verifier` in prior
/// transactions (init_proof_buffer → write_proof_chunk* → verify_stark_proof_v2),
/// then pass the verified proof buffer account here.
///
/// STARK circuit 4 public inputs (order matches AIR `to_elements`):
///   [old_commitment, new_commitment, amount_hash, token_mint]
///
/// The on-chain handler reconstructs `sha256(u64_le || u64_le || u64_le || u64_le)`
/// and checks it matches the proof buffer's `public_inputs_hash`. `amount_hash`
/// must equal `Poseidon(0, 0)` (ZERO_AMOUNT_HASH) because the deposit amount is
/// public; there is no hidden amount for a deposit.
///
/// NOTE: The STARK AIR does NOT prove conservation (`new_balance =
/// old_balance + amount`). It only proves both commitments are well-formed
/// from the committed private witnesses and that `amount_hash = Poseidon(amount_priv,
/// amount_salt_priv)`. The on-chain program cannot observe the private
/// balances, so conservation relies on the client generating the proof with
/// honest witnesses. This is a known limitation carried over from the
/// previous Groth16 circuits and applies to withdraw/apply_pending as well.
#[derive(Accounts)]
#[instruction(amount: u64, new_commitment: [u8; 32])]
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

    /// Verified STARK proof buffer from `p01_stark_verifier` (circuit 4).
    /// Must have `verified == true` and `authority == depositor`.
    /// CHECK: Validated manually — owner == STARK_VERIFIER_PROGRAM_ID,
    /// discriminator, authority, circuit_id, verified, public inputs hash.
    pub stark_proof_buffer: AccountInfo<'info>,

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

/// Poseidon(0, 0) — the canonical zero amount hash used when the deposit amount
/// is public (stored here as little-endian bytes for convenience).
const ZERO_AMOUNT_HASH: [u8; 32] = [
    100, 72, 182, 70, 132, 238, 57, 168,
    35, 213, 254, 95, 213, 36, 49, 220,
    129, 228, 129, 123, 242, 195, 234, 60,
    171, 158, 35, 158, 251, 245, 152, 32,
];

pub fn handler(
    ctx: Context<Deposit>,
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
    // For deposit, the amount is public; the private `amount`/`amount_salt`
    // that the STARK hashes must both be zero so amount_hash = Poseidon(0, 0).
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
        &ctx.accounts.depositor.key(),
        CIRCUIT_CONFIDENTIAL_BALANCE,
        &public_inputs,
    )?;

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
