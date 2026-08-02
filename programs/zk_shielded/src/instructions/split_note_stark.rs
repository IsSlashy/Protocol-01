use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::stark_buffer::{
    parse_stark_proof_buffer, StarkProofBufferView, STARK_VERIFIER_PROGRAM_ID,
};
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};

/// Maximum number of output notes per split operation.
/// 20 allows splitting a 10 SOL note into 20 x 0.5 SOL notes.
pub const MAX_SPLIT_OUTPUTS: u8 = 20;

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

    /// C1 (pool_commitment) STARK proof buffer from p01_stark_verifier — proves
    /// knowledge of secret + nullifier_preimage hashing to the nullifier and the
    /// source-note commitment.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=1,
    /// verified, deep_ali_verified, public_inputs_hash).
    pub c1_proof_buffer: AccountInfo<'info>,

    /// C3 (merkle_path) STARK proof buffer — proves the source-note commitment
    /// from C1 is actually a leaf in the SOURCE pool's tree at `merkle_root`.
    /// Without this, split verifies only C1 (knowledge of a well-formed note)
    /// and never that the note was ever deposited — a quantum/forging attacker
    /// could synthesize a valid C1 proof for any commitment and split value out
    /// of nothing into the target pool. Mirrors the C3 gate added to
    /// unshield_denominated_stark_v3 / subscribe_private_stark.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=3,
    /// verified, deep_ali_verified, public_inputs_hash).
    pub c3_proof_buffer: AccountInfo<'info>,

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
    merkle_root: [u8; 32],
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
    // 5. STARK proof verification — C1 (pool_commitment) + C3 (merkle_path)
    // -----------------------------------------------------------------------
    // C1 (pool_commitment): proves knowledge of secret + nullifier_preimage
    // hashing to the nullifier and the source-note commitment.
    let c1_info = &ctx.accounts.c1_proof_buffer;

    require!(
        *c1_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let c1_data = c1_info.try_borrow_data()?;
    let StarkProofBufferView {
        authority: c1_authority,
        circuit_id: c1_circuit_id,
        verified: c1_verified,
        deep_ali_verified: c1_deep_ali_verified,
        public_inputs_hash: c1_inputs_hash,
    } = parse_stark_proof_buffer(&c1_data)?;

    require!(
        c1_authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(c1_circuit_id == 1, ZkShieldedError::InvalidProof);
    require!(c1_verified, ZkShieldedError::InvalidProof);
    // Circuit 1 ships phase-2 DEEP-ALI from the client; require it.
    require!(c1_deep_ali_verified, ZkShieldedError::InvalidProof);

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
            c1_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(c1_data);

    // -----------------------------------------------------------------------
    // C3 (merkle_path) verification — proves the C1 source-note commitment is a
    // leaf in the SOURCE pool's tree at `merkle_root`. Without this, an attacker
    // can synthesize a valid C1 proof for a never-deposited commitment and split
    // value out of nothing into the target pool. Mirrors
    // unshield_denominated_stark_v3 / subscribe_private_stark.
    //
    // Topology: split consumes ONE input note (from source_pool) and creates
    // `num_outputs` output commitments in target_pool. Only the single input
    // note needs a membership proof, so one C3 suffices. The output commitments
    // are freshly inserted leaves — they don't (and can't) prove membership.
    // -----------------------------------------------------------------------
    let c3_info = &ctx.accounts.c3_proof_buffer;
    require!(
        *c3_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );
    let c3_data = c3_info.try_borrow_data()?;
    let StarkProofBufferView {
        authority: c3_authority,
        circuit_id: c3_circuit_id,
        verified: c3_verified,
        deep_ali_verified: c3_deep_ali_verified,
        public_inputs_hash: c3_inputs_hash,
    } = parse_stark_proof_buffer(&c3_data)?;

    require!(
        c3_authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(c3_circuit_id == 3, ZkShieldedError::InvalidProof);
    require!(c3_verified, ZkShieldedError::InvalidProof);
    // Circuit 3 ships phase-2 DEEP-ALI from the client; require it.
    require!(c3_deep_ali_verified, ZkShieldedError::InvalidProof);

    // Reconstruct C3 expected hash. The merkle_path prover stores
    //   public_inputs: vec![leaf, root_u64, depth]  (three u64 felts)
    // hashed as concat(u64.to_le_bytes()) = 24 bytes. The V3 leaf format packs
    // the Goldilocks felt into bytes 0..8, so we extract the low 8 bytes for the
    // root. depth must be 15 (the depth the C3 periodic columns are baked for).
    //
    // c3.leaf ↔ c1.commitment binding: both `pub_buf[..8]` here and the C1 hash
    // above are built from the SAME `stark_commitment` arg, so lying about
    // either fails one of the two hash checks.
    // c3.root ↔ source pool binding: `merkle_root[..8]` is fed here, and the
    // full 32-byte `merkle_root` is constrained to the source pool's historical
    // ring by `source_pool.is_valid_root(&merkle_root)` on the account above.
    let tree_depth = ctx.accounts.source_pool.tree_depth as u64;
    require!(tree_depth == 15, ZkShieldedError::InvalidProof);
    {
        let mut pub_buf = [0u8; 24]; // 3 × u64 LE: leaf, root, depth
        pub_buf[..8].copy_from_slice(&stark_commitment.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&merkle_root[..8]);
        pub_buf[16..24].copy_from_slice(&tree_depth.to_le_bytes());
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            c3_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }
    drop(c3_data);

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
