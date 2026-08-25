use anchor_lang::prelude::*;

use crate::errors::LiquidityError;
use crate::state::{LiquidityPool, PrefundRecord};

// ---------------------------------------------------------------------------
// STARK proof buffer layout (mirrors p01_stark_verifier::ProofBuffer).
// ---------------------------------------------------------------------------

const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// p01_stark_verifier program ID: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
///       + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
///
/// # 🚨 THIS PARSE USED TO STOP AT 82, AND THAT BYTE IS THE WHOLE AIR CHECK
///
/// `verified` at offset 49 is phase 1: FRI folds, Merkle openings, query
/// positions, the OOD point re-derivation. It is NOT a statement that the trace
/// satisfies the constraint system. That statement is DEEP-ALI, it runs in
/// `verify_deep_ali_phase2`, and its result is the byte at offset 82 — which
/// this file declared out of range and never read.
///
/// So a circuit-1 proof whose trace does not satisfy C1's AIR cleared this
/// handler. `verify_stark_proof_v2` would have written `verified = 1` for it and
/// stopped there; nothing here asked for more.
///
/// Same defect class as `zk_shielded::unshield_stark` before 2026-08-18: a
/// consumer that accepts a proof asserting less than the thing it grants. The
/// difference is only that this one was found by a test rather than on a dump.
///
/// ⛔ `PROOF_BUF_INPUTS_HASH_END` exists so the hash slice stops at 82 while the
/// length check demands 83. They used to be one constant, so widening the length
/// check alone would have made `copy_from_slice` read 33 bytes into a `[u8; 32]`
/// and panic on every call.
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_INPUTS_HASH_END: usize = 82;
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

const CIRCUIT_POOL_COMMITMENT: u8 = 1;

fn parse_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32], bool)> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, LiquidityError::InvalidProofBuffer);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        LiquidityError::InvalidProofBuffer
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID]).unwrap();
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut inputs_hash = [0u8; 32];
    inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_INPUTS_HASH_END]);
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI_VERIFIED] == 1;
    Ok((authority, circuit_id, verified, inputs_hash, deep_ali_verified))
}

// ---------------------------------------------------------------------------
// Prefund instruction
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    amount: u64
)]
pub struct Prefund<'info> {
    /// Ephemeral signer — the user's disposable keypair used to upload + verify
    /// the proof. Signing here authorizes the prefund (we check it matches the
    /// proof buffer's authority below).
    #[account(mut)]
    pub ephemeral_signer: Signer<'info>,

    /// CHECK: any address may receive the prefunded lamports.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [LiquidityPool::SEED_PREFIX],
        bump = pool.bump,
        constraint = pool.is_active @ LiquidityError::PoolInactive
    )]
    pub pool: Account<'info, LiquidityPool>,

    /// STARK proof buffer (owned by p01_stark_verifier, circuit 1).
    /// CHECK: validated in handler — owner, disc, circuit, authority, verified, hash.
    pub stark_proof_buffer: AccountInfo<'info>,

    /// Denominated pool the note belongs to (we only store its key here; the
    /// full state lives in zk_shielded and we don't need to touch it).
    /// CHECK: opaque identifier, stored in PrefundRecord and re-checked at settle.
    pub denominated_pool: AccountInfo<'info>,

    #[account(
        init,
        payer = ephemeral_signer,
        space = PrefundRecord::LEN,
        seeds = [
            PrefundRecord::SEED_PREFIX,
            denominated_pool.key().as_ref(),
            nullifier.as_ref()
        ],
        bump
    )]
    pub prefund_record: Account<'info, PrefundRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Prefund>,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    amount: u64,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    // -----------------------------------------------------------------------
    // Validate the STARK proof buffer.
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        LiquidityError::InvalidProofOwner
    );
    let data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_hash, deep_ali_verified) =
        parse_proof_buffer(&data)?;
    require!(verified, LiquidityError::ProofNotVerified);
    require!(circuit_id == CIRCUIT_POOL_COMMITMENT, LiquidityError::WrongCircuit);
    // Phase 2. Circuit 1's DEEP-ALI is a SEPARATE instruction, so `verified`
    // above says only that the FRI and Merkle layers checked out. Without this
    // line a proof whose trace violates the AIR buys a prefund record, and that
    // record is admissible at settle time.
    //
    // ⛔ Do not weaken this to `circuit_id == 0 || deep_ali_verified`. C0 is the
    // only circuit whose DEEP-ALI runs inside phase 1, and this handler pins
    // circuit 1 four lines up — the disjunction would be dead code that reads
    // like an exemption someone could later widen.
    require!(deep_ali_verified, LiquidityError::ProofNotVerified);
    require!(
        authority == ctx.accounts.ephemeral_signer.key(),
        LiquidityError::AuthorityMismatch
    );

    // Reconstruct the sha256(nullifier_u64 || commitment_u64) the verifier stored
    // when verify_stark_proof_v2 ran. Same pattern as
    // zk_shielded::unshield_denominated_stark, so this record is admissible at settle time.
    {
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(stored_hash == expected, LiquidityError::InputsHashMismatch);
    }
    drop(data);

    // -----------------------------------------------------------------------
    // Fee math (all in bps of `amount`).
    // -----------------------------------------------------------------------
    let prefund_fee = (amount as u128)
        .checked_mul(pool.prefund_fee_bps as u128)
        .ok_or(LiquidityError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(LiquidityError::ArithmeticOverflow)? as u64;

    let settler_reward = (amount as u128)
        .checked_mul(pool.settler_reward_bps as u128)
        .ok_or(LiquidityError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(LiquidityError::ArithmeticOverflow)? as u64;

    let recipient_amount = amount
        .checked_sub(prefund_fee)
        .and_then(|v| v.checked_sub(settler_reward))
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    require!(
        pool.reserve_lamports >= recipient_amount,
        LiquidityError::InsufficientLiquidity
    );

    // -----------------------------------------------------------------------
    // Pay the recipient directly from the pool PDA's lamports.
    // -----------------------------------------------------------------------
    **pool.to_account_info().try_borrow_mut_lamports()? = pool
        .to_account_info()
        .lamports()
        .checked_sub(recipient_amount)
        .ok_or(LiquidityError::InsufficientLiquidity)?;
    **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? = ctx
        .accounts
        .recipient
        .to_account_info()
        .lamports()
        .checked_add(recipient_amount)
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    pool.reserve_lamports = pool
        .reserve_lamports
        .checked_sub(recipient_amount)
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    // -----------------------------------------------------------------------
    // Record the prefund so settle() can reconcile later.
    // -----------------------------------------------------------------------
    let record = &mut ctx.accounts.prefund_record;
    record.pool = pool.key();
    record.denominated_pool = ctx.accounts.denominated_pool.key();
    record.nullifier = nullifier;
    record.merkle_root = merkle_root;
    record.public_inputs_hash = stored_hash;
    record.stark_commitment = stark_commitment;
    record.amount = amount;
    record.min_epoch = min_epoch;
    record.proof_buffer = proof_info.key();
    record.ephemeral_signer = authority;
    record.settler_reward = settler_reward;
    record.opened_at_slot = Clock::get()?.slot;
    record.bump = ctx.bumps.prefund_record;

    emit!(PrefundOpenedEvent {
        pool: pool.key(),
        denominated_pool: record.denominated_pool,
        nullifier,
        amount,
        prefund_fee,
        settler_reward,
        recipient: ctx.accounts.recipient.key(),
        recipient_amount,
        opened_at_slot: record.opened_at_slot,
    });

    Ok(())
}

#[event]
pub struct PrefundOpenedEvent {
    pub pool: Pubkey,
    pub denominated_pool: Pubkey,
    pub nullifier: [u8; 32],
    pub amount: u64,
    pub prefund_fee: u64,
    pub settler_reward: u64,
    pub recipient: Pubkey,
    pub recipient_amount: u64,
    pub opened_at_slot: u64,
}
