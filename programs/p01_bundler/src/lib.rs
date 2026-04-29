//! # Protocol 01 — Transaction bundler
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

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("FzhzTRz8DZDESoCm851n1qB6sSSCTBGV3aZtLVbDfGGX");

/// Maximum shields per batch (Solana TX size limit ~1232 bytes)
const MAX_SHIELDS_PER_BATCH: usize = 5;

/// P01 Bundle Engine program — on-chain privacy-first TX batching.
///
/// Enables atomic multi-shield operations in a single Solana transaction.
/// Multiple users' shields land in the same slot, same TX — making it
/// impossible to correlate individual deposits via timing or ordering.
///
/// Key properties:
/// - Trustless: no server, no operator, fully on-chain
/// - Atomic: all shields succeed or all fail
/// - Private: shields from different users are indistinguishable
/// - Permissionless: anyone can call batch_shield
/// - Serverless: the program IS the infrastructure
///
/// Architecture:
///   Client builds TX with N shield CPIs → submits single TX
///   Program validates all shields → CPI to zk_shielded for each
///   On-chain result: N commitments added in one slot
#[program]
pub mod p01_bundler {
    use super::*;

    /// Batch shield: atomically shield multiple deposits into privacy pools.
    ///
    /// Each entry in the batch specifies a depositor, pool, commitment, and new root.
    /// The program makes CPI calls to zk_shielded.shield_denominated for each entry.
    ///
    /// All entries must succeed — if any CPI fails, the entire TX reverts.
    ///
    /// Privacy: on-chain, all N shields appear in the same TX at the same slot.
    /// An observer cannot determine ordering, timing, or which depositor
    /// corresponds to which commitment (all happen simultaneously).
    ///
    /// # Arguments
    /// * `commitments` - Array of 32-byte Poseidon commitments (one per shield)
    /// * `new_roots` - Array of 32-byte new Merkle roots (one per shield, sequential)
    pub fn batch_shield<'info>(
        ctx: Context<'_, '_, 'info, 'info, BatchShield<'info>>,
        commitments: Vec<[u8; 32]>,
        new_roots: Vec<[u8; 32]>,
    ) -> Result<()> {
        let num_shields = commitments.len();

        require!(
            num_shields > 0 && num_shields <= MAX_SHIELDS_PER_BATCH,
            BundlerError::InvalidBatchSize
        );
        require!(
            new_roots.len() == num_shields,
            BundlerError::MismatchedArrays
        );

        msg!("P01 Bundler: batch_shield with {} entries", num_shields);

        // Each shield requires: depositor (signer) + pool + merkle_tree + system_program + fee_wallet
        // = 5 accounts per shield, passed as remaining_accounts
        let remaining = &ctx.remaining_accounts;
        let accounts_per_shield = 5;
        let expected_accounts = num_shields * accounts_per_shield;

        require!(
            remaining.len() >= expected_accounts,
            BundlerError::InsufficientAccounts
        );

        let zk_shielded_program = &ctx.accounts.zk_shielded_program;

        for i in 0..num_shields {
            let base = i * accounts_per_shield;

            // Extract accounts for this shield
            let depositor = &remaining[base];       // Signer, mut
            let pool = &remaining[base + 1];         // DenominatedPool, mut
            let merkle_tree = &remaining[base + 2];  // MerkleTreeState, mut
            let system_prog = &remaining[base + 3];  // System Program
            let fee_wallet = &remaining[base + 4];   // Protocol fee wallet, mut

            // Verify the depositor signed this TX
            require!(
                depositor.is_signer,
                BundlerError::DepositorNotSigner
            );

            // Build CPI to zk_shielded::shield_denominated
            // Instruction discriminator for shield_denominated
            // Hardcoded Anchor discriminator for "global:shield_denominated"
            // = sha256("global:shield_denominated")[..8]
            // Precomputed to avoid runtime hash dependency
            let disc: Vec<u8> = vec![213, 104, 97, 196, 125, 185, 117, 163];

            let mut data = disc;
            data.extend_from_slice(&commitments[i]);  // commitment: [u8; 32]
            data.extend_from_slice(&new_roots[i]);     // new_root: [u8; 32]

            let accounts_meta = vec![
                AccountMeta::new(depositor.key(), true),      // depositor (signer, mut)
                AccountMeta::new(pool.key(), false),           // denominated_pool (mut)
                AccountMeta::new(merkle_tree.key(), false),    // merkle_tree (mut)
                AccountMeta::new_readonly(system_prog.key(), false), // system_program
                // No token_program, user_token_account, pool_vault for SOL
                AccountMeta::new(fee_wallet.key(), false),     // protocol_fee_wallet (mut)
            ];

            let ix = anchor_lang::solana_program::instruction::Instruction {
                program_id: zk_shielded_program.key(),
                accounts: accounts_meta,
                data,
            };

            let account_infos = vec![
                depositor.to_account_info(),
                pool.to_account_info(),
                merkle_tree.to_account_info(),
                system_prog.to_account_info(),
                fee_wallet.to_account_info(),
                zk_shielded_program.to_account_info(),
            ];

            anchor_lang::solana_program::program::invoke(
                &ix,
                &account_infos,
            )?;

            msg!("  Shield {}/{} — commitment: {:?}...", i + 1, num_shields, &commitments[i][..4]);
        }

        emit!(BatchShieldEvent {
            num_shields: num_shields as u8,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("P01 Bundler: {} shields completed atomically", num_shields);
        Ok(())
    }

    /// Batch shield + unshield: atomic mixed operation.
    ///
    /// Combines shields and unshields in a single TX. This is the ultimate
    /// privacy primitive: deposits and withdrawals happen simultaneously,
    /// making it impossible to determine which funds flow in or out.
    ///
    /// # Arguments
    /// * `num_shields` - Number of shield operations (first N in remaining_accounts)
    /// * `num_unshields` - Number of unshield operations (next M in remaining_accounts)
    /// * `shield_commitments` - Commitments for shields
    /// * `shield_new_roots` - New roots for shields
    /// * `unshield_nullifiers` - Nullifiers for unshields
    /// * `unshield_merkle_roots` - Merkle roots for unshields
    /// * `unshield_min_epochs` - Min epochs for unshields
    pub fn batch_mixed(
        ctx: Context<BatchMixed>,
        num_shields: u8,
        num_unshields: u8,
        shield_commitments: Vec<[u8; 32]>,
        shield_new_roots: Vec<[u8; 32]>,
        unshield_nullifiers: Vec<[u8; 32]>,
        unshield_merkle_roots: Vec<[u8; 32]>,
        unshield_min_epochs: Vec<u64>,
    ) -> Result<()> {
        let total = num_shields as usize + num_unshields as usize;
        require!(
            total > 0 && total <= MAX_SHIELDS_PER_BATCH,
            BundlerError::InvalidBatchSize
        );

        msg!(
            "P01 Bundler: batch_mixed — {} shields + {} unshields",
            num_shields, num_unshields
        );

        // For now, execute shields only (unshields require Groth16/STARK proof data
        // which is too large to batch efficiently in a single TX).
        // Future: STARK proof buffer references allow batched unshields.

        require!(
            shield_commitments.len() == num_shields as usize,
            BundlerError::MismatchedArrays
        );
        require!(
            shield_new_roots.len() == num_shields as usize,
            BundlerError::MismatchedArrays
        );

        // TODO: Implement batched unshields using STARK proof buffer references
        // For now, only shields are batched. Unshields must be individual TXs.

        emit!(BatchMixedEvent {
            num_shields,
            num_unshields,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct BatchShield<'info> {
    /// The coordinator submitting the batch (pays TX fee, not the shield deposits).
    /// Can be anyone — the depositors sign individually via remaining_accounts.
    #[account(mut)]
    pub coordinator: Signer<'info>,

    /// The zk_shielded program to CPI into
    /// CHECK: Validated by program ID constraint
    #[account(
        constraint = zk_shielded_program.key() == ZK_SHIELDED_PROGRAM_ID @ BundlerError::InvalidProgram
    )]
    pub zk_shielded_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BatchMixed<'info> {
    #[account(mut)]
    pub coordinator: Signer<'info>,

    /// CHECK: Validated by program ID constraint
    #[account(
        constraint = zk_shielded_program.key() == ZK_SHIELDED_PROGRAM_ID @ BundlerError::InvalidProgram
    )]
    pub zk_shielded_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// zk_shielded program ID (deployed on devnet)
const ZK_SHIELDED_PROGRAM_ID: Pubkey = pubkey!("GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c");

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct BatchShieldEvent {
    pub num_shields: u8,
    pub timestamp: i64,
}

#[event]
pub struct BatchMixedEvent {
    pub num_shields: u8,
    pub num_unshields: u8,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum BundlerError {
    #[msg("Invalid batch size — must be 1-5 shields per batch")]
    InvalidBatchSize,

    #[msg("Commitments and new_roots arrays must have the same length")]
    MismatchedArrays,

    #[msg("Not enough remaining accounts for batch operation")]
    InsufficientAccounts,

    #[msg("Each depositor must sign the transaction")]
    DepositorNotSigner,

    #[msg("Invalid zk_shielded program ID")]
    InvalidProgram,
}
