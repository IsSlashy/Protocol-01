use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::errors::LiquidityError;
use crate::state::{LiquidityPool, PrefundRecord};

// ---------------------------------------------------------------------------
// zk_shielded program: GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
// Anchor ix name: unshield_denominated_stark
// Discriminator: sha256("global:unshield_denominated_stark")[..8]
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xe7, 0xb5, 0x1a, 0x49, 0x09, 0x04, 0x45, 0xa8,
    0x85, 0x8a, 0x6a, 0x51, 0x39, 0xea, 0x69, 0xab,
    0x2f, 0xf2, 0x32, 0x9d, 0x8c, 0xb4, 0xaf, 0x3d,
    0xcc, 0xb1, 0x47, 0x1f, 0xb6, 0x0d, 0x77, 0x73,
]);

/// sha256("global:unshield_denominated_stark")[..8]
const UNSHIELD_DENOMINATED_STARK_DISCRIMINATOR: [u8; 8] =
    [0x5e, 0x5f, 0x4f, 0x30, 0xc3, 0xb7, 0x29, 0xa0];

#[derive(Accounts)]
#[instruction()]
pub struct Settle<'info> {
    /// Anyone — collects the settler_reward in exchange for driving the CPI.
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [LiquidityPool::SEED_PREFIX],
        bump = pool.bump
    )]
    pub pool: Account<'info, LiquidityPool>,

    #[account(
        mut,
        seeds = [
            PrefundRecord::SEED_PREFIX,
            prefund_record.denominated_pool.as_ref(),
            prefund_record.nullifier.as_ref()
        ],
        bump = prefund_record.bump,
        constraint = prefund_record.pool == pool.key() @ LiquidityError::PrefundMismatch,
        close = settler
    )]
    pub prefund_record: Account<'info, PrefundRecord>,

    // -----------------------------------------------------------------------
    // Accounts forwarded verbatim to zk_shielded.unshield_denominated_stark.
    // We don't deserialize these — Anchor will enforce the types inside the
    // CPI target, and we route them through via AccountInfo.
    // -----------------------------------------------------------------------

    /// CHECK: validated by zk_shielded (must match prefund_record.denominated_pool).
    #[account(
        mut,
        constraint = denominated_pool.key() == prefund_record.denominated_pool @ LiquidityError::PrefundMismatch
    )]
    pub denominated_pool: AccountInfo<'info>,

    /// CHECK: validated by zk_shielded.
    pub merkle_tree: AccountInfo<'info>,

    /// CHECK: zk_shielded initializes this PDA; we forward it.
    #[account(mut)]
    pub nullifier_record: AccountInfo<'info>,

    /// CHECK: must match the buffer recorded at prefund time.
    #[account(
        constraint = stark_proof_buffer.key() == prefund_record.proof_buffer @ LiquidityError::PrefundMismatch
    )]
    pub stark_proof_buffer: AccountInfo<'info>,

    /// CHECK: validated by zk_shielded (hardcoded PROTOCOL_FEE_WALLET).
    #[account(mut)]
    pub protocol_fee_wallet: AccountInfo<'info>,

    /// CHECK: this is the zk_shielded program, invoked via CPI.
    #[account(constraint = zk_shielded_program.key() == ZK_SHIELDED_PROGRAM_ID @ LiquidityError::PrefundMismatch)]
    pub zk_shielded_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Settle>) -> Result<()> {
    // The CPI below targets `zk_shielded::unshield_denominated_stark`, which
    // was retired in f5bb7514 and is absent from the deployed binary (probe in
    // `settlement_path.rs`). Fail here, naming the real problem, instead of
    // letting the invoke bounce back as InstructionFallbackNotFound from a
    // program the caller never invoked.
    //
    // The CPI construction below is deliberately kept and still type-checked:
    // it is the account order and argument encoding the v3 port has to
    // reproduce, and deleting it would mean reconstructing it from scratch.
    crate::settlement_path::require_settlement_path_available()?;

    let clock = Clock::get()?;
    let record = &ctx.accounts.prefund_record;
    let pool_key = ctx.accounts.pool.key();

    // Snapshot pool lamports pre-CPI so we can compute how much zk_shielded
    // transferred back. zk_shielded sends (amount - unshield_fee) to recipient,
    // so the delta tells us exactly what accrued.
    let pre_cpi_lamports = ctx.accounts.pool.to_account_info().lamports();

    // -----------------------------------------------------------------------
    // Build the CPI to zk_shielded.unshield_denominated_stark.
    //
    // Account order MUST match zk_shielded's UnshieldDenominatedStark struct.
    // The trailing `prefund_record` account is the new optional entry that
    // lets zk_shielded bypass the payer == proof.authority check.
    // -----------------------------------------------------------------------
    // Phase 1 indistinguishability: zk_shielded no longer enforces min_epoch,
    // and every client passes `current_epoch` so tx args + event shape match
    // across mature/emergency/prefund paths.
    const SLOTS_PER_EPOCH: u64 = 7200;
    let current_epoch = clock.slot / SLOTS_PER_EPOCH;

    let mut data = Vec::with_capacity(8 + 32 + 32 + 8 + 8);
    data.extend_from_slice(&UNSHIELD_DENOMINATED_STARK_DISCRIMINATOR);
    data.extend_from_slice(&record.nullifier);
    data.extend_from_slice(&record.merkle_root);
    data.extend_from_slice(&current_epoch.to_le_bytes());
    data.extend_from_slice(&record.stark_commitment.to_le_bytes());

    // Anchor 0.32 convention for Option<T> accounts: pass the target program's
    // own ID as a sentinel to mean "None". Settle only supports native-SOL pools
    // (the prefund path is native-only), so token_program, pool_vault, and
    // recipient_token_account are always None.
    let ix = Instruction {
        program_id: ZK_SHIELDED_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.settler.key(), true),             // payer
            AccountMeta::new(pool_key, false),                               // recipient (liquidity pool)
            AccountMeta::new(ctx.accounts.denominated_pool.key(), false),
            AccountMeta::new_readonly(ctx.accounts.merkle_tree.key(), false),
            AccountMeta::new(ctx.accounts.nullifier_record.key(), false),
            AccountMeta::new_readonly(ctx.accounts.stark_proof_buffer.key(), false),
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            // Option<Program<Token>> — None
            AccountMeta::new_readonly(ZK_SHIELDED_PROGRAM_ID, false),
            // Option<Account<TokenAccount>> pool_vault — None
            AccountMeta::new_readonly(ZK_SHIELDED_PROGRAM_ID, false),
            // Option<Account<TokenAccount>> recipient_token_account — None
            AccountMeta::new_readonly(ZK_SHIELDED_PROGRAM_ID, false),
            AccountMeta::new(ctx.accounts.protocol_fee_wallet.key(), false),
            // Prefund record — optional on zk_shielded side; we always include it when settling.
            AccountMeta::new_readonly(record.key(), false),
        ],
        data,
    };

    let pool_seeds: &[&[u8]] = &[LiquidityPool::SEED_PREFIX, &[ctx.accounts.pool.bump]];
    let account_infos = [
        ctx.accounts.settler.to_account_info(),
        ctx.accounts.pool.to_account_info(),
        ctx.accounts.denominated_pool.clone(),
        ctx.accounts.merkle_tree.clone(),
        ctx.accounts.nullifier_record.clone(),
        ctx.accounts.stark_proof_buffer.clone(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.zk_shielded_program.clone(), // token_program None sentinel
        ctx.accounts.zk_shielded_program.clone(), // pool_vault None sentinel
        ctx.accounts.zk_shielded_program.clone(), // recipient_token_account None sentinel
        ctx.accounts.protocol_fee_wallet.clone(),
        record.to_account_info(),
        ctx.accounts.zk_shielded_program.clone(),
    ];

    invoke_signed(&ix, &account_infos, &[pool_seeds])?;

    // Pool has new lamports. Update mirror + pay the settler reward.
    let post_cpi_lamports = ctx.accounts.pool.to_account_info().lamports();
    let received = post_cpi_lamports.saturating_sub(pre_cpi_lamports);

    let pool = &mut ctx.accounts.pool;
    pool.reserve_lamports = pool
        .reserve_lamports
        .checked_add(received)
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    // Pay settler reward (if non-zero and pool has it).
    let reward = record.settler_reward.min(pool.reserve_lamports);
    if reward > 0 {
        **pool.to_account_info().try_borrow_mut_lamports()? = pool
            .to_account_info()
            .lamports()
            .checked_sub(reward)
            .ok_or(LiquidityError::InsufficientLiquidity)?;
        **ctx.accounts.settler.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .settler
            .to_account_info()
            .lamports()
            .checked_add(reward)
            .ok_or(LiquidityError::ArithmeticOverflow)?;

        pool.reserve_lamports = pool
            .reserve_lamports
            .checked_sub(reward)
            .ok_or(LiquidityError::ArithmeticOverflow)?;
    }

    emit!(PrefundSettledEvent {
        pool: pool_key,
        denominated_pool: record.denominated_pool,
        nullifier: record.nullifier,
        amount: record.amount,
        received_from_unshield: received,
        settler: ctx.accounts.settler.key(),
        settler_reward: reward,
        settled_at_slot: clock.slot,
    });

    Ok(())
}

#[event]
pub struct PrefundSettledEvent {
    pub pool: Pubkey,
    pub denominated_pool: Pubkey,
    pub nullifier: [u8; 32],
    pub amount: u64,
    pub received_from_unshield: u64,
    pub settler: Pubkey,
    pub settler_reward: u64,
    pub settled_at_slot: u64,
}
