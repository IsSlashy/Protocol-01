//! # Protocol 01 — Instant-unshield liquidity pool
//!
//! **Status: prefund/settle is CLOSED. See `settlement_path.rs` for why and
//! for the checklist that must be worked before re-opening it.**
//!
//! ## The "not deployed" claim that used to sit here was false
//!
//! This header previously read "EXPERIMENTAL — not deployed on devnet or
//! mainnet" and called `declare_id!` "a localnet placeholder". Measured on
//! devnet 2026-08-03, read-only, by
//! `node scripts/probe-liquidity-exposure.mjs`:
//!
//! ```text
//!   6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg
//!     executable = true, owner = BPFLoaderUpgradeab1e111...
//!     programdata = FxuCU6synNFRchQkxNX4vHAA6BZNNj6gHjPUHQaB68UW
//!     last deployed slot = 456503547
//!     upgrade authority   = 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU
//!     3 owned accounts, 0.575387859 SOL:
//!       DdqigYe… LiquidityPool  is_active=1  reserve 0.569708499 SOL
//!       EAFRWmV… PrefundRecord  amount 0.005388032 SOL, opened slot 456495936
//!       ECAgGt6… LPShare        575000000 shares, owner 7gWpzSZA…
//! ```
//!
//! It is absent from `Anchor.toml` — which is a gap in the deploy manifest,
//! not evidence of non-deployment. Being absent from `Anchor.toml` is exactly
//! why nobody noticed it had gone live.
//!
//! The one live `PrefundRecord` cannot be settled by anything: its
//! `denominated_pool` (`Djpj1PnM…`) is a **v2** `DenominatedPool`
//! (discriminator `1015c623b15c448c`) and the v2 unshield is gone, and its
//! `stark_proof_buffer` (`7iwbzT6Q…`) has been closed. Its rent
//! (0.00279 SOL) is stranded with it — `close = settler` on `Settle` is the
//! only thing that could return it. The LP's remaining 0.5697 SOL is NOT
//! stranded: `withdraw` pays it out against the share balance and does not
//! touch the record.
//!
//! ---
//!
//! # P-01 Liquidity Pool (C2-on)
//!
//! Fully on-chain "instant unshield" layer. LPs deposit SOL into a shared
//! reserve; when a user wants to unshield without waiting for epoch maturity,
//! anyone holding the user's one-shot ephemeral signer can call `prefund` to
//! pay the user immediately from the reserve.
//!
//! Once the note matures (dynamic_delay + min_epoch elapsed), ANY wallet can
//! call `settle`. Settle CPIs into zk_shielded's `unshield_denominated_stark`
//! with `recipient = liquidity_pool`, so the unshielded lamports flow INTO
//! the reserve. The caller earns `settler_reward` for driving the tx,
//! creating a permissionless keeper market.
//!
//! This is the "on-chain" alternative to the off-chain bundler loan: no
//! specific relay server required — any RPC works, any wallet can settle.
//!
//! ## Flow — DESIGN INTENT ONLY, step 3 has never been executable
//!
//! Steps 1–2 work. Step 3 does not: `unshield_denominated_stark` has not
//! existed since f5bb7514, so the cycle described below cannot close and both
//! `prefund` and `settle` now return
//! `LiquidityError::SettlementPathRetired` before doing anything. The text is
//! kept because it is the specification the v3 port has to satisfy.
//!
//! 1. User uploads + verifies STARK proof (circuit 1) via `p01_stark_verifier`
//!    as normal, authority = ephemeral signer E (single-use, HMAC-derived).
//! 2. User signs `prefund(nullifier, merkle_root, min_epoch, stark_commitment, amount)`
//!    with E. The tx:
//!    - Validates the proof buffer (owner, discriminator, circuit, authority=E, verified, hash).
//!    - Creates `PrefundRecord` PDA keyed by `(denominated_pool, nullifier)`.
//!    - Pays the recipient `amount − prefund_fee − settler_reward` from the pool.
//! 3. Anyone calls `settle(…)` once the note matures. The tx:
//!    - CPIs to `zk_shielded.unshield_denominated_stark` with `payer = settler`,
//!      `recipient = pool`, and the `PrefundRecord` as the extra signer-bypass
//!      account. zk_shielded sends `amount − unshield_fee` to the pool.
//!    - Pays `settler` the `settler_reward`.
//!    - Closes `PrefundRecord`, returning rent to `settler`.
//!
//! ## Economics
//!
//! Pool delta per cycle = `prefund_fee − unshield_fee`. With defaults of
//! `prefund_fee_bps = 80` and zk_shielded's hardcoded `UNSHIELD_FEE_BPS = 50`,
//! the pool nets ~0.3% per cycle before settler costs. LP yield compounds
//! through the share-price mechanism (no explicit distribution).
use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod settlement_path;
pub mod state;

use instructions::*;

declare_id!("6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg");

#[program]
pub mod p01_liquidity {
    use super::*;

    /// Initialize the global pool (single instance, PDA seed = "liquidity_pool").
    pub fn init_pool(
        ctx: Context<InitPool>,
        prefund_fee_bps: u16,
        settler_reward_bps: u16,
    ) -> Result<()> {
        instructions::init_pool::handler(ctx, prefund_fee_bps, settler_reward_bps)
    }

    /// Update tunable params (admin only).
    pub fn update_params(
        ctx: Context<UpdateParams>,
        prefund_fee_bps: Option<u16>,
        settler_reward_bps: Option<u16>,
        is_active: Option<bool>,
    ) -> Result<()> {
        instructions::update_params::handler(ctx, prefund_fee_bps, settler_reward_bps, is_active)
    }

    /// Deposit SOL, receive LP shares.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Burn LP shares, receive SOL (blocked if free reserve insufficient).
    pub fn withdraw(ctx: Context<Withdraw>, shares: u128) -> Result<()> {
        instructions::withdraw::handler(ctx, shares)
    }

    /// Open an instant unshield: validate the STARK proof, pay recipient, record.
    pub fn prefund(
        ctx: Context<Prefund>,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        stark_commitment: u64,
        amount: u64,
    ) -> Result<()> {
        instructions::prefund::handler(ctx, nullifier, merkle_root, min_epoch, stark_commitment, amount)
    }

    /// Permissionless settlement: CPI to zk_shielded, collect unshielded SOL, pay settler.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::handler(ctx)
    }
}
