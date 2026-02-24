use anchor_lang::prelude::*;

use crate::errors::ZkSplError;
use crate::state::{ConfidentialAccount, MintConfig};

/// Add a viewing key to a confidential account (opt-in compliance).
/// The viewer can then request the account owner to provide a viewing proof.
/// This is entirely voluntary — the owner controls who can view.
#[derive(Accounts)]
pub struct AddViewer<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump
    )]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            owner.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.is_initialized @ ZkSplError::AccountNotInitialized,
        constraint = confidential_account.owner == owner.key() @ ZkSplError::Unauthorized
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,
}

pub fn handler_add_viewer(
    ctx: Context<AddViewer>,
    viewer: Pubkey,
) -> Result<()> {
    let account = &mut ctx.accounts.confidential_account;

    require!(
        account.viewer_keys.len() < ConfidentialAccount::MAX_VIEWER_KEYS,
        ZkSplError::TooManyViewerKeys
    );

    require!(
        !account.viewer_keys.contains(&viewer),
        ZkSplError::ViewerKeyAlreadyExists
    );

    account.viewer_keys.push(viewer);

    msg!("Viewer added: {}", viewer);
    Ok(())
}

/// Remove a viewing key from a confidential account.
#[derive(Accounts)]
pub struct RemoveViewer<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint_config.token_mint.as_ref()],
        bump = mint_config.bump
    )]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        mut,
        seeds = [
            ConfidentialAccount::SEED_PREFIX,
            owner.key().as_ref(),
            mint_config.token_mint.as_ref()
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.is_initialized @ ZkSplError::AccountNotInitialized,
        constraint = confidential_account.owner == owner.key() @ ZkSplError::Unauthorized
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,
}

pub fn handler_remove_viewer(
    ctx: Context<RemoveViewer>,
    viewer: Pubkey,
) -> Result<()> {
    let account = &mut ctx.accounts.confidential_account;

    let index = account.viewer_keys.iter()
        .position(|k| *k == viewer)
        .ok_or(ZkSplError::ViewerKeyNotFound)?;

    account.viewer_keys.remove(index);

    msg!("Viewer removed: {}", viewer);
    Ok(())
}
