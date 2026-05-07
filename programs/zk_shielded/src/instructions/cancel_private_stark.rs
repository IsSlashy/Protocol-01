use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState, SubscriptionVault};

/// STARK Proof Buffer account layout (from p01_stark_verifier).
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_MIN_LEN: usize = 82;

/// Parse a verified STARK proof buffer.
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID])
        .map_err(|_| ZkShieldedError::InvalidProof)?;
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
}

/// Cancel a private (ZK-based) subscription vault using STARK proof (quantum-resistant).
///
/// Requires a pre-verified STARK proof buffer proving subscriber ownership (circuit 0).
/// Re-shields remaining funds back into the source denominated pool as new notes.
/// Only full denomination amounts can be re-shielded — sub-denomination dust
/// stays in the pool (privacy tradeoff).
#[derive(Accounts)]
#[instruction(
    new_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>
)]
pub struct CancelPrivateStark<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Retailer receives outstanding claimable periods
    /// CHECK: Must match vault.retailer
    #[account(
        mut,
        constraint = retailer.key() == vault.retailer @ ZkShieldedError::Unauthorized
    )]
    pub retailer: AccountInfo<'info>,

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

    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Box<Account<'info, MerkleTreeState>>,

    /// STARK proof buffer from p01_stark_verifier (circuit 0: subscriber_ownership).
    /// CHECK: Validated manually by reading account data and checking:
    /// - Owner is p01_stark_verifier program
    /// - Discriminator matches ProofBuffer
    /// - Authority matches payer
    /// - Circuit ID is 0 (subscriber_ownership)
    /// - Verified flag is true
    /// - Public inputs hash matches vault commitment
    #[account(mut)]
    pub stark_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub retailer_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<CancelPrivateStark>,
    new_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    let commitment = vault.subscriber_commitment
        .ok_or(ZkShieldedError::ExpectedPrivateMode)?;

    // -----------------------------------------------------------------------
    // STARK proof verification (replaces Groth16 inline verify)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash) = parse_stark_proof_buffer(&proof_data)?;

    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );

    require!(circuit_id == 0, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);

    {
        let commitment_u64 = u64::from_le_bytes(commitment[..8].try_into().unwrap());
        let commitment_bytes = commitment_u64.to_le_bytes();
        let expected_hash = solana_sha256_hasher::hashv(&[&commitment_bytes]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // -----------------------------------------------------------------------
    // Cancel logic (identical to Groth16 version)
    // -----------------------------------------------------------------------
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

    let notes_to_reshield = refundable / denomination;
    let reshield_amount = notes_to_reshield * denomination;

    require!(
        new_commitments.len() == notes_to_reshield as usize,
        ZkShieldedError::InvalidCommitment
    );
    require!(
        new_roots.len() == notes_to_reshield as usize,
        ZkShieldedError::InvalidCommitment
    );

    let is_native_sol = vault.token_mint == system_program::ID;

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

    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let current_epoch = DenominatedPool::current_epoch(clock.slot);

    for i in 0..notes_to_reshield as usize {
        let leaf_index = merkle_tree.insert_with_root(new_commitments[i], new_roots[i])?;
        msg!("Re-shielded commitment at index: {}", leaf_index);
    }

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

    emit!(CancelPrivateStarkEvent {
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
pub struct CancelPrivateStarkEvent {
    pub vault: Pubkey,
    pub retailer: Pubkey,
    pub source_pool: Pubkey,
    pub retailer_amount: u64,
    pub reshield_amount: u64,
    pub notes_reshielded: u64,
    pub dust_forfeited: u64,
    pub slot: i64,
}
