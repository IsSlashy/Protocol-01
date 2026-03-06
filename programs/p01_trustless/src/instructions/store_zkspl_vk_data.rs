use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::TrustlessError;
use crate::state::PoolState;

/// Seed for zkSPL VK data PDA
pub const ZKSPL_VK_DATA_SEED: &[u8] = b"trustless_zkspl_vk";

/// Maximum VK data size
pub const MAX_VK_SIZE: u32 = 2048;

/// Maximum chunk size per transaction
pub const MAX_CHUNK_SIZE: usize = 800;

/// Initialize VK data account for the zkSPL circuit.
/// Admin-only: requires pool authority signature.
#[derive(Accounts)]
#[instruction(vk_size: u32)]
pub struct InitZkSplVkData<'info> {
    /// Pool authority (must sign)
    #[account(
        mut,
        constraint = authority.key() == pool.authority @ TrustlessError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Pool state
    #[account(
        seeds = [
            PoolState::SEED_PREFIX,
            pool.token_mint.as_ref(),
            &pool.denomination.to_le_bytes()
        ],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,

    /// zkSPL VK data account (PDA owned by this program)
    /// CHECK: Created in this instruction
    #[account(
        mut,
        seeds = [ZKSPL_VK_DATA_SEED, pool.key().as_ref()],
        bump
    )]
    pub vk_data_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Write chunk of zkSPL VK data.
#[derive(Accounts)]
#[instruction(offset: u32, data: Vec<u8>)]
pub struct WriteZkSplVkData<'info> {
    /// Pool authority (must sign)
    #[account(
        constraint = authority.key() == pool.authority @ TrustlessError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Pool state
    #[account(
        seeds = [
            PoolState::SEED_PREFIX,
            pool.token_mint.as_ref(),
            &pool.denomination.to_le_bytes()
        ],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,

    /// zkSPL VK data account (PDA owned by this program)
    /// CHECK: Must exist and be owned by this program
    #[account(
        mut,
        seeds = [ZKSPL_VK_DATA_SEED, pool.key().as_ref()],
        bump,
        constraint = vk_data_account.owner == &crate::ID @ TrustlessError::InvalidVerificationKey
    )]
    pub vk_data_account: UncheckedAccount<'info>,
}

pub fn handler_init(ctx: Context<InitZkSplVkData>, vk_size: u32) -> Result<()> {
    require!(vk_size >= 452, TrustlessError::InvalidVerificationKey);
    require!(vk_size <= MAX_VK_SIZE, TrustlessError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let pool_key = ctx.accounts.pool.key();

    let (_, bump) = Pubkey::find_program_address(
        &[ZKSPL_VK_DATA_SEED, pool_key.as_ref()],
        ctx.program_id,
    );

    let required_space = vk_size as usize;
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(required_space);
    let current_lamports = vk_account.lamports();

    if current_lamports == 0 {
        msg!("Creating zkSPL VK data account with {} bytes", required_space);

        let signer_seeds: &[&[&[u8]]] = &[&[ZKSPL_VK_DATA_SEED, pool_key.as_ref(), &[bump]]];

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: vk_account.to_account_info(),
                },
                signer_seeds,
            ),
            required_lamports,
            required_space as u64,
            ctx.program_id,
        )?;
    } else if vk_account.data_len() != required_space {
        msg!("Resizing zkSPL VK data account to {} bytes", required_space);
        vk_account.resize(required_space)?;

        if required_lamports > current_lamports {
            let diff = required_lamports - current_lamports;
            **ctx.accounts.authority.try_borrow_mut_lamports()? -= diff;
            **vk_account.try_borrow_mut_lamports()? += diff;
        }
    }

    msg!("zkSPL VK data account initialized: {}", vk_account.key());
    Ok(())
}

pub fn handler_write(ctx: Context<WriteZkSplVkData>, offset: u32, data: Vec<u8>) -> Result<()> {
    require!(data.len() <= MAX_CHUNK_SIZE, TrustlessError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let account_size = vk_account.data_len();
    let offset = offset as usize;

    require!(
        offset + data.len() <= account_size,
        TrustlessError::InvalidVerificationKey
    );

    let mut account_data = vk_account.try_borrow_mut_data()?;
    account_data[offset..offset + data.len()].copy_from_slice(&data);

    msg!("Wrote {} bytes at offset {}", data.len(), offset);
    Ok(())
}
