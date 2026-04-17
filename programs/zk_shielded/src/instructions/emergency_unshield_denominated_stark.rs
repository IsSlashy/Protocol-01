use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};

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

fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID]).unwrap();
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
}

/// Emergency unshield from a denominated pool using STARK proof — bypasses maturity check.
///
/// Same as unshield_denominated_stark but SKIPS the on-chain epoch delay check.
/// This allows withdrawing immature notes (e.g., if the user needs funds urgently).
///
/// The STARK circuit (circuit 1: pool_commitment) does not encode the maturity
/// check — maturity is purely an on-chain policy. Therefore the same circuit
/// proves ownership, and the emergency flag is a pure on-chain bypass.
///
/// PRIVACY WARNING: Emergency unshields are distinguishable on-chain (the
/// `is_emergency` flag in the event reveals that maturity was bypassed).
/// This weakens the anonymity set for this withdrawal.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64
)]
pub struct EmergencyUnshieldDenominatedStark<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Any address can receive tokens
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

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

    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

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

    /// STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).
    /// CHECK: Validated manually by reading account data.
    pub stark_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

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
    ctx: Context<EmergencyUnshieldDenominatedStark>,
    nullifier: [u8; 32],
    _merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;
    let is_native_sol = pool.token_mint == system_program::ID;

    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Still update maturity tracking for state consistency
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);

    // NOTE: No epoch delay enforcement for emergency unshield.

    // Initialize nullifier record (double-spend protection)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // STARK proof verification (circuit 1: pool_commitment)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash) =
        parse_stark_proof_buffer(&proof_data)?;

    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(circuit_id == 1, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);

    {
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // -----------------------------------------------------------------------
    // Transfer funds with protocol fee (0.5%)
    // -----------------------------------------------------------------------
    let (unshield_fee, recipient_amount) = fee::calculate_fee(amount, fee::UNSHIELD_FEE_BPS);

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
        require!(pool_vault.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);
        require!(pool_vault.owner == pool.key(), ZkShieldedError::InvalidTokenOwner);
        require!(recipient_token_account.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);

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
    pool.total_shielded = pool.total_shielded.checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool.note_count.checked_sub(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    // Emergency may withdraw an immature note — only decrement if mature notes exist.
    if pool.mature_note_count > 0 {
        pool.mature_note_count = pool.mature_note_count.saturating_sub(1);
    }

    emit!(EmergencyUnshieldDenominatedStarkEvent {
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
pub struct EmergencyUnshieldDenominatedStarkEvent {
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
