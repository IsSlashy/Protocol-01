use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ZkShieldedError;
use crate::state::ShieldedPool;

/// Initialize VK data account
/// Creates the account with the required size
#[derive(Accounts)]
#[instruction(vk_size: u32)]
pub struct InitVkData<'info> {
    /// Pool authority (must sign)
    #[account(
        mut,
        constraint = authority.key() == shielded_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Shielded pool
    #[account(
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    /// VK data account (PDA owned by this program)
    /// CHECK: Created in this instruction
    #[account(
        mut,
        seeds = [VK_DATA_SEED, shielded_pool.key().as_ref()],
        bump
    )]
    pub vk_data_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Write chunk of VK data
#[derive(Accounts)]
#[instruction(offset: u32, data: Vec<u8>)]
pub struct WriteVkData<'info> {
    /// Pool authority (must sign)
    #[account(
        constraint = authority.key() == shielded_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Shielded pool
    #[account(
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    /// VK data account (PDA owned by this program)
    /// CHECK: Must exist and be owned by this program
    #[account(
        mut,
        seeds = [VK_DATA_SEED, shielded_pool.key().as_ref()],
        bump,
        constraint = vk_data_account.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub vk_data_account: UncheckedAccount<'info>,
}

/// Seed for VK data PDA
pub const VK_DATA_SEED: &[u8] = b"vk_data";

/// Maximum VK data size
pub const MAX_VK_SIZE: u32 = 2048;

/// Maximum chunk size per transaction (~800 bytes to stay under tx limit)
pub const MAX_CHUNK_SIZE: usize = 800;

pub fn handler_init(ctx: Context<InitVkData>, vk_size: u32) -> Result<()> {
    // Validate size
    require!(vk_size >= 452, ZkShieldedError::InvalidVerificationKey);
    require!(vk_size <= MAX_VK_SIZE, ZkShieldedError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let pool_key = ctx.accounts.shielded_pool.key();

    // Find bump
    let (_, bump) = Pubkey::find_program_address(
        &[VK_DATA_SEED, pool_key.as_ref()],
        ctx.program_id
    );

    let required_space = vk_size as usize;
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(required_space);

    let current_lamports = vk_account.lamports();

    if current_lamports == 0 {
        // Create new account
        msg!("Creating VK data account with {} bytes", required_space);

        let signer_seeds: &[&[&[u8]]] = &[&[VK_DATA_SEED, pool_key.as_ref(), &[bump]]];

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: vk_account.to_account_info(),
                },
                signer_seeds
            ),
            required_lamports,
            required_space as u64,
            ctx.program_id
        )?;
    } else if vk_account.data_len() != required_space {
        // Resize if needed
        msg!("Resizing VK data account to {} bytes", required_space);
        vk_account.realloc(required_space, false)?;

        // Adjust lamports
        if required_lamports > current_lamports {
            let diff = required_lamports - current_lamports;
            **ctx.accounts.authority.try_borrow_mut_lamports()? -= diff;
            **vk_account.try_borrow_mut_lamports()? += diff;
        }
    }

    msg!("VK data account initialized: {}", vk_account.key());
    Ok(())
}

pub fn handler_write(ctx: Context<WriteVkData>, offset: u32, data: Vec<u8>) -> Result<()> {
    // Validate chunk size
    require!(data.len() <= MAX_CHUNK_SIZE, ZkShieldedError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let account_size = vk_account.data_len();
    let offset = offset as usize;

    // Validate offset and data fit within account
    require!(
        offset + data.len() <= account_size,
        ZkShieldedError::InvalidVerificationKey
    );

    // Write data
    let mut account_data = vk_account.try_borrow_mut_data()?;
    account_data[offset..offset + data.len()].copy_from_slice(&data);

    msg!("Wrote {} bytes at offset {}", data.len(), offset);
    Ok(())
}

// Keep backward compatibility with old instruction name
pub use InitVkData as StoreVkData;
pub fn handler(ctx: Context<InitVkData>, vk_size: u32) -> Result<()> {
    handler_init(ctx, vk_size)
}
