use anchor_lang::prelude::*;

declare_id!("P01WL1stxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

#[program]
pub mod p01_whitelist {
    use super::*;

    /// Initialize the whitelist with an admin
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let whitelist = &mut ctx.accounts.whitelist;
        whitelist.admin = ctx.accounts.admin.key();
        whitelist.total_requests = 0;
        whitelist.total_approved = 0;
        msg!("Whitelist initialized with admin: {}", whitelist.admin);
        Ok(())
    }

    /// Developer requests access (stores encrypted email IPFS CID)
    pub fn request_access(
        ctx: Context<RequestAccess>,
        ipfs_cid: String,
        project_name: String,
    ) -> Result<()> {
        require!(ipfs_cid.len() <= 64, WhitelistError::IpfsCidTooLong);
        require!(project_name.len() <= 64, WhitelistError::ProjectNameTooLong);

        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.developer.key();
        entry.ipfs_cid = ipfs_cid;
        entry.project_name = project_name;
        entry.status = WhitelistStatus::Pending;
        entry.requested_at = Clock::get()?.unix_timestamp;
        entry.reviewed_at = 0;
        entry.bump = ctx.bumps.whitelist_entry;

        let whitelist = &mut ctx.accounts.whitelist;
        whitelist.total_requests += 1;

        msg!("Access requested by: {}", entry.wallet);
        Ok(())
    }

    /// Admin approves a request
    pub fn approve_request(ctx: Context<ReviewRequest>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        require!(
            entry.status == WhitelistStatus::Pending,
            WhitelistError::NotPending
        );

        entry.status = WhitelistStatus::Approved;
        entry.reviewed_at = Clock::get()?.unix_timestamp;

        let whitelist = &mut ctx.accounts.whitelist;
        whitelist.total_approved += 1;

        msg!("Request approved for: {}", entry.wallet);
        Ok(())
    }

    /// Admin rejects a request
    pub fn reject_request(ctx: Context<ReviewRequest>, reason: String) -> Result<()> {
        require!(reason.len() <= 128, WhitelistError::ReasonTooLong);

        let entry = &mut ctx.accounts.whitelist_entry;
        require!(
            entry.status == WhitelistStatus::Pending,
            WhitelistError::NotPending
        );

        entry.status = WhitelistStatus::Rejected;
        entry.reviewed_at = Clock::get()?.unix_timestamp;

        msg!("Request rejected for: {} - {}", entry.wallet, reason);
        Ok(())
    }

    /// Admin revokes access
    pub fn revoke_access(ctx: Context<ReviewRequest>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        require!(
            entry.status == WhitelistStatus::Approved,
            WhitelistError::NotApproved
        );

        entry.status = WhitelistStatus::Revoked;
        entry.reviewed_at = Clock::get()?.unix_timestamp;

        let whitelist = &mut ctx.accounts.whitelist;
        whitelist.total_approved -= 1;

        msg!("Access revoked for: {}", entry.wallet);
        Ok(())
    }

    /// Check if a wallet has access (view function)
    pub fn check_access(ctx: Context<CheckAccess>) -> Result<bool> {
        let entry = &ctx.accounts.whitelist_entry;
        let has_access = entry.status == WhitelistStatus::Approved;
        msg!("Access check for {}: {}", entry.wallet, has_access);
        Ok(has_access)
    }
}

// ============ Accounts ============

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Whitelist::INIT_SPACE,
        seeds = [b"whitelist"],
        bump
    )]
    pub whitelist: Account<'info, Whitelist>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestAccess<'info> {
    #[account(
        mut,
        seeds = [b"whitelist"],
        bump
    )]
    pub whitelist: Account<'info, Whitelist>,

    #[account(
        init,
        payer = developer,
        space = 8 + WhitelistEntry::INIT_SPACE,
        seeds = [b"entry", developer.key().as_ref()],
        bump
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    #[account(mut)]
    pub developer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReviewRequest<'info> {
    #[account(
        mut,
        seeds = [b"whitelist"],
        bump,
        has_one = admin
    )]
    pub whitelist: Account<'info, Whitelist>,

    #[account(
        mut,
        seeds = [b"entry", whitelist_entry.wallet.as_ref()],
        bump = whitelist_entry.bump
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CheckAccess<'info> {
    #[account(
        seeds = [b"entry", wallet.key().as_ref()],
        bump = whitelist_entry.bump
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    /// CHECK: Just used as seed
    pub wallet: UncheckedAccount<'info>,
}

// ============ State ============

#[account]
#[derive(InitSpace)]
pub struct Whitelist {
    pub admin: Pubkey,
    pub total_requests: u64,
    pub total_approved: u64,
}

#[account]
#[derive(InitSpace)]
pub struct WhitelistEntry {
    pub wallet: Pubkey,
    #[max_len(64)]
    pub ipfs_cid: String,
    #[max_len(64)]
    pub project_name: String,
    pub status: WhitelistStatus,
    pub requested_at: i64,
    pub reviewed_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum WhitelistStatus {
    Pending,
    Approved,
    Rejected,
    Revoked,
}

// ============ Errors ============

#[error_code]
pub enum WhitelistError {
    #[msg("IPFS CID too long (max 64 chars)")]
    IpfsCidTooLong,
    #[msg("Project name too long (max 64 chars)")]
    ProjectNameTooLong,
    #[msg("Rejection reason too long (max 128 chars)")]
    ReasonTooLong,
    #[msg("Request is not pending")]
    NotPending,
    #[msg("Request is not approved")]
    NotApproved,
}
