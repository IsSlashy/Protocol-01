use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod verifier;

use instructions::*;

declare_id!("5x8qr9UwF6BTN4ySb4gPwL4TYgZiiLCzg4mKDmQrnjyJ");

#[program]
pub mod p01_trustless {
    use super::*;

    // -----------------------------------------------------------------------
    // Pool lifecycle
    // -----------------------------------------------------------------------

    /// Initialize a new trustless shielded pool for a specific token + denomination.
    /// Only pool initialization requires an authority signature.
    /// All subsequent operations are permissionless (proof = permission).
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        vk_hash: [u8; 32],
        zkspl_vk_hash: [u8; 32],
        token_mint: Pubkey,
        denomination: u64,
    ) -> Result<()> {
        instructions::initialize_pool::handler(ctx, vk_hash, zkspl_vk_hash, token_mint, denomination)
    }

    /// Initialize VK data account for the unshield circuit (admin only).
    /// Creates a PDA for storing verification key bytes.
    pub fn init_vk_data(
        ctx: Context<InitVkData>,
        vk_size: u32,
    ) -> Result<()> {
        instructions::store_vk_data::handler_init(ctx, vk_size)
    }

    /// Write a chunk of VK data for the unshield circuit (admin only).
    pub fn write_vk_data(
        ctx: Context<WriteVkData>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::store_vk_data::handler_write(ctx, offset, data)
    }

    /// Initialize VK data account for the zkSPL circuit (admin only).
    pub fn init_zkspl_vk_data(
        ctx: Context<InitZkSplVkData>,
        vk_size: u32,
    ) -> Result<()> {
        instructions::store_zkspl_vk_data::handler_init(ctx, vk_size)
    }

    /// Write a chunk of zkSPL VK data (admin only).
    pub fn write_zkspl_vk_data(
        ctx: Context<WriteZkSplVkData>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::store_zkspl_vk_data::handler_write(ctx, offset, data)
    }

    /// Update the unshield verification key hash (admin only).
    pub fn update_vk_hash(
        ctx: Context<UpdateVkHash>,
        new_vk_hash: [u8; 32],
    ) -> Result<()> {
        instructions::update_vk::handler(ctx, new_vk_hash)
    }

    // -----------------------------------------------------------------------
    // Trustless shielded pool operations
    // -----------------------------------------------------------------------

    /// Shield tokens: deposit into the shielded pool. No proof required.
    /// Creates a commitment and inserts it into the on-chain Merkle tree.
    /// Transfers exactly `pool.denomination` tokens from user to vault.
    /// Emits a commitment event for client-side Merkle tree indexing.
    pub fn shield_trustless(
        ctx: Context<ShieldTrustless>,
        commitment: [u8; 32],
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::shield_trustless::handler(ctx, commitment, new_root)
    }

    /// Unshield tokens: withdraw from pool by providing a Groth16 ZK proof.
    /// The proof is the ONLY authorization required -- no signer, no relayer.
    /// Trust the math, not the nodes.
    ///
    /// Public inputs: [merkle_root, nullifier, recipient, denomination, token_mint, min_epoch]
    /// Nullifier PDA prevents double-spend (permanent, on-chain).
    pub fn unshield_trustless(
        ctx: Context<UnshieldTrustless>,
        proof: Groth16Proof,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
    ) -> Result<()> {
        instructions::unshield_trustless::handler(ctx, proof, nullifier, merkle_root, min_epoch)
    }

    // -----------------------------------------------------------------------
    // Trustless zkSPL confidential balance operations
    // -----------------------------------------------------------------------

    /// Create a confidential balance account for a (user, token) pair.
    /// Initial commitment = Poseidon(0, salt, owner_pubkey, mint).
    pub fn create_confidential_account(
        ctx: Context<CreateConfidentialAccount>,
        initial_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::create_confidential_account::handler(ctx, initial_commitment)
    }

    /// Confidential balance operation with ZK proof -- fully trustless.
    /// Handles deposits (public_credit > 0), withdrawals (public_debit > 0),
    /// and private transfers (both = 0) in a single instruction.
    ///
    /// Public inputs: [old_commitment, new_commitment, amount_hash,
    ///                 public_credit, public_debit, token_mint, nonce]
    pub fn zkspl_trustless(
        ctx: Context<ZkSplTrustless>,
        proof: Groth16Proof,
        new_commitment: [u8; 32],
        amount_hash: [u8; 32],
        public_credit: u64,
        public_debit: u64,
    ) -> Result<()> {
        instructions::zkspl_trustless::handler(
            ctx,
            proof,
            new_commitment,
            amount_hash,
            public_credit,
            public_debit,
        )
    }
}

/// Groth16 proof structure for on-chain verification.
/// Matches the format used across all Protocol 01 programs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Groth16Proof {
    pub pi_a: [u8; 64],  // G1 point (uncompressed)
    pub pi_b: [u8; 128], // G2 point (uncompressed)
    pub pi_c: [u8; 64],  // G1 point (uncompressed)
}
