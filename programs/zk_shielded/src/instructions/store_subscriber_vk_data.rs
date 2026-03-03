use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ZkShieldedError;

/// Seed for subscriber ownership VK data PDA
pub const SUBSCRIBER_VK_DATA_SEED: &[u8] = b"vk_data_subscriber";

/// Maximum VK data size (subscriber ownership circuit is small — ~452 bytes)
pub const MAX_SUBSCRIBER_VK_SIZE: u32 = 2048;

/// Maximum chunk size per transaction
pub const MAX_SUBSCRIBER_CHUNK_SIZE: usize = 800;

/// Initialize subscriber ownership VK data account (admin only)
/// Global PDA: [b"vk_data_subscriber", authority]
#[derive(Accounts)]
#[instruction(vk_size: u32)]
pub struct InitSubscriberVkData<'info> {
    /// Authority (must sign)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// VK data account (PDA owned by this program)
    /// CHECK: Created in this instruction
    #[account(
        mut,
        seeds = [SUBSCRIBER_VK_DATA_SEED, authority.key().as_ref()],
        bump
    )]
    pub vk_data_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Write chunk of subscriber VK data (admin only)
#[derive(Accounts)]
#[instruction(offset: u32, data: Vec<u8>)]
pub struct WriteSubscriberVkData<'info> {
    /// Authority (must sign)
    pub authority: Signer<'info>,

    /// VK data account (PDA owned by this program)
    /// CHECK: Must exist and be owned by this program
    #[account(
        mut,
        seeds = [SUBSCRIBER_VK_DATA_SEED, authority.key().as_ref()],
        bump,
        constraint = vk_data_account.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub vk_data_account: UncheckedAccount<'info>,
}

pub fn handler_init_subscriber(ctx: Context<InitSubscriberVkData>, vk_size: u32) -> Result<()> {
    require!(vk_size >= 452, ZkShieldedError::InvalidVerificationKey);
    require!(vk_size <= MAX_SUBSCRIBER_VK_SIZE, ZkShieldedError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let authority_key = ctx.accounts.authority.key();

    let (_, bump) = Pubkey::find_program_address(
        &[SUBSCRIBER_VK_DATA_SEED, authority_key.as_ref()],
        ctx.program_id
    );

    let required_space = vk_size as usize;
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(required_space);
    let current_lamports = vk_account.lamports();

    if current_lamports == 0 {
        msg!("Creating subscriber VK data account with {} bytes", required_space);

        let signer_seeds: &[&[&[u8]]] = &[&[SUBSCRIBER_VK_DATA_SEED, authority_key.as_ref(), &[bump]]];

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
        msg!("Resizing subscriber VK data account to {} bytes", required_space);
        vk_account.resize(required_space)?;

        if required_lamports > current_lamports {
            let diff = required_lamports - current_lamports;
            **ctx.accounts.authority.try_borrow_mut_lamports()? -= diff;
            **vk_account.try_borrow_mut_lamports()? += diff;
        }
    }

    msg!("Subscriber VK data account initialized: {}", vk_account.key());
    Ok(())
}

pub fn handler_write_subscriber(ctx: Context<WriteSubscriberVkData>, offset: u32, data: Vec<u8>) -> Result<()> {
    require!(data.len() <= MAX_SUBSCRIBER_CHUNK_SIZE, ZkShieldedError::InvalidVerificationKey);

    let vk_account = &ctx.accounts.vk_data_account;
    let account_size = vk_account.data_len();
    let offset = offset as usize;

    require!(
        offset + data.len() <= account_size,
        ZkShieldedError::InvalidVerificationKey
    );

    let mut account_data = vk_account.try_borrow_mut_data()?;
    account_data[offset..offset + data.len()].copy_from_slice(&data);

    msg!("Wrote {} bytes at offset {}", data.len(), offset);
    Ok(())
}
