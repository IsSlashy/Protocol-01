use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ZkShieldedError;
use crate::state::ShieldedPool;

/// Seed for transfer VK data PDA (separate from unshield VK)
pub const VK_DATA_TRANSFER_SEED: &[u8] = b"vk_data_transfer";

/// Maximum VK data size
const MAX_VK_SIZE: u32 = 2048;

/// Maximum chunk size per transaction
const MAX_CHUNK_SIZE: usize = 800;

// ---------------------------------------------------------------------------
// Init transfer VK data account
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(vk_size: u32)]
pub struct InitTransferVkData<'info> {
    #[account(
        mut,
        constraint = authority.key() == shielded_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [ShieldedPool::SEED_PREFIX, shielded_pool.token_mint.as_ref()],
        bump = shielded_pool.bump
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    /// CHECK: Created or resized in this instruction
    #[account(
        mut,
        seeds = [VK_DATA_TRANSFER_SEED, shielded_pool.key().as_ref()],
        bump
    )]
    pub vk_data_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_init_transfer(ctx: Context<InitTransferVkData>, vk_size: u32) -> Result<()> {
    require!(vk_size >= 452, ZkShieldedError::InvalidVerificationKey);
    require!(vk_size <= MAX_VK_SIZE, ZkShieldedError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let pool_key = ctx.accounts.shielded_pool.key();

    let (_, bump) = Pubkey::find_program_address(
        &[VK_DATA_TRANSFER_SEED, pool_key.as_ref()],
        ctx.program_id,
    );

    let required_space = vk_size as usize;
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(required_space);
    let current_lamports = vk_account.lamports();

    if current_lamports == 0 {
        msg!("Creating transfer VK data account with {} bytes", required_space);

        let signer_seeds: &[&[&[u8]]] =
            &[&[VK_DATA_TRANSFER_SEED, pool_key.as_ref(), &[bump]]];

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
        msg!("Resizing transfer VK data account to {} bytes", required_space);
        vk_account.resize(required_space)?;

        if required_lamports > current_lamports {
            let diff = required_lamports - current_lamports;
            **ctx.accounts.authority.try_borrow_mut_lamports()? -= diff;
            **vk_account.try_borrow_mut_lamports()? += diff;
        }
    }

    msg!("Transfer VK data account initialized: {}", vk_account.key());
    Ok(())
}

// ---------------------------------------------------------------------------
// Write transfer VK data chunks
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(offset: u32, data: Vec<u8>)]
pub struct WriteTransferVkData<'info> {
    #[account(
        constraint = authority.key() == shielded_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [ShieldedPool::SEED_PREFIX, shielded_pool.token_mint.as_ref()],
        bump = shielded_pool.bump
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    /// CHECK: Must exist and be owned by this program
    #[account(
        mut,
        seeds = [VK_DATA_TRANSFER_SEED, shielded_pool.key().as_ref()],
        bump,
        constraint = vk_data_account.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub vk_data_account: UncheckedAccount<'info>,
}

pub fn handler_write_transfer(
    ctx: Context<WriteTransferVkData>,
    offset: u32,
    data: Vec<u8>,
) -> Result<()> {
    require!(data.len() <= MAX_CHUNK_SIZE, ZkShieldedError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let account_size = vk_account.data_len();
    let offset = offset as usize;

    require!(
        offset + data.len() <= account_size,
        ZkShieldedError::InvalidVerificationKey
    );

    let mut account_data = vk_account.try_borrow_mut_data()?;
    account_data[offset..offset + data.len()].copy_from_slice(&data);

    msg!("Wrote {} bytes at offset {} (transfer VK)", data.len(), offset);
    Ok(())
}
