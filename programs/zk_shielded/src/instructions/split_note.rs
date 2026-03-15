use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Maximum number of output notes per split operation.
/// 20 allows splitting a 10 SOL note into 20 x 0.5 SOL notes.
pub const MAX_SPLIT_OUTPUTS: u8 = 20;

/// Split a note from a high-denomination pool into multiple notes in a
/// lower-denomination pool (cross-pool note splitting).
///
/// This is the on-chain component of the Privacy Router. It enables users
/// to break large-denomination notes into smaller ones without revealing
/// the link between source and target notes.
///
/// ## Security properties
///
/// - **Double-spend protection**: The source note's nullifier is recorded as
///   a PDA (init constraint). If it already exists, the transaction fails
///   atomically — zero false positives, same pattern as `unshield_denominated`.
///
/// - **Denomination conservation**: The program enforces that
///   `source_pool.denomination == num_outputs * target_pool.denomination`.
///   No value can be created or destroyed — exact split only.
///
/// - **Same-token enforcement**: Both pools must use the same `token_mint`,
///   verified via an account constraint.
///
/// - **ZK proof**: A Groth16 proof proves knowledge of the source note's
///   secret and nullifier preimage, that the note exists in the source pool's
///   Merkle tree, and that the output commitments are correctly formed.
///
/// - **Dynamic delay**: Same epoch-delay check as `unshield_denominated` —
///   small anonymity sets require longer waits to resist timing analysis.
///
/// - **Protocol fee**: 0.3% of the source denomination (same rate as shield),
///   collected to the hardcoded protocol fee wallet.
///
/// ## Instruction flow
///
/// 1. Validate `num_outputs` (1..=20) and denomination conservation
/// 2. Enforce dynamic epoch delay on the source pool
/// 3. Init nullifier record (atomic double-spend check)
/// 4. Verify Groth16 ZK proof against the source pool's VK
/// 5. Transfer funds: source pool -> target pool (SOL or SPL)
/// 6. Collect protocol fee (0.3%)
/// 7. Insert output commitments into the target pool's Merkle tree
/// 8. Update both pool stats (note counts, total shielded, roots)
/// 9. Emit `SplitNoteEvent`
///
/// ## Public inputs to the ZK circuit
///
/// `[source_merkle_root, nullifier, min_epoch, token_mint, enforce_maturity=1,
///   num_outputs, output_commitment_0, ..., output_commitment_19]`
///
/// Dummy outputs (beyond `num_outputs`) are zero-padded in the proof but
/// not inserted into the target Merkle tree.
#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    num_outputs: u8
)]
pub struct SplitNote<'info> {
    /// Transaction submitter (can be anyone — enables relayer pattern)
    #[account(mut)]
    pub payer: Signer<'info>,

    /// SOURCE pool — the high-denomination pool where the note is consumed.
    /// Must be active and the provided merkle_root must be a known root.
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

    /// SOURCE Merkle tree (read-only — the consumed note is nullified, not
    /// removed from the tree; the nullifier PDA prevents double-spend).
    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            source_pool.key().as_ref()
        ],
        bump = source_merkle_tree.bump
    )]
    pub source_merkle_tree: Account<'info, MerkleTreeState>,

    /// TARGET pool — the lower-denomination pool where new notes are created.
    /// Must be active and use the same token mint as the source pool.
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
    /// If this PDA already exists, the `init` constraint fails ->
    /// automatic double-spend rejection with zero false positives.
    /// Seeds are scoped to the source pool so nullifiers from different
    /// pools never collide.
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

    /// Verification key data account for the note_split circuit.
    /// CHECK: Validated by hash comparison against source_pool.vk_hash
    /// plus owner check (must be owned by this program).
    #[account(
        constraint = verification_key_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub verification_key_data: AccountInfo<'info>,

    /// Protocol fee wallet — receives split fee (0.3%).
    /// CHECK: Validated against hardcoded PROTOCOL_FEE_WALLET constant.
    #[account(
        mut,
        constraint = protocol_fee_wallet.key() == PROTOCOL_FEE_WALLET @ ZkShieldedError::InvalidFeeWallet
    )]
    pub protocol_fee_wallet: AccountInfo<'info>,

    /// System program (required for PDA creation + native SOL transfers)
    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// Source pool's token vault (optional, only for SPL tokens).
    /// Must be owned by the source pool PDA and match its token mint.
    #[account(mut)]
    pub source_pool_vault: Option<Account<'info, TokenAccount>>,

    /// Target pool's token vault (optional, only for SPL tokens).
    /// Must be owned by the target pool PDA and match its token mint.
    #[account(mut)]
    pub target_pool_vault: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<SplitNote>,
    proof: Groth16Proof,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    num_outputs: u8,
    output_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;

    // -----------------------------------------------------------------------
    // 1. Validate num_outputs
    // -----------------------------------------------------------------------
    // InvalidOutputCount: num_outputs must be >= 1
    require!(num_outputs >= 1, ZkShieldedError::InvalidAmount);
    // TooManyOutputs: num_outputs must be <= MAX_SPLIT_OUTPUTS (20)
    require!(
        num_outputs <= MAX_SPLIT_OUTPUTS,
        ZkShieldedError::InvalidAmount
    );

    // Output vectors must have exactly num_outputs entries
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
    // source.denomination must equal num_outputs * target.denomination
    // This guarantees exact value conservation — no value created or destroyed.
    let expected_source_denom = (ctx.accounts.target_pool.denomination as u128)
        .checked_mul(num_outputs as u128)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    require!(
        ctx.accounts.source_pool.denomination as u128 == expected_source_denom,
        ZkShieldedError::InvalidDenomination
    );

    // Cache values we need across multiple borrow scopes
    let source_denomination = ctx.accounts.source_pool.denomination;
    let target_denomination = ctx.accounts.target_pool.denomination;
    let is_native_sol = ctx.accounts.source_pool.token_mint == system_program::ID;
    let source_pool_key = ctx.accounts.source_pool.key();
    let target_pool_key = ctx.accounts.target_pool.key();
    let source_token_mint = ctx.accounts.source_pool.token_mint;
    let source_denomination_le = ctx.accounts.source_pool.denomination.to_le_bytes();
    let source_bump = ctx.accounts.source_pool.bump;

    // -----------------------------------------------------------------------
    // 3. Dynamic delay check (same pattern as unshield_denominated)
    // -----------------------------------------------------------------------
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    {
        let source_pool = &mut ctx.accounts.source_pool;
        source_pool.update_maturity(current_epoch);

        let dynamic_delay = source_pool.get_dynamic_delay();
        let effective_min_epoch = min_epoch
            .checked_add(dynamic_delay)
            .unwrap_or(u64::MAX);
        require!(
            current_epoch >= effective_min_epoch,
            ZkShieldedError::EpochDelayNotMet
        );

        // Check source pool has sufficient balance
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
    // 5. Load VK and verify ZK proof
    // -----------------------------------------------------------------------
    let vk_hash = ctx.accounts.source_pool.vk_hash;
    let vk_data = ctx.accounts.verification_key_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == vk_hash,
        ZkShieldedError::InvalidVerificationKey
    );

    // Build public inputs for the note_split circuit.
    // The circuit proves:
    // - The source note exists in the source pool's Merkle tree
    // - The nullifier is correctly derived from the note's secret
    // - The epoch delay is satisfied (enforce_maturity=1)
    // - All output commitments are correctly formed
    //
    // Public inputs: [merkle_root, nullifier, min_epoch, token_mint,
    //                 enforce_maturity=1, num_outputs, ...output_commitments(padded to 20)]
    let token_mint_bytes: [u8; 32] = source_token_mint.to_bytes();

    let mut min_epoch_bytes = [0u8; 32];
    min_epoch_bytes[..8].copy_from_slice(&min_epoch.to_le_bytes());

    let mut enforce_maturity_bytes = [0u8; 32];
    enforce_maturity_bytes[0] = 1; // Always enforce maturity for splits

    let mut num_outputs_bytes = [0u8; 32];
    num_outputs_bytes[0] = num_outputs;

    // Build the full public inputs array: 6 fixed + 20 commitment slots.
    // Public inputs must be in big-endian for the alt_bn128 pairing precompile.
    let mut public_inputs: Vec<[u8; 32]> = Vec::with_capacity(26);
    public_inputs.push(le_to_be(&merkle_root));
    public_inputs.push(le_to_be(&nullifier));
    public_inputs.push(le_to_be(&min_epoch_bytes));
    public_inputs.push(le_to_be(&token_mint_bytes));
    public_inputs.push(le_to_be(&enforce_maturity_bytes));
    public_inputs.push(le_to_be(&num_outputs_bytes));

    // Append active output commitments, then pad with zeros to 20 total
    for i in 0..MAX_SPLIT_OUTPUTS as usize {
        if i < num_outputs as usize {
            public_inputs.push(le_to_be(&output_commitments[i]));
        } else {
            public_inputs.push([0u8; 32]); // Zero-padded dummy
        }
    }

    let is_valid = Groth16Verifier::verify(&proof, &public_inputs, &vk_data)?;
    require!(is_valid, ZkShieldedError::InvalidProof);
    drop(vk_data);

    // -----------------------------------------------------------------------
    // 6. Transfer funds: source pool -> target pool (SOL or SPL)
    // -----------------------------------------------------------------------
    // Amount transferred = source_pool.denomination (the full note value).
    // Protocol fee is deducted from the transferred amount.

    // Calculate protocol fee (0.3% of source denomination, same rate as shield)
    let (split_fee, _net_amount) = fee::calculate_fee(source_denomination, fee::SHIELD_FEE_BPS);

    // Prepare source pool signer seeds for CPI
    let source_seeds = &[
        DenominatedPool::SEED_PREFIX,
        source_token_mint.as_ref(),
        source_denomination_le.as_ref(),
        &[source_bump],
    ];
    let source_signer_seeds = &[&source_seeds[..]];

    if is_native_sol {
        // Native SOL: transfer denomination from source pool PDA to target pool PDA
        let source_pool_lamports = ctx.accounts.source_pool.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(ctx.accounts.source_pool.to_account_info().data_len());

        require!(
            source_pool_lamports.saturating_sub(min_rent) >= source_denomination,
            ZkShieldedError::InsufficientPoolBalance
        );

        // Move funds from source pool to target pool (minus fee)
        **ctx.accounts.source_pool.to_account_info().try_borrow_mut_lamports()? -=
            source_denomination;
        **ctx.accounts.target_pool.to_account_info().try_borrow_mut_lamports()? +=
            source_denomination.saturating_sub(split_fee);

        // Collect protocol fee
        if split_fee > 0 {
            **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += split_fee;
        }
    } else {
        // SPL token transfer: source vault -> target vault
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let source_vault = ctx
            .accounts
            .source_pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let target_vault = ctx
            .accounts
            .target_pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;

        // Validate source vault
        require!(
            source_vault.mint == source_token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            source_vault.owner == source_pool_key,
            ZkShieldedError::InvalidTokenOwner
        );

        // Validate target vault
        require!(
            target_vault.mint == source_token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            target_vault.owner == target_pool_key,
            ZkShieldedError::InvalidTokenOwner
        );

        // Transfer full denomination from source vault to target vault
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

        // SPL token fee: collected as SOL from the source pool PDA (same pattern
        // as unshield_denominated — SPL fee paid in SOL)
        if split_fee > 0 {
            let pool_lamports = ctx.accounts.source_pool.to_account_info().lamports();
            let rent = Rent::get()?;
            let min_rent =
                rent.minimum_balance(ctx.accounts.source_pool.to_account_info().data_len());
            if pool_lamports.saturating_sub(min_rent) >= split_fee {
                **ctx
                    .accounts
                    .source_pool
                    .to_account_info()
                    .try_borrow_mut_lamports()? -= split_fee;
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
    // 8. Update source pool stats: one note consumed
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

        // The consumed note was mature (it passed the delay check)
        source_pool.mature_note_count = source_pool.mature_note_count.saturating_sub(1);
    }

    // -----------------------------------------------------------------------
    // 9. Update target pool stats: num_outputs notes created
    // -----------------------------------------------------------------------
    {
        let target_pool = &mut ctx.accounts.target_pool;
        let target_merkle_tree = &ctx.accounts.target_merkle_tree;

        // The value deposited equals source_denomination (which equals
        // num_outputs * target_denomination by conservation check above).
        let target_shielded_increase = (target_denomination as u128)
            .checked_mul(num_outputs as u128)
            .ok_or(ZkShieldedError::ArithmeticOverflow)?;
        // Safe to cast: we validated this equals source_denomination (a u64).
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

        // Record deposits in target pool for dynamic delay tracking
        let target_current_epoch = DenominatedPool::current_epoch(clock.slot);
        target_pool.update_maturity(target_current_epoch);
        for _ in 0..num_outputs {
            target_pool.record_deposit(target_current_epoch);
        }
    }

    // -----------------------------------------------------------------------
    // 10. Emit event
    // -----------------------------------------------------------------------
    emit!(SplitNoteEvent {
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

/// Event emitted on successful note split.
/// Observers can use this to track cross-pool activity without
/// learning which output notes belong to which user (that link is
/// hidden by the ZK proof).
#[event]
pub struct SplitNoteEvent {
    pub source_pool: Pubkey,
    pub target_pool: Pubkey,
    pub source_denomination: u64,
    pub target_denomination: u64,
    pub num_outputs: u8,
    pub protocol_fee: u64,
    pub nullifier: [u8; 32],
    pub timestamp: i64,
}

/// Convert a 32-byte array from little-endian to big-endian.
/// Required because Solana stores data in LE but the alt_bn128
/// pairing precompile expects public inputs in BE.
fn le_to_be(bytes: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    for i in 0..32 {
        result[i] = bytes[31 - i];
    }
    result
}
