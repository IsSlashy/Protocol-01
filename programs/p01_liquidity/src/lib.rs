//! # Protocol 01 — Instant-unshield liquidity pool
//!
//! **Status: EXPERIMENTAL — not deployed on devnet or mainnet.**
//!
//! This program is part of the workspace for development and CI builds, but
//! it is intentionally absent from `Anchor.toml [programs.devnet]` and
//! `[programs.mainnet]`. The address declared by `declare_id!` is a localnet
//! placeholder.
//!
//! Reference deployments and the production state of Protocol 01 use the
//! programs declared in `Anchor.toml [programs.devnet]`. Do not assume any
//! instruction here matches a live program ID.
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
//! ## Flow
//!
//! 1. User uploads + verifies STARK proof (circuit 1) via `p01_stark_verifier`
//!    as normal, authority = ephemeral signer E (single-use, HMAC-derived).
//! 2. User signs `prefund(nullifier, merkle_root, min_epoch, stark_commitment, amount)`
//!    with E. The tx:
//!    - Validates the proof buffer (owner, discriminator, circuit, authority=E,
//!      `verified` AND `deep_ali_verified`, hash).
//!    - Requires `denominated_pool.authority == pool.admin` and
//!      `amount == denominated_pool.denomination`.
//!    - Creates `PrefundRecord` PDA keyed by `(denominated_pool, nullifier[..8])`.
//!    - Pays the recipient `amount − prefund_fee − settler_reward` from the pool.
//!
//! ## `prefund` is OFF and must stay off
//!
//! `init_pool` creates the pool with `is_active = false`, and `prefund` requires
//! `is_active`. Step 3 below cannot currently run: `settle` CPIs
//! `zk_shielded::unshield_denominated_stark`, whose `#[program]` registration is
//! commented out (`zk_shielded/src/lib.rs:152-172`) in favour of
//! `unshield_denominated_stark_v3`. Until settle has a v3 path, every prefund is
//! a permanent loss from the reserve and no admin should sign
//! `update_params(is_active = Some(true))`.
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
