use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, NullifierRecord, ShieldedPool};

/// STARK Proof Buffer layout (must match p01_stark_verifier::ProofBuffer).
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

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

/// Unshield tokens from the shielded pool using a STARK circuit 5 (transfer) proof.
///
/// Spends two input nullifiers, produces an (optional) change commitment, and
/// releases `amount` to the recipient. The proof's `public_amount` is the
/// unshield amount reinterpreted as a signed field element via two's complement
/// (the prover outputs -amount when tokens leave the pool).
///
/// Public inputs (u64 LE, bound by sha256):
///   [0] nullifier_1 (u64 truncation)
///   [1] nullifier_2
///   [2] output_commitment_1 (change, may be [0; 32])
///   [3] output_commitment_2 (may be [0; 32])
///   [4] public_amount (two's-complement u64 reinterpretation of -amount)
///   [5] token_mint (u64 truncation of pool.token_mint)
#[derive(Accounts)]
#[instruction(
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    merkle_root: [u8; 32],
    amount: u64,
    new_root: [u8; 32]
)]
pub struct UnshieldStark<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Recipient of the unshielded tokens.
    /// CHECK: Any address can receive tokens.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump,
        constraint = shielded_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = shielded_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            shielded_pool.key().as_ref()
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
            shielded_pool.key().as_ref(),
            nullifier_1.as_ref()
        ],
        bump
    )]
    pub nullifier_record_1: Account<'info, NullifierRecord>,

    #[account(
        init,
        payer = payer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            shielded_pool.key().as_ref(),
            nullifier_2.as_ref()
        ],
        bump
    )]
    pub nullifier_record_2: Account<'info, NullifierRecord>,

    /// STARK proof buffer from p01_stark_verifier (circuit 5: transfer).
    /// CHECK: Validated by the handler.
    pub stark_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<UnshieldStark>,
    nullifier_1: [u8; 32],
    nullifier_2: [u8; 32],
    output_commitment_1: [u8; 32],
    output_commitment_2: [u8; 32],
    _merkle_root: [u8; 32],
    amount: u64,
    new_root: [u8; 32],
) -> Result<()> {
    require!(amount > 0, ZkShieldedError::InvalidAmount);

    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let is_native_sol = pool.token_mint == system_program::ID;

    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Double-spend protection via PDA-per-nullifier.
    let nullifier_record_1 = &mut ctx.accounts.nullifier_record_1;
    nullifier_record_1.pool = pool.key();
    nullifier_record_1.bump = ctx.bumps.nullifier_record_1;

    let nullifier_record_2 = &mut ctx.accounts.nullifier_record_2;
    nullifier_record_2.pool = pool.key();
    nullifier_record_2.bump = ctx.bumps.nullifier_record_2;

    // Nullifier canonicalization: each PDA is seeded on the full 32-byte
    // nullifier, but the proof only binds the low 8 bytes. Reject any
    // non-canonical nullifier whose high 24 bytes are non-zero, else a single
    // proof could be spent under multiple distinct nullifier PDAs (double-spend).
    require!(nullifier_1[8..] == [0u8; 24], ZkShieldedError::InvalidProof);
    require!(nullifier_2[8..] == [0u8; 24], ZkShieldedError::InvalidProof);

    // -----------------------------------------------------------------------
    // STARK proof verification (circuit 5: transfer, negative public_amount)
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
    require!(circuit_id == 5, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);
    require!(deep_ali_verified, ZkShieldedError::InvalidProof);

    // Reconstruct the public-inputs hash the verifier stored.
    // For unshield, public_amount = -amount represented in two's complement u64.
    //
    // Two's complement of `amount` over u64: (u64::MAX - amount).wrapping_add(1)
    // i.e., the bit pattern of the signed value -amount when treated as u64.
    //
    // The prover MUST use the same representation for the circuit's field
    // element — the u64 truncation of -amount (which is effectively
    // Goldilocks: MODULUS - amount) won't match a two's-complement u64
    // because the Goldilocks field modulus isn't 2^64. So the prover instead
    // supplies a u64 "signed-bit-pattern" and the circuit consumes it in the
    // same way we hash it here. Keep the representation in lock-step with the
    // prover side.
    {
        let n1 = u64::from_le_bytes(nullifier_1[..8].try_into().unwrap());
        let n2 = u64::from_le_bytes(nullifier_2[..8].try_into().unwrap());
        let oc1 = u64::from_le_bytes(output_commitment_1[..8].try_into().unwrap());
        let oc2 = u64::from_le_bytes(output_commitment_2[..8].try_into().unwrap());
        // Prover-side convention: public_amount is the u64 bit pattern of -amount
        // (two's complement). wrapping_neg() on u64 gives exactly that.
        let public_amount = amount.wrapping_neg();
        let token_mint_bytes = pool.token_mint.to_bytes();
        let tm = u64::from_le_bytes(token_mint_bytes[..8].try_into().unwrap());

        let mut pub_buf = [0u8; 48]; // 6 × 8
        pub_buf[0..8].copy_from_slice(&n1.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&n2.to_le_bytes());
        pub_buf[16..24].copy_from_slice(&oc1.to_le_bytes());
        pub_buf[24..32].copy_from_slice(&oc2.to_le_bytes());
        pub_buf[32..40].copy_from_slice(&public_amount.to_le_bytes());
        pub_buf[40..48].copy_from_slice(&tm.to_le_bytes());

        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // Insert change commitment if non-zero.
    let leaf_index = if output_commitment_1 != [0u8; 32] {
        Some(merkle_tree.insert_with_root(output_commitment_1, new_root)?)
    } else {
        None
    };

    // -----------------------------------------------------------------------
    // Transfer funds out of pool (same logic as legacy unshield)
    // -----------------------------------------------------------------------
    let pool_key = pool.key();
    let token_mint = pool.token_mint;
    let bump = pool.bump;

    let seeds = &[
        ShieldedPool::SEED_PREFIX,
        token_mint.as_ref(),
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
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;
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
        token::transfer(transfer_ctx, amount)?;
    }

    // Update pool state.
    pool.update_root(merkle_tree.root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.total_shielded = pool
        .total_shielded
        .checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    emit!(UnshieldStarkEvent {
        pool: pool_key,
        recipient: ctx.accounts.recipient.key(),
        amount,
        nullifier_1,
        nullifier_2,
        change_commitment: output_commitment_1,
        change_leaf_index: leaf_index,
        new_root: merkle_tree.root,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct UnshieldStarkEvent {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nullifier_1: [u8; 32],
    pub nullifier_2: [u8; 32],
    pub change_commitment: [u8; 32],
    pub change_leaf_index: Option<u64>,
    pub new_root: [u8; 32],
    pub timestamp: i64,
}
