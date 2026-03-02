//! # Account Realloc: Add Fields Without Recreation
//!
//! ## The Problem
//! After deploying a program, you realize a state account needs more fields.
//! With Anchor's typed deserialization, undersized accounts fail to load.
//!
//! ## The Solution
//! Use `AccountInfo` instead of `Account<T>` to bypass deserialization,
//! manually validate ownership and authority, then `realloc` the account.
//!
//! ## Anchor Example
//!
//! ```rust,ignore
//! use anchor_lang::prelude::*;
//!
//! #[derive(Accounts)]
//! pub struct ResizeAccount<'info> {
//!     #[account(mut)]
//!     pub authority: Signer<'info>,
//!
//!     /// CHECK: Manually validated -- bypasses Anchor deserialization
//!     /// which would fail on undersized accounts.
//!     #[account(mut)]
//!     pub target_account: AccountInfo<'info>,
//!
//!     pub system_program: Program<'info, System>,
//! }
//!
//! pub fn resize(ctx: Context<ResizeAccount>, new_size: usize) -> Result<()> {
//!     let account = &ctx.accounts.target_account;
//!     let authority = &ctx.accounts.authority;
//!
//!     // Step 1: Validate account belongs to our program
//!     require!(account.owner == ctx.program_id, MyError::InvalidOwner);
//!
//!     // Step 2: Read authority from raw bytes (offset 8 = after discriminator)
//!     {
//!         let data = account.try_borrow_data()?;
//!         let stored_authority = Pubkey::try_from(&data[8..40])
//!             .map_err(|_| error!(MyError::InvalidData))?;
//!         require!(stored_authority == authority.key(), MyError::Unauthorized);
//!     }
//!
//!     // Step 3: Calculate rent difference
//!     let rent = Rent::get()?;
//!     let new_balance = rent.minimum_balance(new_size);
//!     let lamports_diff = new_balance.saturating_sub(account.lamports());
//!
//!     // Step 4: Transfer rent if needed
//!     if lamports_diff > 0 {
//!         anchor_lang::system_program::transfer(
//!             CpiContext::new(
//!                 ctx.accounts.system_program.to_account_info(),
//!                 anchor_lang::system_program::Transfer {
//!                     from: authority.to_account_info(),
//!                     to: account.clone(),
//!                 },
//!             ),
//!             lamports_diff,
//!         )?;
//!     }
//!
//!     // Step 5: Realloc (zero-fill new bytes)
//!     account.realloc(new_size, true)?;
//!
//!     Ok(())
//! }
//! ```
//!
//! ## Key Points
//!
//! - Use `AccountInfo` (not `Account<T>`) to avoid deserialization failure
//! - Always validate `owner == program_id` manually
//! - Always validate authority from raw bytes
//! - `realloc(size, true)` zero-fills new space -- safe for adding fields
//! - New fields will be zero-initialized (false for bool, 0 for numbers, [0u8;32] for hashes)
