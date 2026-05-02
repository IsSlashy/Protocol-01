use anchor_lang::prelude::*;

pub mod compliance;
pub mod errors;
pub mod fee;
pub mod instructions;
pub mod state;
pub mod verifier;

use compliance::*;
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

    /// Shield tokens using STARK circuit 6 (merkle_update) — quantum-resistant.
    /// Proves old_root -> new_root given insertion of commitment.
    /// Requires a pre-verified STARK proof buffer from p01_stark_verifier.
    pub fn shield(
        ctx: Context<ShieldStark>,
        commitment: [u8; 32],
        old_root: [u8; 32],
        new_root: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        instructions::shield_stark::handler(ctx, commitment, old_root, new_root, amount)
    }

    /// Transfer shielded tokens privately using STARK circuit 5 (transfer) —
    /// quantum-resistant. Spends two input notes and creates two output
    /// commitments. public_amount = 0 (no net value change).
    /// Requires a pre-verified STARK proof buffer from p01_stark_verifier.
    pub fn transfer(
        ctx: Context<TransferStark>,
        nullifier_1: [u8; 32],
        nullifier_2: [u8; 32],
        output_commitment_1: [u8; 32],
        output_commitment_2: [u8; 32],
        merkle_root: [u8; 32],
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::transfer_stark::handler(
            ctx,
            nullifier_1,
            nullifier_2,
            output_commitment_1,
            output_commitment_2,
            merkle_root,
            new_root,
        )
    }

    /// Unshield tokens from the base pool using STARK circuit 5 (transfer) —
    /// quantum-resistant. public_amount = -amount (two's complement u64)
    /// ensures value conservation between the two output notes and the
    /// withdrawn `amount`.
    /// Requires a pre-verified STARK proof buffer from p01_stark_verifier.
    pub fn unshield(
        ctx: Context<UnshieldStark>,
        nullifier_1: [u8; 32],
        nullifier_2: [u8; 32],
        output_commitment_1: [u8; 32],
        output_commitment_2: [u8; 32],
        merkle_root: [u8; 32],
        amount: u64,
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::unshield_stark::handler(
            ctx,
            nullifier_1,
            nullifier_2,
            output_commitment_1,
            output_commitment_2,
            merkle_root,
            amount,
            new_root,
        )
    }

    // REMOVED (P9 STARK migration):
    //   update_verification_key, init_vk_data, write_vk_data — the base pool
    //   no longer carries a Groth16 VK. STARK circuits are pinned in
    //   p01_stark_verifier; no per-pool VK upload is needed.
    //   transfer_via_relayer — relaying is handled by p01_relayer.

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

    /// Unshield from denominated pool using STARK proof (quantum-resistant).
    /// Requires a pre-verified STARK proof buffer from p01_stark_verifier.
    /// The STARK proof replaces Groth16 — no elliptic curve pairings needed.
    ///
    /// `min_epoch == 0` bypasses the maturity check (emergency-like behavior).
    /// Event shape is identical for both paths so on-chain observers cannot
    /// distinguish emergency withdrawals from mature ones.
    pub fn unshield_denominated_stark(
        ctx: Context<UnshieldDenominatedStark>,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        stark_commitment: u64,
    ) -> Result<()> {
        instructions::unshield_denominated_stark::handler(ctx, nullifier, merkle_root, min_epoch, stark_commitment)
    }

    /// Resize an existing denominated pool to accommodate new fields
    pub fn resize_denominated_pool(ctx: Context<ResizeDenominatedPool>) -> Result<()> {
        instructions::resize_denominated_pool::handler(ctx)
    }

    // -----------------------------------------------------------------------
    // V3 Denominated Pool instructions (Goldilocks Poseidon, end-to-end PQ).
    // v2 instructions stay live for the 30-day deprecation window.
    // -----------------------------------------------------------------------

    /// Initialize a V3 denominated shielded pool (Goldilocks Poseidon tree).
    /// PDA seed: [b"denominated_pool_v3", token_mint, denomination_le_bytes].
    pub fn init_denominated_pool_v3(
        ctx: Context<InitDenominatedPoolV3>,
        vk_hash: [u8; 32],
        token_mint: Pubkey,
        denomination: u64,
        epoch_delay: u64,
    ) -> Result<()> {
        instructions::init_denominated_pool_v3::handler(
            ctx, vk_hash, token_mint, denomination, epoch_delay,
        )
    }

    /// Shield into a V3 pool. Requires a pre-verified C6 (merkle_update)
    /// STARK proof buffer attesting that (old_root → new_root + leaf +
    /// new_subtrees) is a valid insertion.
    pub fn shield_denominated_v3(
        ctx: Context<ShieldDenominatedV3>,
        commitment: [u8; 32],
        new_root: [u8; 32],
        new_subtrees: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::shield_denominated_v3::handler(ctx, commitment, new_root, new_subtrees)
    }

    /// Unshield from a V3 pool using two STARK proof buffers:
    ///   - C1 (pool_commitment): proves nullifier + commitment.
    ///   - C3 (merkle_path): proves the commitment is at the supplied
    ///     merkle root (closes the v2 trust gap where membership was
    ///     never proven on-chain).
    pub fn unshield_denominated_stark_v3(
        ctx: Context<UnshieldDenominatedStarkV3>,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        stark_commitment: u64,
    ) -> Result<()> {
        instructions::unshield_denominated_stark_v3::handler(
            ctx, nullifier, merkle_root, min_epoch, stark_commitment,
        )
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

    /// Create a private subscription vault using STARK proof (quantum-resistant)
    pub fn subscribe_private_stark(
        ctx: Context<SubscribePrivateStark>,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        subscriber_commitment: [u8; 32],
        rate: u64,
        interval_slots: u64,
        vk_hash_subscriber: [u8; 32],
        stark_commitment: u64,
    ) -> Result<()> {
        instructions::subscribe_private_stark::handler(ctx, nullifier, merkle_root, min_epoch, subscriber_commitment, rate, interval_slots, vk_hash_subscriber, stark_commitment)
    }

    /// Pause a private subscription vault using STARK proof (quantum-resistant)
    pub fn pause_private_stark(ctx: Context<PausePrivateStark>) -> Result<()> {
        instructions::pause_private_stark::handler(ctx)
    }

    /// Resume a private subscription vault using STARK proof (quantum-resistant)
    pub fn resume_private_stark(ctx: Context<ResumePrivateStark>) -> Result<()> {
        instructions::resume_private_stark::handler(ctx)
    }

    /// Cancel a private subscription vault using STARK proof (quantum-resistant).
    /// Re-shields remaining funds back into the source denominated pool.
    pub fn cancel_private_stark(
        ctx: Context<CancelPrivateStark>,
        new_commitments: Vec<[u8; 32]>,
        new_roots: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::cancel_private_stark::handler(ctx, new_commitments, new_roots)
    }

    /// Transfer a note within a denominated pool using STARK proof (quantum-resistant).
    /// The old note is nullified and a new commitment is inserted into the tree.
    /// No funds move — same pool, same denomination.
    pub fn transfer_denominated_stark(
        ctx: Context<TransferDenominatedStark>,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        stark_commitment: u64,
        new_commitment: [u8; 32],
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::transfer_denominated_stark::handler(
            ctx,
            nullifier,
            merkle_root,
            min_epoch,
            stark_commitment,
            new_commitment,
            new_root,
        )
    }

    /// Split a note into multiple notes in a lower-denomination pool using STARK
    /// (quantum-resistant). Uses circuit 1 for source ownership; output commitments
    /// are bound by the payer's signature on the instruction data.
    pub fn split_note_stark(
        ctx: Context<SplitNoteStark>,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        stark_commitment: u64,
        num_outputs: u8,
        output_commitments: Vec<[u8; 32]>,
        new_roots: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::split_note_stark::handler(
            ctx,
            nullifier,
            merkle_root,
            min_epoch,
            stark_commitment,
            num_outputs,
            output_commitments,
            new_roots,
        )
    }

    /// Propose a two-step authority transfer (current authority only)
    pub fn propose_authority_transfer(
        ctx: Context<ProposeAuthorityTransfer>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::propose_authority_transfer::handler(ctx, new_authority)
    }

    /// Accept a pending authority transfer (proposed authority only)
    pub fn accept_authority_transfer(ctx: Context<AcceptAuthorityTransfer>) -> Result<()> {
        instructions::accept_authority_transfer::handler(ctx)
    }

    // -----------------------------------------------------------------------
    // Sealed-Bid Auction Escrow instructions
    // -----------------------------------------------------------------------

    /// Lock a denominated pool note into escrow for a sealed-bid auction.
    /// Consumes the old note (nullifier) and stores two conditional commitments:
    /// pay_commitment (seller wins) and refund_commitment (bidder loses).
    pub fn escrow_shield(
        ctx: Context<EscrowShield>,
        proof: Groth16Proof,
        nullifier: [u8; 32],
        merkle_root: [u8; 32],
        min_epoch: u64,
        auction_id: [u8; 32],
        pay_commitment: [u8; 32],
        refund_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::escrow_shield::handler(ctx, proof, nullifier, merkle_root, min_epoch, auction_id, pay_commitment, refund_commitment)
    }

    /// Release an auction escrow after the Arcium MPC settles the auction.
    /// Inserts the correct commitment (pay or refund) into the Merkle tree.
    /// Permissionless: anyone can crank once outcome is set.
    pub fn escrow_release(
        ctx: Context<EscrowRelease>,
        new_root: [u8; 32],
    ) -> Result<()> {
        instructions::escrow_release::handler(ctx, new_root)
    }

    /// Write the auction outcome to an escrow PDA by reading the finalized
    /// Auction account from p01_arcium. Permissionless cranker.
    pub fn write_escrow_outcome(ctx: Context<WriteEscrowOutcome>) -> Result<()> {
        instructions::write_escrow_outcome::handler(ctx)
    }

    /// Update the escrow bid verification key hash on a denominated pool (admin only).
    pub fn update_escrow_vk(ctx: Context<UpdateEscrowVk>, new_vk_hash: [u8; 32]) -> Result<()> {
        instructions::update_escrow_vk::handler(ctx, new_vk_hash)
    }

    /// Initialize escrow VK data account (PDA owned by this program).
    pub fn init_escrow_vk_data(ctx: Context<InitEscrowVkData>, vk_size: u32) -> Result<()> {
        instructions::store_escrow_vk_data::handler_init_escrow_vk(ctx, vk_size)
    }

    /// Write chunk of escrow VK data.
    pub fn write_escrow_vk_data(ctx: Context<WriteEscrowVkData>, offset: u32, data: Vec<u8>) -> Result<()> {
        instructions::store_escrow_vk_data::handler_write_escrow_vk(ctx, offset, data)
    }

    /// Claim accrued periods from a subscription vault (retailer only)
    pub fn claim_period(ctx: Context<ClaimPeriod>) -> Result<()> {
        instructions::claim_period::handler(ctx)
    }

    /// Pause a normal subscription vault (subscriber wallet signature)
    pub fn pause_normal(ctx: Context<PauseNormal>) -> Result<()> {
        instructions::pause_normal::handler(ctx)
    }

    /// Resume a normal subscription vault (subscriber wallet signature)
    pub fn resume_normal(ctx: Context<ResumeNormal>) -> Result<()> {
        instructions::resume_normal::handler(ctx)
    }

    /// Cancel a normal subscription vault, refund remaining to subscriber
    pub fn cancel_normal(ctx: Context<CancelNormal>) -> Result<()> {
        instructions::cancel_normal::handler(ctx)
    }

    // -----------------------------------------------------------------------
    // Compliance instructions (ZK-attested range proofs + sanctions innocence)
    // -----------------------------------------------------------------------

    /// Verify a Groth16 range proof and create a ComplianceAttestation.
    /// Proves: min_bound <= secret_balance <= max_bound
    pub fn verify_compliance_range(
        ctx: Context<VerifyComplianceRange>,
        proof: Groth16Proof,
        min_bound: u64,
        max_bound: u64,
        attestation_nonce: [u8; 32],
        expires_in_seconds: i64,
    ) -> Result<()> {
        compliance::verify_compliance_range(ctx, proof, min_bound, max_bound, attestation_nonce, expires_in_seconds)
    }

    /// Verify a Groth16 innocence proof and create a ComplianceAttestation.
    /// Proves: user identity is NOT in the sanctions Merkle tree.
    pub fn verify_compliance_innocence(
        ctx: Context<VerifyComplianceInnocence>,
        proof: Groth16Proof,
        sanctions_root: [u8; 32],
        user_commitment: [u8; 32],
        attestation_nonce: [u8; 32],
        expires_in_seconds: i64,
    ) -> Result<()> {
        compliance::verify_compliance_innocence(ctx, proof, sanctions_root, user_commitment, attestation_nonce, expires_in_seconds)
    }

    /// Revoke a previously issued compliance attestation (authority only).
    pub fn revoke_attestation(ctx: Context<RevokeAttestation>) -> Result<()> {
        compliance::revoke_attestation(ctx)
    }

    /// Check whether a compliance attestation is currently valid.
    /// Returns Ok(true) if valid, or an error if expired/revoked/unverified.
    pub fn check_compliance(ctx: Context<CheckCompliance>) -> Result<bool> {
        compliance::check_compliance(ctx)
    }
}

/// Groth16 proof structure for on-chain verification
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Groth16Proof {
    pub pi_a: [u8; 64],  // G1 point (compressed)
    pub pi_b: [u8; 128], // G2 point (compressed)
    pub pi_c: [u8; 64],  // G1 point (compressed)
}
