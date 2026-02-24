use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::state::MintConfig;

/// Initialize a VK data account for storing verification key bytes.
/// Verification keys are too large for a single transaction, so they're
/// written in chunks via write_vk_data.
#[derive(Accounts)]
#[instruction(vk_type: u8, vk_size: u32)]
pub struct InitVkData<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump,
        constraint = mint_config.authority == authority.key() @ ZkSplError::Unauthorized
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// VK data PDA — stores raw verification key bytes
    /// vk_type: 0 = balance VK, 1 = proof VK
    #[account(
        init,
        payer = authority,
        space = 8 + 4 + vk_size as usize,
        seeds = [b"zkspl_vk", mint_config.key().as_ref(), &[vk_type]],
        bump
    )]
    /// CHECK: Raw data account, no deserialization needed
    pub vk_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_init(
    ctx: Context<InitVkData>,
    _vk_type: u8,
    vk_size: u32,
) -> Result<()> {
    // Write size header
    let mut data = ctx.accounts.vk_data.try_borrow_mut_data()?;
    let size_bytes = vk_size.to_le_bytes();
    data[8..12].copy_from_slice(&size_bytes);

    msg!("VK data account initialized, size: {} bytes", vk_size);
    Ok(())
}

/// Write a chunk of VK data to the account.
/// Called multiple times to upload the full verification key.
#[derive(Accounts)]
#[instruction(vk_type: u8, offset: u32, data: Vec<u8>)]
pub struct WriteVkData<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump,
        constraint = mint_config.authority == authority.key() @ ZkSplError::Unauthorized
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: Raw data account
    #[account(
        mut,
        seeds = [b"zkspl_vk", mint_config.key().as_ref(), &[vk_type]],
        bump
    )]
    pub vk_data: UncheckedAccount<'info>,
}

pub fn handler_write(
    ctx: Context<WriteVkData>,
    _vk_type: u8,
    offset: u32,
    data: Vec<u8>,
) -> Result<()> {
    let mut account_data = ctx.accounts.vk_data.try_borrow_mut_data()?;

    // Data starts after discriminator (8) + size header (4) = offset 12
    let start = 12 + offset as usize;
    let end = start + data.len();

    require!(end <= account_data.len(), ZkSplError::ArithmeticOverflow);

    account_data[start..end].copy_from_slice(&data);

    msg!("VK data written: offset={}, length={}", offset, data.len());
    Ok(())
}
