use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Emergency unshield from a denominated pool — bypasses maturity check.
///
/// Same as normal unshield but with enforce_maturity=0 in the circuit proof.
/// This allows withdrawing immature notes (e.g., if the user needs funds urgently).
///
/// PRIVACY WARNING: Emergency unshields are distinguishable on-chain (the
/// `is_emergency` flag in the event reveals that maturity was bypassed).
/// This weakens the anonymity set for this withdrawal.
///
/// Public inputs: [merkle_root, nullifier, min_epoch, token_mint, enforce_maturity=0]
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64
)]
pub struct EmergencyUnshieldDenominated<'info> {
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

    /// Merkle tree state (read-only)
    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// Nullifier record PDA — created (init) on first use.
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
    /// CHECK: Validated by hash comparison
    pub verification_key_data: AccountInfo<'info>,

    /// System program
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
    ctx: Context<EmergencyUnshieldDenominated>,
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

    // Update maturity tracking (still needed for state consistency)
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);

    // NOTE: No epoch delay enforcement for emergency unshield.
    // The circuit proof was generated with enforce_maturity=0,
    // which bypasses the time delay check.

    // Initialize the nullifier record (marks it as spent)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // Load and validate verification key (same VK as normal unshield)
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == pool.vk_hash,
        ZkShieldedError::InvalidVerificationKey
    );

    // Verify the ZK proof with enforce_maturity=0 (emergency bypass)
    let token_mint_bytes: [u8; 32] = pool.token_mint.to_bytes();
    let is_valid = Groth16Verifier::verify_denominated(
        &proof,
        &merkle_root,
        &nullifier,
        min_epoch,
        &token_mint_bytes,
        false, // enforce_maturity = 0 (emergency unshield)
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

    // Update pool state
    pool.total_shielded = pool
        .total_shielded
        .checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool
        .note_count
        .checked_sub(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    // Note: Emergency unshield may withdraw an immature note,
    // so we can't assume it was in mature_note_count. Only decrement
    // if there are mature notes tracked.
    if pool.mature_note_count > 0 {
        pool.mature_note_count = pool.mature_note_count.saturating_sub(1);
    }

    emit!(EmergencyUnshieldDenominatedEvent {
        pool: pool.key(),
        recipient: ctx.accounts.recipient.key(),
        denomination: amount,
        protocol_fee: unshield_fee,
        nullifier,
        min_epoch,
        current_epoch,
        is_emergency: true,
        mature_note_count: pool.mature_note_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct EmergencyUnshieldDenominatedEvent {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub denomination: u64,
    pub protocol_fee: u64,
    pub nullifier: [u8; 32],
    pub min_epoch: u64,
    pub current_epoch: u64,
    pub is_emergency: bool,
    pub mature_note_count: u64,
    pub timestamp: i64,
}
