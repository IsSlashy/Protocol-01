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
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::transfer::handler(
            ctx,
            proof,
            nullifier_1,
            nullifier_2,
            output_commitment_1,
            output_commitment_2,
            merkle_root,
            new_root,
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

    // -----------------------------------------------------------------------
    // Denominated Pool instructions (Tornado Cash model — fixed denominations)
    // -----------------------------------------------------------------------

    /// Initialize a denominated shielded pool for a specific token + denomination
    /// Each pool enforces a fixed deposit/withdrawal amount for maximum anonymity
    pub fn init_denominated_pool(
        ctx: Context<InitDenominatedPool>,
        vk_hash: [u8; 32],
        token_mint: Pubkey,
        denomination: u64,
        epoch_delay: u64,
    ) -> Result<()> {
        instructions::init_denominated_pool::handler(ctx, vk_hash, token_mint, denomination, epoch_delay)
    }

    /// Shield tokens into a denominated pool (deposit exactly denomination amount)
    /// Commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
    /// No amount in the commitment — denomination enforced at program level
    pub fn shield_denominated(
        ctx: Context<ShieldDenominated>,
        commitment: [u8; 32],
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::shield_denominated::handler(ctx, commitment, new_root)
    }

    /// Unshield tokens from a denominated pool (withdraw exactly denomination amount)
    /// Requires ZK proof with 5 public inputs: [merkle_root, nullifier, min_epoch, token_mint, enforce_maturity=1]
    /// Enforces time delay: current_epoch >= min_epoch + dynamic_delay
    pub fn unshield_denominated(
        ctx: Context<UnshieldDenominated>,
        proof: Groth16Proof,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
    ) -> Result<()> {
        instructions::unshield_denominated::handler(ctx, proof, nullifier, merkle_root, min_epoch)
    }

    /// Unshield from denominated pool using STARK proof (quantum-resistant).
    /// Requires a pre-verified STARK proof buffer from p01_stark_verifier.
    /// The STARK proof replaces Groth16 — no elliptic curve pairings needed.
    pub fn unshield_denominated_stark(
        ctx: Context<UnshieldDenominatedStark>,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
    ) -> Result<()> {
        instructions::unshield_denominated_stark::handler(ctx, nullifier, merkle_root, min_epoch)
    }

    /// Emergency unshield from a denominated pool (bypass maturity check)
    /// Same as unshield but with enforce_maturity=0 in the circuit proof.
    /// PRIVACY WARNING: Emergency unshields are distinguishable on-chain.
    pub fn emergency_unshield_denominated(
        ctx: Context<EmergencyUnshieldDenominated>,
        proof: Groth16Proof,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
    ) -> Result<()> {
        instructions::emergency_unshield_denominated::handler(ctx, proof, nullifier, merkle_root, min_epoch)
    }

    /// Update VK hash on a denominated pool (admin only)
    pub fn update_denominated_vk(
        ctx: Context<UpdateDenominatedVk>,
        new_vk_hash: [u8; 32],
    ) -> Result<()> {
        instructions::update_denominated_vk::handler(ctx, new_vk_hash)
    }

    /// Update the transfer verification key hash on a denominated pool
    pub fn update_transfer_vk(
        ctx: Context<UpdateTransferVk>,
        new_vk_hash: [u8; 32],
    ) -> Result<()> {
        instructions::update_transfer_vk::handler(ctx, new_vk_hash)
    }

    /// Resize an existing denominated pool to accommodate new fields
    pub fn resize_denominated_pool(ctx: Context<ResizeDenominatedPool>) -> Result<()> {
        instructions::resize_denominated_pool::handler(ctx)
    }

    /// Initialize transfer VK data account (admin only)
    /// Creates a PDA for storing transfer circuit verification key bytes
    pub fn init_transfer_vk_data(
        ctx: Context<InitTransferVkData>,
        vk_size: u32,
    ) -> Result<()> {
        instructions::store_transfer_vk_data::handler_init_transfer(ctx, vk_size)
    }

    /// Write chunk of transfer VK data (admin only)
    pub fn write_transfer_vk_data(
        ctx: Context<WriteTransferVkData>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::store_transfer_vk_data::handler_write_transfer(ctx, offset, data)
    }

    /// Transfer a note within a denominated pool to a new owner
    /// The old note is nullified and a new commitment is inserted into the tree.
    /// No funds move — same pool, same denomination.
    pub fn transfer_denominated(
        ctx: Context<TransferDenominated>,
        proof: Groth16Proof,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        new_commitment: [u8; 32],
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::transfer_denominated::handler(ctx, proof, nullifier, merkle_root, min_epoch, new_commitment, new_root)
    }

    // -----------------------------------------------------------------------
    // Subscription Vault instructions (normal + private ZK)
    // -----------------------------------------------------------------------

    /// Create a normal (wallet-based) subscription vault
    /// Deposits funds from subscriber wallet into vault PDA
    pub fn subscribe_normal(
        ctx: Context<SubscribeNormal>,
        rate: u64,
        interval_slots: u64,
        amount: u64,
        token_mint: Pubkey,
        vk_hash_subscriber: [u8; 32],
    ) -> Result<()> {
        instructions::subscribe_normal::handler(ctx, rate, interval_slots, amount, token_mint, vk_hash_subscriber)
    }

    /// Create a private (ZK-based) subscription vault by unshielding a denom pool note
    /// Subscriber identity hidden behind Poseidon(secret) commitment
    pub fn subscribe_private(
        ctx: Context<SubscribePrivate>,
        proof: Groth16Proof,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        subscriber_commitment: [u8; 32],
        rate: u64,
        interval_slots: u64,
        vk_hash_subscriber: [u8; 32],
    ) -> Result<()> {
        instructions::subscribe_private::handler(ctx, proof, nullifier, merkle_root, min_epoch, subscriber_commitment, rate, interval_slots, vk_hash_subscriber)
    }

    /// Claim accrued periods from a subscription vault (retailer only)
    pub fn claim_period(ctx: Context<ClaimPeriod>) -> Result<()> {
        instructions::claim_period::handler(ctx)
    }

    /// Pause a normal subscription vault (subscriber wallet signature)
    pub fn pause_normal(ctx: Context<PauseNormal>) -> Result<()> {
        instructions::pause_normal::handler(ctx)
    }

    /// Pause a private subscription vault (ZK ownership proof)
    pub fn pause_private(ctx: Context<PausePrivate>, proof: Groth16Proof) -> Result<()> {
        instructions::pause_private::handler(ctx, proof)
    }

    /// Resume a normal subscription vault (subscriber wallet signature)
    pub fn resume_normal(ctx: Context<ResumeNormal>) -> Result<()> {
        instructions::resume_normal::handler(ctx)
    }

    /// Resume a private subscription vault (ZK ownership proof)
    pub fn resume_private(ctx: Context<ResumePrivate>, proof: Groth16Proof) -> Result<()> {
        instructions::resume_private::handler(ctx, proof)
    }

    /// Cancel a normal subscription vault, refund remaining to subscriber
    pub fn cancel_normal(ctx: Context<CancelNormal>) -> Result<()> {
        instructions::cancel_normal::handler(ctx)
    }

    /// Cancel a private subscription vault, re-shield remaining into pool
    pub fn cancel_private(
        ctx: Context<CancelPrivate>,
        ownership_proof: Groth16Proof,
        new_commitments: Vec<[u8; 32]>,
        new_roots: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::cancel_private::handler(ctx, ownership_proof, new_commitments, new_roots)
    }

    /// Initialize subscriber ownership VK data account (admin only)
    pub fn init_subscriber_vk_data(
        ctx: Context<InitSubscriberVkData>,
        vk_size: u32,
    ) -> Result<()> {
        instructions::store_subscriber_vk_data::handler_init_subscriber(ctx, vk_size)
    }

    /// Write chunk of subscriber ownership VK data (admin only)
    pub fn write_subscriber_vk_data(
        ctx: Context<WriteSubscriberVkData>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::store_subscriber_vk_data::handler_write_subscriber(ctx, offset, data)
    }
}

/// Groth16 proof structure for on-chain verification
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Groth16Proof {
    pub pi_a: [u8; 64],  // G1 point (compressed)
    pub pi_b: [u8; 128], // G2 point (compressed)
    pub pi_c: [u8; 64],  // G1 point (compressed)
}
