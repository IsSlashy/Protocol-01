use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};

/// Maximum number of output notes per split operation.
/// 20 allows splitting a 10 SOL note into 20 x 0.5 SOL notes.
pub const MAX_SPLIT_OUTPUTS: u8 = 20;

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
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32], bool)> {
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
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED]);
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI_VERIFIED] == 1;
    Ok((authority, circuit_id, verified, public_inputs_hash, deep_ali_verified))
}

/// Split a note from a high-denomination pool into multiple notes in a
/// lower-denomination pool using STARK proof verification (quantum-resistant).
///
/// Uses circuit 1 (pool_commitment) to prove ownership of the source note.
/// The output commitments are authenticated by the payer's signature over
/// the instruction data (same model as transfer_denominated_stark — no
/// relayer pattern for split).
///
/// Denomination conservation is enforced on-chain: the value inflation/deflation
/// check `source.denomination == num_outputs * target.denomination` prevents
/// value creation or destruction regardless of what commitments the user supplies.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    num_outputs: u8
)]
pub struct SplitNoteStark<'info> {
    /// Transaction submitter — must be the note owner (signs to bind output commitments).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// SOURCE pool — the high-denomination pool where the note is consumed.
    #[account(
        mut,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            source_pool.token_mint.as_ref(),
            &source_pool.denomination.to_le_bytes()
        ],
        bump = source_pool.bump,
        constraint = source_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = source_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
    )]
    pub source_pool: Box<Account<'info, DenominatedPool>>,

    /// SOURCE Merkle tree (read-only)
    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            source_pool.key().as_ref()
        ],
        bump = source_merkle_tree.bump
    )]
    pub source_merkle_tree: Account<'info, MerkleTreeState>,

    /// TARGET pool — the lower-denomination pool where new notes are created.
    #[account(
        mut,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            target_pool.token_mint.as_ref(),
            &target_pool.denomination.to_le_bytes()
        ],
        bump = target_pool.bump,
        constraint = target_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = target_pool.token_mint == source_pool.token_mint @ ZkShieldedError::InvalidTokenMint
    )]
    pub target_pool: Box<Account<'info, DenominatedPool>>,

    /// TARGET Merkle tree (mutated — new commitments are inserted here).
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            target_pool.key().as_ref()
        ],
        bump = target_merkle_tree.bump
    )]
    pub target_merkle_tree: Box<Account<'info, MerkleTreeState>>,

    /// Nullifier record PDA — created (init) on first use.
    #[account(
        init,
        payer = payer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            source_pool.key().as_ref(),
            nullifier.as_ref()
        ],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    /// STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).
    /// CHECK: Validated manually by reading account data.
    pub stark_proof_buffer: AccountInfo<'info>,

    /// Protocol fee wallet — receives split fee (0.3%).
    /// CHECK: Validated against hardcoded PROTOCOL_FEE_WALLET constant.
    #[account(
        mut,
        constraint = protocol_fee_wallet.key() == PROTOCOL_FEE_WALLET @ ZkShieldedError::InvalidFeeWallet
    )]
    pub protocol_fee_wallet: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub source_pool_vault: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub target_pool_vault: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<SplitNoteStark>,
    nullifier: [u8; 32],
    _merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    num_outputs: u8,
    output_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;

    // -----------------------------------------------------------------------
    // 1. Validate num_outputs
    // -----------------------------------------------------------------------
    require!(num_outputs >= 1, ZkShieldedError::InvalidAmount);
    require!(num_outputs <= MAX_SPLIT_OUTPUTS, ZkShieldedError::InvalidAmount);
    require!(
        output_commitments.len() == num_outputs as usize,
        ZkShieldedError::InvalidCommitment
    );
    require!(
        new_roots.len() == num_outputs as usize,
        ZkShieldedError::InvalidCommitment
    );

    // -----------------------------------------------------------------------
    // 2. Validate denomination conservation
    // -----------------------------------------------------------------------
    let expected_source_denom = (ctx.accounts.target_pool.denomination as u128)
        .checked_mul(num_outputs as u128)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    require!(
        ctx.accounts.source_pool.denomination as u128 == expected_source_denom,
        ZkShieldedError::InvalidDenomination
    );

    let source_denomination = ctx.accounts.source_pool.denomination;
    let target_denomination = ctx.accounts.target_pool.denomination;
    let is_native_sol = ctx.accounts.source_pool.token_mint == system_program::ID;
    let source_pool_key = ctx.accounts.source_pool.key();
    let target_pool_key = ctx.accounts.target_pool.key();
    let source_token_mint = ctx.accounts.source_pool.token_mint;
    let source_denomination_le = ctx.accounts.source_pool.denomination.to_le_bytes();
    let source_bump = ctx.accounts.source_pool.bump;

    // -----------------------------------------------------------------------
    // 3. Dynamic delay check
    // -----------------------------------------------------------------------
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    {
        let source_pool = &mut ctx.accounts.source_pool;
        source_pool.update_maturity(current_epoch);

        let dynamic_delay = source_pool.get_dynamic_delay();
        let effective_min_epoch = min_epoch
            .checked_add(dynamic_delay)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        require!(
            current_epoch >= effective_min_epoch,
            ZkShieldedError::EpochDelayNotMet
        );

        require!(
            source_pool.total_shielded >= source_denomination,
            ZkShieldedError::InsufficientBalance
        );
    }

    // -----------------------------------------------------------------------
    // 4. Init nullifier record (double-spend protection)
    // -----------------------------------------------------------------------
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = source_pool_key;
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // 5. STARK proof verification (circuit 1: pool_commitment)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash, deep_ali_verified) =
        parse_stark_proof_buffer(&proof_data)?;

    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(circuit_id == 1, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);
    // Circuit 1 ships phase-2 DEEP-ALI from the client; require it.
    require!(deep_ali_verified, ZkShieldedError::InvalidProof);

    // Nullifier canonicalization: the PDA is seeded on the full 32-byte
    // `nullifier`, but the proof only binds the low 8 bytes. Reject any
    // non-canonical nullifier whose high 24 bytes are non-zero, else a single
    // proof could be spent under multiple distinct nullifier PDAs (double-spend).
    require!(nullifier[8..] == [0u8; 24], ZkShieldedError::InvalidProof);

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
    // 6. Transfer funds: source pool -> target pool (SOL or SPL)
    // -----------------------------------------------------------------------
    let (split_fee, _net_amount) = fee::calculate_fee(source_denomination, fee::SHIELD_FEE_BPS);

    let source_seeds = &[
        DenominatedPool::SEED_PREFIX,
        source_token_mint.as_ref(),
        source_denomination_le.as_ref(),
        &[source_bump],
    ];
    let source_signer_seeds = &[&source_seeds[..]];

    if is_native_sol {
        let source_pool_lamports = ctx.accounts.source_pool.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(ctx.accounts.source_pool.to_account_info().data_len());

        require!(
            source_pool_lamports.saturating_sub(min_rent) >= source_denomination,
            ZkShieldedError::InsufficientPoolBalance
        );

        **ctx.accounts.source_pool.to_account_info().try_borrow_mut_lamports()? -=
            source_denomination;
        **ctx.accounts.target_pool.to_account_info().try_borrow_mut_lamports()? +=
            source_denomination.saturating_sub(split_fee);

        if split_fee > 0 {
            **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += split_fee;
        }
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let source_vault = ctx.accounts.source_pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let target_vault = ctx.accounts.target_pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;

        require!(source_vault.mint == source_token_mint, ZkShieldedError::InvalidTokenMint);
        require!(source_vault.owner == source_pool_key, ZkShieldedError::InvalidTokenOwner);
        require!(target_vault.mint == source_token_mint, ZkShieldedError::InvalidTokenMint);
        require!(target_vault.owner == target_pool_key, ZkShieldedError::InvalidTokenOwner);

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: source_vault.to_account_info(),
                to: target_vault.to_account_info(),
                authority: ctx.accounts.source_pool.to_account_info(),
            },
            source_signer_seeds,
        );
        token::transfer(transfer_ctx, source_denomination)?;

        if split_fee > 0 {
            let pool_lamports = ctx.accounts.source_pool.to_account_info().lamports();
            let rent = Rent::get()?;
            let min_rent =
                rent.minimum_balance(ctx.accounts.source_pool.to_account_info().data_len());
            if pool_lamports.saturating_sub(min_rent) >= split_fee {
                **ctx.accounts.source_pool.to_account_info().try_borrow_mut_lamports()? -= split_fee;
                **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += split_fee;
            }
        }
    }

    // -----------------------------------------------------------------------
    // 7. Insert output commitments into target Merkle tree
    // -----------------------------------------------------------------------
    {
        let target_merkle_tree = &mut ctx.accounts.target_merkle_tree;

        for i in 0..num_outputs as usize {
            let leaf_index =
                target_merkle_tree.insert_with_root(output_commitments[i], new_roots[i])?;
            msg!("Split output {} inserted at index: {}", i, leaf_index);
        }
    }

    // -----------------------------------------------------------------------
    // 8. Update source pool stats
    // -----------------------------------------------------------------------
    {
        let source_pool = &mut ctx.accounts.source_pool;
        source_pool.total_shielded = source_pool
            .total_shielded
            .checked_sub(source_denomination)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        source_pool.note_count = source_pool
            .note_count
            .checked_sub(1)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        source_pool.last_tx_at = clock.unix_timestamp;
        source_pool.mature_note_count = source_pool.mature_note_count.saturating_sub(1);
    }

    // -----------------------------------------------------------------------
    // 9. Update target pool stats
    // -----------------------------------------------------------------------
    {
        let target_pool = &mut ctx.accounts.target_pool;
        let target_merkle_tree = &ctx.accounts.target_merkle_tree;

        let target_shielded_increase = (target_denomination as u128)
            .checked_mul(num_outputs as u128)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        let target_shielded_increase = target_shielded_increase as u64;

        target_pool.update_root(target_merkle_tree.root);
        target_pool.next_leaf_index = target_merkle_tree.leaf_count;
        target_pool.total_shielded = target_pool
            .total_shielded
            .checked_add(target_shielded_increase)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        target_pool.note_count = target_pool
            .note_count
            .checked_add(num_outputs as u64)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        target_pool.last_tx_at = clock.unix_timestamp;

        let target_current_epoch = DenominatedPool::current_epoch(clock.slot);
        target_pool.update_maturity(target_current_epoch);
        for _ in 0..num_outputs {
            target_pool.record_deposit(target_current_epoch);
        }
    }

    // -----------------------------------------------------------------------
    // 10. Emit event
    // -----------------------------------------------------------------------
    emit!(SplitNoteStarkEvent {
        source_pool: source_pool_key,
        target_pool: target_pool_key,
        source_denomination,
        target_denomination,
        num_outputs,
        protocol_fee: split_fee,
        nullifier,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct SplitNoteStarkEvent {
    pub source_pool: Pubkey,
    pub target_pool: Pubkey,
    pub source_denomination: u64,
    pub target_denomination: u64,
    pub num_outputs: u8,
    pub protocol_fee: u64,
    pub nullifier: [u8; 32],
    pub timestamp: i64,
}
