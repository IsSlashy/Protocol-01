use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState, SubscriptionVault};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Cancel a private (ZK-based) subscription vault.
///
/// Requires a ZK proof of subscriber ownership.
/// Re-shields remaining funds back into the source denominated pool as new notes.
/// Only full denomination amounts can be re-shielded — sub-denomination dust
/// stays in the pool (privacy tradeoff, user warned in UI).
///
/// Flow:
/// 1. Verify subscriber ownership proof
/// 2. Compute refundable amount
/// 3. Pay retailer any outstanding claimable periods
/// 4. Re-shield full denominations back into pool (Merkle insert + root update)
/// 5. Close vault
#[derive(Accounts)]
#[instruction(
    ownership_proof: Groth16Proof,
    new_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>
)]
pub struct CancelPrivate<'info> {
    /// Transaction payer
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Retailer receives outstanding claimable periods
    /// CHECK: Must match vault.retailer
    #[account(
        mut,
        constraint = retailer.key() == vault.retailer @ ZkShieldedError::Unauthorized
    )]
    pub retailer: AccountInfo<'info>,

    /// Subscription vault (closed after cancellation)
    #[account(
        mut,
        seeds = [
            SubscriptionVault::SEED_PREFIX,
            vault.retailer.as_ref(),
            vault.subscriber_id_bytes().as_ref(),
            vault.token_mint.as_ref()
        ],
        bump = vault.bump,
        constraint = vault.is_active @ ZkShieldedError::VaultNotActive,
        constraint = vault.is_private_mode() @ ZkShieldedError::ExpectedPrivateMode,
        close = payer
    )]
    pub vault: Box<Account<'info, SubscriptionVault>>,

    /// Source denominated pool for re-shielding
    #[account(
        mut,
        constraint = Some(denominated_pool.key()) == vault.source_pool @ ZkShieldedError::InvalidVaultMode,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive
    )]
    pub denominated_pool: Box<Account<'info, DenominatedPool>>,

    /// Merkle tree state (mutable for re-shield insertions)
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Box<Account<'info, MerkleTreeState>>,

    /// Subscriber ownership VK data
    /// CHECK: Validated by hash comparison + owner check
    #[account(
        constraint = subscriber_vk_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub subscriber_vk_data: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    pub token_program: Option<Program<'info, Token>>,

    /// Vault's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Pool's token vault (optional, only for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Retailer's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub retailer_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<CancelPrivate>,
    ownership_proof: Groth16Proof,
    new_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    let commitment = vault.subscriber_commitment
        .ok_or(ZkShieldedError::ExpectedPrivateMode)?;

    // Verify subscriber ownership proof
    let vk_data = ctx.accounts.subscriber_vk_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == vault.vk_hash_subscriber,
        ZkShieldedError::InvalidVerificationKey
    );

    let is_valid = Groth16Verifier::verify_subscriber_ownership(
        &ownership_proof,
        &commitment,
        &vk_data,
    )?;
    require!(is_valid, ZkShieldedError::InvalidProof);
    drop(vk_data);

    // Compute amounts
    let pool = &ctx.accounts.denominated_pool;
    let denomination = pool.denomination;
    let claimable = vault.claimable_periods(clock.slot as i64);
    let total_owed = (vault.claimed_periods + claimable)
        .checked_mul(vault.rate)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let retailer_amount = claimable
        .checked_mul(vault.rate)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let refundable = vault.total_deposited.saturating_sub(total_owed);

    // Number of full denominations to re-shield
    let notes_to_reshield = refundable / denomination;
    let reshield_amount = notes_to_reshield * denomination;
    // Dust = refundable - reshield_amount (stays in pool, privacy tradeoff)

    require!(
        new_commitments.len() == notes_to_reshield as usize,
        ZkShieldedError::InvalidCommitment
    );
    require!(
        new_roots.len() == notes_to_reshield as usize,
        ZkShieldedError::InvalidCommitment
    );

    let is_native_sol = vault.token_mint == system_program::ID;

    // Build vault signer seeds
    let retailer_key = vault.retailer;
    let subscriber_id = vault.subscriber_id_bytes();
    let token_mint_key = vault.token_mint;
    let vault_bump = vault.bump;
    let vault_seeds = &[
        SubscriptionVault::SEED_PREFIX,
        retailer_key.as_ref(),
        subscriber_id.as_ref(),
        token_mint_key.as_ref(),
        &[vault_bump],
    ];
    let vault_signer = &[&vault_seeds[..]];

    // Pay retailer outstanding periods
    if retailer_amount > 0 {
        if is_native_sol {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= retailer_amount;
            **ctx.accounts.retailer.try_borrow_mut_lamports()? += retailer_amount;
        } else {
            let token_program = ctx.accounts.token_program
                .as_ref()
                .ok_or(ZkShieldedError::MissingTokenProgram)?;
            let vault_token = ctx.accounts.vault_token_account
                .as_ref()
                .ok_or(ZkShieldedError::MissingPoolVault)?;
            let retailer_token = ctx.accounts.retailer_token_account
                .as_ref()
                .ok_or(ZkShieldedError::MissingTokenAccount)?;

            let transfer_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                TokenTransfer {
                    from: vault_token.to_account_info(),
                    to: retailer_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(transfer_ctx, retailer_amount)?;
        }
    }

    // Re-shield funds back into pool
    if reshield_amount > 0 {
        if is_native_sol {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= reshield_amount;
            **ctx.accounts.denominated_pool.to_account_info().try_borrow_mut_lamports()? += reshield_amount;
        } else {
            let token_program = ctx.accounts.token_program
                .as_ref()
                .ok_or(ZkShieldedError::MissingTokenProgram)?;
            let vault_token = ctx.accounts.vault_token_account
                .as_ref()
                .ok_or(ZkShieldedError::MissingPoolVault)?;
            let pool_vault_acct = ctx.accounts.pool_vault
                .as_ref()
                .ok_or(ZkShieldedError::MissingPoolVault)?;

            require!(
                pool_vault_acct.owner == ctx.accounts.denominated_pool.key(),
                ZkShieldedError::InvalidTokenOwner
            );

            let transfer_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                TokenTransfer {
                    from: vault_token.to_account_info(),
                    to: pool_vault_acct.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(transfer_ctx, reshield_amount)?;
        }
    }

    // Insert new commitments into Merkle tree and update pool state
    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let current_epoch = DenominatedPool::current_epoch(clock.slot);

    for i in 0..notes_to_reshield as usize {
        let leaf_index = merkle_tree.insert_with_root(new_commitments[i], new_roots[i])?;

        msg!("Re-shielded commitment at index: {}", leaf_index);
    }

    // Update pool state
    if notes_to_reshield > 0 {
        pool.update_root(merkle_tree.root);
        pool.next_leaf_index = merkle_tree.leaf_count;
        pool.total_shielded = pool
            .total_shielded
            .checked_add(reshield_amount)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        pool.note_count = pool
            .note_count
            .checked_add(notes_to_reshield)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        pool.last_tx_at = clock.unix_timestamp;

        pool.update_maturity(current_epoch);
        for _ in 0..notes_to_reshield {
            pool.record_deposit(current_epoch);
        }
    }

    // vault is closed by the `close = payer` constraint

    emit!(CancelPrivateEvent {
        vault: ctx.accounts.vault.key(),
        retailer: ctx.accounts.retailer.key(),
        source_pool: ctx.accounts.denominated_pool.key(),
        retailer_amount,
        reshield_amount,
        notes_reshielded: notes_to_reshield,
        dust_forfeited: refundable - reshield_amount,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct CancelPrivateEvent {
    pub vault: Pubkey,
    pub retailer: Pubkey,
    pub source_pool: Pubkey,
    pub retailer_amount: u64,
    pub reshield_amount: u64,
    pub notes_reshielded: u64,
    pub dust_forfeited: u64,
    pub slot: i64,
}
