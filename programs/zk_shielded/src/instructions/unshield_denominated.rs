use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Unshield tokens from a denominated pool.
///
/// Uses PDA-per-nullifier (Tornado Cash model) instead of a Bloom filter:
/// - Zero false positives — deterministic double-spend detection
/// - No size limit — scales to millions of nullifiers
/// - Rent (~0.00089 SOL) paid by payer
///
/// The `init` constraint on `nullifier_record` will fail if the PDA already
/// exists, which means the nullifier was already spent. This is the double-spend
/// check — it's atomic and cannot race.
///
/// Public inputs: [merkle_root, nullifier, min_epoch, token_mint]
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64
)]
pub struct UnshieldDenominated<'info> {
    /// Transaction submitter (can be anyone — enables relayer pattern)
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Recipient of the unshielded tokens
    /// CHECK: Any address can receive tokens
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// Denominated pool
    #[account(
        mut,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = denominated_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    /// Merkle tree state (read-only — no change notes in denominated pools)
    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// Nullifier record PDA — created (init) on first use.
    /// If this PDA already exists, the `init` constraint fails →
    /// automatic double-spend rejection with zero false positives.
    #[account(
        init,
        payer = payer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            denominated_pool.key().as_ref(),
            nullifier.as_ref()
        ],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    /// Verification key data account
    /// CHECK: Validated by hash comparison + owner check
    #[account(
        constraint = verification_key_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub verification_key_data: AccountInfo<'info>,

    /// System program (required for PDA creation + native SOL transfers)
    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// Pool's token vault (optional, only for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Recipient's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,

    /// Protocol fee wallet — receives unshield fee (0.5%)
    /// CHECK: Validated against hardcoded PROTOCOL_FEE_WALLET constant
    #[account(
        mut,
        constraint = protocol_fee_wallet.key() == PROTOCOL_FEE_WALLET @ ZkShieldedError::InvalidFeeWallet
    )]
    pub protocol_fee_wallet: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<UnshieldDenominated>,
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;

    let is_native_sol = pool.token_mint == system_program::ID;

    // Check pool has sufficient balance
    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Dynamic delay: update maturity tracking before computing delay
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);

    // The circuit guarantees deposit_epoch + pool.epoch_delay <= min_epoch
    // (the note has waited at least `epoch_delay` epochs).
    // We additionally enforce a dynamic delay based on the anonymity set size:
    // small pools require longer waits to prevent timing analysis.
    let dynamic_delay = pool.get_dynamic_delay();
    let effective_min_epoch = min_epoch
        .checked_add(dynamic_delay)
        .unwrap_or(u64::MAX);
    require!(
        current_epoch >= effective_min_epoch,
        ZkShieldedError::EpochDelayNotMet
    );

    // Double-spend protection is handled by the `init` constraint on nullifier_record.
    // If this nullifier was already used, the PDA already exists and init fails
    // with "already in use" error — zero false positives, no Bloom filter needed.

    // Initialize the nullifier record (marks it as spent)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // Load and validate verification key
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == pool.vk_hash,
        ZkShieldedError::InvalidVerificationKey
    );

    // Verify the ZK proof: 5 public inputs [merkle_root, nullifier, min_epoch, token_mint, enforce_maturity]
    // Normal unshield always enforces maturity (enforce_maturity=1)
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();
    let is_valid = Groth16Verifier::verify_denominated(
        &proof,
        &merkle_root,
        &nullifier,
        min_epoch,
        &token_mint_bytes,
        true, // enforce_maturity = 1 (normal unshield)
        &vk_data,
    )?;

    require!(is_valid, ZkShieldedError::InvalidProof);

    // Calculate protocol fee (0.5% of denomination)
    let (unshield_fee, recipient_amount) = fee::calculate_fee(amount, fee::UNSHIELD_FEE_BPS);

    // Prepare pool signer seeds for CPI
    let token_mint = pool.token_mint;
    let denomination_bytes = pool.denomination.to_le_bytes();
    let bump = pool.bump;
    let seeds = &[
        DenominatedPool::SEED_PREFIX,
        token_mint.as_ref(),
        denomination_bytes.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    if is_native_sol {
        let pool_lamports = pool.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(pool.to_account_info().data_len());

        require!(
            pool_lamports.saturating_sub(min_rent) >= amount,
            ZkShieldedError::InsufficientPoolBalance
        );

        // Send net amount to recipient, fee to protocol wallet
        **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += recipient_amount;
        if unshield_fee > 0 {
            **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += unshield_fee;
        }
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let recipient_token_account = ctx.accounts.recipient_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        require!(
            pool_vault.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            pool_vault.owner == pool.key(),
            ZkShieldedError::InvalidTokenOwner
        );
        require!(
            recipient_token_account.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );

        // Transfer net amount to recipient
        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: pool_vault.to_account_info(),
                to: recipient_token_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, recipient_amount)?;

        // SPL token fee: sent as SOL from pool PDA to fee wallet
        if unshield_fee > 0 {
            let pool_lamports = pool.to_account_info().lamports();
            let rent = Rent::get()?;
            let min_rent = rent.minimum_balance(pool.to_account_info().data_len());
            if pool_lamports.saturating_sub(min_rent) >= unshield_fee {
                **pool.to_account_info().try_borrow_mut_lamports()? -= unshield_fee;
                **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += unshield_fee;
            }
        }
    }

    // Update pool state — no change notes, no Merkle tree update
    pool.total_shielded = pool
        .total_shielded
        .checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool
        .note_count
        .checked_sub(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    // The withdrawn note was mature (it passed the delay check),
    // so decrement the mature note count.
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);

    emit!(UnshieldDenominatedEvent {
        pool: pool.key(),
        recipient: ctx.accounts.recipient.key(),
        denomination: amount,
        protocol_fee: unshield_fee,
        nullifier,
        min_epoch,
        current_epoch,
        dynamic_delay,
        mature_note_count: pool.mature_note_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct UnshieldDenominatedEvent {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub denomination: u64,
    pub protocol_fee: u64,
    pub nullifier: [u8; 32],
    pub min_epoch: u64,
    pub current_epoch: u64,
    pub dynamic_delay: u64,
    pub mature_note_count: u64,
    pub timestamp: i64,
}
