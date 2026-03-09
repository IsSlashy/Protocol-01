use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod verifier;

use instructions::*;

declare_id!("AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT");

#[program]
pub mod p01_zkspl {
    use super::*;

    /// Register an SPL token for zkSPL confidential operations.
    /// Creates a MintConfig PDA with verification key hashes.
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
    /// Amount is public. ZK proof verifies correct commitment update.
    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
        proof: Groth16Proof,
        new_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::deposit::handler(ctx, amount, proof, new_commitment)
    }

    /// Private transfer between two confidential accounts.
    /// Amount is hidden — only amount_hash is stored on-chain.
    /// Creates a pending credit for the recipient.
    pub fn confidential_transfer(
        ctx: Context<ConfidentialTransfer>,
        proof: Groth16Proof,
        new_commitment: [u8; 32],
        amount_hash: [u8; 32],
    ) -> Result<()> {
        instructions::confidential_transfer::handler(ctx, proof, new_commitment, amount_hash)
    }

    /// Apply a pending credit to update recipient's balance.
    /// Recipient proves they correctly integrated the amount.
    pub fn apply_pending(
        ctx: Context<ApplyPending>,
        proof: Groth16Proof,
        new_commitment: [u8; 32],
        amount_hash: [u8; 32],
    ) -> Result<()> {
        instructions::apply_pending::handler(ctx, proof, new_commitment, amount_hash)
    }

    /// Withdraw from confidential account to regular SPL tokens.
    /// Amount is public. ZK proof verifies correct commitment update.
    pub fn withdraw(
        ctx: Context<Withdraw>,
        amount: u64,
        proof: Groth16Proof,
        new_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::withdraw::handler(ctx, amount, proof, new_commitment)
    }

    /// Prove balance >= threshold without revealing the actual balance.
    /// For DeFi composability (DEXes, lending, etc.).
    pub fn prove_balance(
        ctx: Context<ProveBalance>,
        threshold: u64,
        proof: Groth16Proof,
    ) -> Result<()> {
        instructions::prove_balance::handler(ctx, threshold, proof)
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

    /// Initialize VK data storage account.
    /// vk_type: 0 = balance circuit VK, 1 = proof circuit VK
    pub fn init_vk_data(
        ctx: Context<InitVkData>,
        vk_type: u8,
        vk_size: u32,
    ) -> Result<()> {
        instructions::store_vk_data::handler_init(ctx, vk_type, vk_size)
    }

    /// Write VK data chunk.
    pub fn write_vk_data(
        ctx: Context<WriteVkData>,
        vk_type: u8,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::store_vk_data::handler_write(ctx, vk_type, offset, data)
    }
}

/// Groth16 proof structure for on-chain verification
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Groth16Proof {
    pub pi_a: [u8; 64],  // G1 point
    pub pi_b: [u8; 128], // G2 point
    pub pi_c: [u8; 64],  // G1 point
}
