use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ZkShieldedError;
use crate::state::DenominatedPool;

/// Seed for escrow VK data PDA
pub const VK_DATA_ESCROW_SEED: &[u8] = b"vk_data_escrow";

const MAX_VK_SIZE: u32 = 4096;
const MAX_CHUNK_SIZE: usize = 800;

#[derive(Accounts)]
#[instruction(vk_size: u32)]
pub struct InitEscrowVkData<'info> {
    #[account(
        mut,
        constraint = authority.key() == denominated_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    /// CHECK: Created in this instruction
    #[account(
        mut,
        seeds = [VK_DATA_ESCROW_SEED, denominated_pool.key().as_ref()],
        bump
    )]
    pub vk_data_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_init_escrow_vk(ctx: Context<InitEscrowVkData>, vk_size: u32) -> Result<()> {
    require!(vk_size >= 452, ZkShieldedError::InvalidVerificationKey);
    require!(vk_size <= MAX_VK_SIZE, ZkShieldedError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let pool_key = ctx.accounts.denominated_pool.key();

    let (_, bump) = Pubkey::find_program_address(
        &[VK_DATA_ESCROW_SEED, pool_key.as_ref()],
        ctx.program_id,
    );

    let required_space = vk_size as usize;
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(required_space);
    let current_lamports = vk_account.lamports();

    if current_lamports == 0 {
        let signer_seeds: &[&[&[u8]]] =
            &[&[VK_DATA_ESCROW_SEED, pool_key.as_ref(), &[bump]]];

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
    }

    msg!("Escrow VK data account initialized: {}", vk_account.key());
    Ok(())
}

#[derive(Accounts)]
#[instruction(offset: u32, data: Vec<u8>)]
pub struct WriteEscrowVkData<'info> {
    #[account(
        constraint = authority.key() == denominated_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    /// CHECK: Must exist and be owned by this program
    #[account(
        mut,
        seeds = [VK_DATA_ESCROW_SEED, denominated_pool.key().as_ref()],
        bump,
        constraint = vk_data_account.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub vk_data_account: UncheckedAccount<'info>,
}

pub fn handler_write_escrow_vk(
    ctx: Context<WriteEscrowVkData>,
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

    msg!("Wrote {} bytes at offset {} (escrow VK)", data.len(), offset);
    Ok(())
}
