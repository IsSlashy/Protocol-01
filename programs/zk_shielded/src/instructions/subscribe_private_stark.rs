use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord, SubscriptionVault};

/// STARK Proof Buffer account layout (from p01_stark_verifier).
/// We read this account to check that a STARK proof was verified.
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// Parse a verified STARK proof buffer.
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool)> {
    require!(data.len() >= 50, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[8..40]).unwrap();
    let circuit_id = data[40];
    let verified = data[49] == 1;
    Ok((authority, circuit_id, verified))
}

/// Create a private (ZK-based) subscription vault by unshielding a denomination
/// pool note using STARK proof verification (quantum-resistant).
///
/// Instead of inline Groth16 verification, this instruction reads a pre-verified
/// STARK proof buffer from p01_stark_verifier. The proof was uploaded and verified
/// in prior transactions (init -> upload -> verify flow).
///
/// Required STARK proofs:
///   - Circuit 1 (pool_commitment): proves knowledge of secret + nullifier_preimage
///     that hash to the nullifier and commitment
///
/// The caller must verify the STARK proof BEFORE calling this instruction.
/// This instruction only checks that proof_buffer.verified == true.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    subscriber_commitment: [u8; 32],
    rate: u64,
    interval_slots: u64,
    vk_hash_subscriber: [u8; 32]
)]
pub struct SubscribePrivateStark<'info> {
    /// Transaction payer
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Retailer who will receive periodic payments
    /// CHECK: Any pubkey can be a retailer
    pub retailer: AccountInfo<'info>,

    /// Subscription vault PDA (keyed by commitment instead of pubkey)
    #[account(
        init,
        payer = payer,
        space = SubscriptionVault::LEN,
        seeds = [
            SubscriptionVault::SEED_PREFIX,
            retailer.key().as_ref(),
            subscriber_commitment.as_ref(),
            denominated_pool.token_mint.as_ref()
        ],
        bump
    )]
    pub vault: Box<Account<'info, SubscriptionVault>>,

    /// Source denominated pool
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
    pub denominated_pool: Box<Account<'info, DenominatedPool>>,

    /// Merkle tree state (read-only for unshield)
    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Box<Account<'info, MerkleTreeState>>,

    /// Nullifier record PDA — init for double-spend prevention
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
    pub nullifier_record: Box<Account<'info, NullifierRecord>>,

    /// STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).
    /// Must be verified (verified == true) and owned by the payer.
    /// CHECK: Validated manually by reading account data and checking:
    /// - Owner is p01_stark_verifier program
    /// - Discriminator matches ProofBuffer
    /// - Authority matches payer
    /// - Circuit ID is 1 (pool_commitment)
    /// - Verified flag is true
    pub stark_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL tokens)
    pub token_program: Option<Program<'info, Token>>,

    /// Pool's token vault (optional, only for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Vault's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<SubscribePrivateStark>,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    subscriber_commitment: [u8; 32],
    rate: u64,
    interval_slots: u64,
    vk_hash_subscriber: [u8; 32],
) -> Result<()> {
    require!(rate > 0, ZkShieldedError::InvalidRate);
    require!(interval_slots > 0, ZkShieldedError::InvalidInterval);

    let clock = Clock::get()?;
    let pool_key = ctx.accounts.denominated_pool.key();
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;
    let is_native_sol = pool.token_mint == system_program::ID;

    // Check pool has sufficient balance
    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Dynamic delay check
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    let dynamic_delay = pool.get_dynamic_delay();
    let effective_min_epoch = min_epoch
        .checked_add(dynamic_delay)
        .unwrap_or(u64::MAX);
    require!(
        current_epoch >= effective_min_epoch,
        ZkShieldedError::EpochDelayNotMet
    );

    // Initialize nullifier record (double-spend check via init constraint)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // STARK proof verification (replaces Groth16 inline verify)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    // Must be owned by the STARK verifier program
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified) = parse_stark_proof_buffer(&proof_data)?;

    // Authority must be the payer (prevents using someone else's proof)
    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );

    // Must be pool_commitment circuit (ID 1)
    require!(circuit_id == 1, ZkShieldedError::InvalidProof);

    // Must be verified
    require!(verified, ZkShieldedError::InvalidProof);

    drop(proof_data);

    // -----------------------------------------------------------------------
    // Transfer funds from pool to vault (identical to Groth16 version)
    // -----------------------------------------------------------------------
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

        **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? += amount;
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let vault_token = ctx.accounts.vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        require!(pool_vault.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);
        require!(vault_token.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: pool_vault.to_account_info(),
                to: vault_token.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;
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
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);

    // Initialize vault state
    let vault = &mut ctx.accounts.vault;
    vault.subscriber_pubkey = None;
    vault.subscriber_commitment = Some(subscriber_commitment);
    vault.retailer = ctx.accounts.retailer.key();
    vault.token_mint = pool.token_mint;
    vault.total_deposited = amount;
    vault.rate = rate;
    vault.interval_slots = interval_slots;
    vault.start_slot = clock.slot as i64;
    vault.claimed_periods = 0;
    vault.is_active = true;
    vault.is_paused = false;
    vault.pause_slot = None;
    vault.total_paused_slots = 0;
    vault.vk_hash_subscriber = vk_hash_subscriber;
    vault.source_pool = Some(pool_key);
    vault.bump = ctx.bumps.vault;

    emit!(SubscribePrivateStarkEvent {
        vault: vault.key(),
        subscriber_commitment,
        retailer: ctx.accounts.retailer.key(),
        token_mint: pool.token_mint,
        amount,
        rate,
        interval_slots,
        source_pool: pool_key,
        nullifier,
        start_slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct SubscribePrivateStarkEvent {
    pub vault: Pubkey,
    pub subscriber_commitment: [u8; 32],
    pub retailer: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub rate: u64,
    pub interval_slots: u64,
    pub source_pool: Pubkey,
    pub nullifier: [u8; 32],
    pub start_slot: i64,
}
