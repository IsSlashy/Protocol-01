use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod verifier;

use instructions::*;

declare_id!("GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c");

#[program]
pub mod zk_shielded {
    use super::*;

    /// Initialize a new shielded pool for a specific token
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        vk_hash: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_pool::handler(ctx, vk_hash)
    }

    /// Shield tokens: deposit transparent tokens into the shielded pool
    /// Creates a new note commitment and adds it to the Merkle tree
    pub fn shield(
        ctx: Context<Shield>,
        amount: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        instructions::shield::handler(ctx, amount, commitment)
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
        output_commitment: [u8; 32],
        merkle_root: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        instructions::unshield::handler(
            ctx,
            proof,
            nullifier_1,
            nullifier_2,
            output_commitment,
            merkle_root,
            amount,
        )
    }

    /// Update the verification key (admin only)
    pub fn update_verification_key(
        ctx: Context<UpdateVerificationKey>,
        new_vk_hash: [u8; 32],
    ) -> Result<()> {
        instructions::update_vk::handler(ctx, new_vk_hash)
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
