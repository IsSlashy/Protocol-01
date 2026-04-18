use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod stark_proof;
pub mod state;

use instructions::*;

declare_id!("AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT");

#[program]
pub mod p01_zkspl {
    use super::*;

    /// Register an SPL token for zkSPL confidential operations.
    /// Creates a MintConfig PDA.
    pub fn initialize_mint(
        ctx: Context<InitializeMint>,
        balance_vk_hash: [u8; 32],
        proof_vk_hash: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_mint::handler(ctx, balance_vk_hash, proof_vk_hash)
    }

    /// Create a confidential account for a (user, token) pair.
    /// Initial commitment = Poseidon(0, salt, owner_pubkey, mint).
    pub fn create_account(
        ctx: Context<CreateAccount>,
        initial_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::create_account::handler(ctx, initial_commitment)
    }

    /// Deposit SPL tokens into a confidential account.
    /// Amount is public. STARK proof (circuit 4) verifies correct commitment update.
    /// The caller must upload & verify the proof via p01_stark_verifier first,
    /// then pass the verified proof buffer account.
    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
        new_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::deposit::handler(ctx, amount, new_commitment)
    }

    /// Private transfer between two confidential accounts.
    /// Amount is hidden — only amount_hash is stored on-chain.
    /// STARK proof (circuit 5) verifies correct commitment update.
    pub fn confidential_transfer(
        ctx: Context<ConfidentialTransfer>,
        new_commitment: [u8; 32],
        amount_hash: [u8; 32],
    ) -> Result<()> {
        instructions::confidential_transfer::handler(ctx, new_commitment, amount_hash)
    }

    /// Apply a pending credit to update recipient's balance.
    /// STARK proof (circuit 4) verifies recipient correctly integrated the amount.
    pub fn apply_pending(
        ctx: Context<ApplyPending>,
        new_commitment: [u8; 32],
        amount_hash: [u8; 32],
    ) -> Result<()> {
        instructions::apply_pending::handler(ctx, new_commitment, amount_hash)
    }

    /// Withdraw from confidential account to regular SPL tokens.
    /// Amount is public. STARK proof (circuit 4) verifies correct commitment update.
    pub fn withdraw(
        ctx: Context<Withdraw>,
        amount: u64,
        new_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::withdraw::handler(ctx, amount, new_commitment)
    }

    /// Prove balance >= threshold without revealing the actual balance.
    /// For DeFi composability. STARK proof (circuit 2).
    pub fn prove_balance(
        ctx: Context<ProveBalance>,
        threshold: u64,
    ) -> Result<()> {
        instructions::prove_balance::handler(ctx, threshold)
    }

    /// Add a viewing key (opt-in compliance).
    pub fn add_viewer(
        ctx: Context<AddViewer>,
        viewer: Pubkey,
    ) -> Result<()> {
        instructions::manage_viewers::handler_add_viewer(ctx, viewer)
    }

    /// Remove a viewing key.
    pub fn remove_viewer(
        ctx: Context<RemoveViewer>,
        viewer: Pubkey,
    ) -> Result<()> {
        instructions::manage_viewers::handler_remove_viewer(ctx, viewer)
    }
}
