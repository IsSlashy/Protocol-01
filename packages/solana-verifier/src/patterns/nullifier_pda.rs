//! # PDA-per-Nullifier: Atomic Double-Spend Prevention
//!
//! ## The Problem
//! Privacy protocols need to prevent the same note from being spent twice.
//! The standard approach (Bloom filters) has false positives and requires
//! careful sizing. State compression is complex and adds latency.
//!
//! ## The Solution
//! Use Solana's PDA (Program Derived Address) system with `init` constraint.
//! Each nullifier gets its own account. If the account already exists,
//! `init` fails atomically -- no false positives, no race conditions.
//!
//! ## Anchor Example
//!
//! ```rust,ignore
//! use anchor_lang::prelude::*;
//!
//! #[account]
//! pub struct NullifierRecord {
//!     pub used: bool,
//! }
//!
//! #[derive(Accounts)]
//! #[instruction(nullifier: [u8; 32])]
//! pub struct SpendNote<'info> {
//!     #[account(mut)]
//!     pub payer: Signer<'info>,
//!
//!     #[account(mut)]
//!     pub pool: Account<'info, Pool>,
//!
//!     // This is the key: init + seeds = atomic uniqueness check
//!     #[account(
//!         init,
//!         seeds = [b"nullifier", pool.key().as_ref(), &nullifier],
//!         bump,
//!         payer = payer,
//!         space = 8 + 1, // discriminator + bool
//!     )]
//!     pub nullifier_record: Account<'info, NullifierRecord>,
//!
//!     pub system_program: Program<'info, System>,
//! }
//! ```
//!
//! ## Why This Is Better Than Bloom Filters
//!
//! | Property | PDA-per-Nullifier | Bloom Filter |
//! |----------|------------------|--------------|
//! | False positives | Zero | Non-zero (depends on sizing) |
//! | Atomicity | Built-in (init fails if exists) | Requires manual check |
//! | Concurrency | Safe (Solana handles conflicts) | Requires locking |
//! | Storage cost | ~128 bytes per nullifier | Fixed size, but can overflow |
//! | Lookup cost | O(1) via PDA derivation | O(k) hash lookups |
//!
//! ## Cost Analysis
//!
//! Each nullifier PDA costs ~0.001 SOL in rent (for a minimal account).
//! For a pool with 10,000 nullifiers, that's ~10 SOL total.
//! This is acceptable because:
//! - The cost is paid by the spender (included in tx fee)
//! - Rent is recoverable if the program supports closing nullifier accounts
//! - The security guarantee (zero false positives) is worth the cost
