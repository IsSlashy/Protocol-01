//! # VK Hot-Swap: Update Verification Keys Without Migration
//!
//! ## The Problem
//! When you update a ZK circuit (e.g., add a new public input), the
//! verification key changes. If the VK is stored in a pool/state account,
//! you'd normally need to recreate all pools.
//!
//! ## The Solution
//! Store only the VK **hash** in the pool. Store the actual VK data in a
//! separate account. To update, upload new VK data and update the hash.
//!
//! ## Anchor Example
//!
//! ```rust,ignore
//! use anchor_lang::prelude::*;
//!
//! #[account]
//! pub struct Pool {
//!     pub authority: Pubkey,
//!     pub vk_hash: [u8; 32],  // keccak256 of VK data
//!     // ... other fields
//! }
//!
//! #[derive(Accounts)]
//! #[instruction(new_vk_hash: [u8; 32])]
//! pub struct UpdateVk<'info> {
//!     #[account(
//!         constraint = authority.key() == pool.authority @ MyError::Unauthorized
//!     )]
//!     pub authority: Signer<'info>,
//!
//!     #[account(mut)]
//!     pub pool: Account<'info, Pool>,
//! }
//!
//! pub fn update_vk(ctx: Context<UpdateVk>, new_vk_hash: [u8; 32]) -> Result<()> {
//!     ctx.accounts.pool.vk_hash = new_vk_hash;
//!     Ok(())
//! }
//! ```
//!
//! At verification time, hash the VK data and compare:
//!
//! ```rust,ignore
//! let computed_hash = p01_solana_verifier::compute_vk_hash(&vk_data);
//! require!(computed_hash == pool.vk_hash, MyError::InvalidVk);
//! ```
