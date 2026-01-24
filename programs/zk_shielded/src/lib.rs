use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod verifier;

use instructions::*;

declare_id!("8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY");

#[program]
pub mod zk_shielded {
    use super::*;

    /// Initialize a new shielded pool for a specific token
    /// For native SOL, pass System Program ID as token_mint
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        vk_hash: [u8; 32],
        token_mint: Pubkey,
    ) -> Result<()> {
        instructions::initialize_pool::handler(ctx, vk_hash, token_mint)
    }

    /// Shield tokens: deposit transparent tokens into the shielded pool
    /// Creates a new note commitment and adds it to the Merkle tree
    /// The new_root is computed off-chain (Poseidon syscall not yet enabled on devnet)
    pub fn shield(
        ctx: Context<Shield>,
        amount: u64,
        commitment: [u8; 32],
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::shield::handler(ctx, amount, commitment, new_root)
    }

    /// Transfer shielded tokens privately
    /// Spends input notes (via nullifiers) and creates new output notes
    /// Requires a valid ZK proof
    pub fn transfer(
        ctx: Context<Transfer>,
        proof: Groth16Proof,
        nullifier_1: [u8; 32],
        nullifier_2: [u8; 32],
        output_commitment_1: [u8; 32],
        output_commitment_2: [u8; 32],
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::transfer::handler(
            ctx,
            proof,
            nullifier_1,
            nullifier_2,
            output_commitment_1,
            output_commitment_2,
            merkle_root,
        )
    }

    /// Unshield tokens: withdraw from shielded pool to transparent address
    /// Requires a valid ZK proof showing ownership of the notes
    pub fn unshield(
        ctx: Context<Unshield>,
        proof: Groth16Proof,
        nullifier_1: [u8; 32],
        nullifier_2: [u8; 32],
        output_commitment_1: [u8; 32],
        output_commitment_2: [u8; 32],
        merkle_root: [u8; 32],
        amount: u64,
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::unshield::handler(
            ctx,
            proof,
            nullifier_1,
            nullifier_2,
            output_commitment_1,
            output_commitment_2,
            merkle_root,
            amount,
            new_root,
        )
    }

    /// Update the verification key (admin only)
    pub fn update_verification_key(
        ctx: Context<UpdateVerificationKey>,
        new_vk_hash: [u8; 32],
    ) -> Result<()> {
        instructions::update_vk::handler(ctx, new_vk_hash)
    }

    /// Initialize VK data account (admin only)
    /// Creates a PDA for storing verification key bytes
    pub fn init_vk_data(
        ctx: Context<InitVkData>,
        vk_size: u32,
    ) -> Result<()> {
        instructions::store_vk_data::handler_init(ctx, vk_size)
    }

    /// Write chunk of VK data (admin only)
    /// Used to upload VK data in multiple transactions
    pub fn write_vk_data(
        ctx: Context<WriteVkData>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::store_vk_data::handler_write(ctx, offset, data)
    }

    /// Transfer via relayer (gasless transactions)
    /// The relayer pays for gas and receives a fee from the shielded transfer
    pub fn transfer_via_relayer(
        ctx: Context<TransferViaRelayer>,
        proof: Groth16Proof,
        nullifier_1: [u8; 32],
        nullifier_2: [u8; 32],
        output_commitment_1: [u8; 32],
        output_commitment_2: [u8; 32],
        output_commitment_relayer_fee: [u8; 32],
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::transfer_via_relayer::handler(
            ctx,
            proof,
            nullifier_1,
            nullifier_2,
            output_commitment_1,
            output_commitment_2,
            output_commitment_relayer_fee,
            merkle_root,
        )
    }
}

/// Groth16 proof structure for on-chain verification
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Groth16Proof {
    pub pi_a: [u8; 64],  // G1 point (compressed)
    pub pi_b: [u8; 128], // G2 point (compressed)
    pub pi_c: [u8; 64],  // G1 point (compressed)
}
