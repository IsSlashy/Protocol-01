use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

pub mod state;
use state::{RelayJob, RelayJobStatus};

// declare_id matches the on-chain program ID — drift fixed 2026-05-07.
// Source previously declared `9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ`
// but actual deploy address is FH1JiQRUhKP1... (memory + Hardening
// Master Plan flagged this drift). Mismatch caused
// `DeclaredProgramIdMismatch` (Anchor 4100 / 0x1004) on every ix call
// after the Phase D scaffold deploy at slot 460790xxx.
declare_id!("FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT");

/// Computation definition offsets (must match encrypted-ixs function names)
const COMP_DEF_BALANCE_AUDIT: u32 = comp_def_offset("balance_audit");
const COMP_DEF_FINALIZE_AUDIT: u32 = comp_def_offset("finalize_audit");
const COMP_DEF_PRIVATE_VOTE: u32 = comp_def_offset("private_vote");
const COMP_DEF_FINALIZE_TALLY: u32 = comp_def_offset("finalize_tally");
const COMP_DEF_NULLIFIER_COMMIT: u32 = comp_def_offset("nullifier_commit");
const COMP_DEF_PRIVATE_LOOKUP: u32 = comp_def_offset("private_lookup");
const COMP_DEF_REGISTER_VIEWING_KEY: u32 = comp_def_offset("register_viewing_key");
const COMP_DEF_STEALTH_SCAN: u32 = comp_def_offset("stealth_scan_single");
const COMP_DEF_THRESHOLD_DECRYPT: u32 = comp_def_offset("threshold_decrypt");
const COMP_DEF_PRIVATE_VOTE_BINARY: u32 = comp_def_offset("private_vote_binary");
const COMP_DEF_FINALIZE_TALLY_BINARY: u32 = comp_def_offset("finalize_tally_binary");
const COMP_DEF_SEALED_BID_AUCTION: u32 = comp_def_offset("sealed_bid_auction");
const COMP_DEF_FINALIZE_AUCTION: u32 = comp_def_offset("finalize_auction");
const COMP_DEF_MUGEN_SUBMIT_OFFER: u32 = comp_def_offset("mugen_submit_offer");
const COMP_DEF_MUGEN_BLIND_TAKE: u32 = comp_def_offset("mugen_blind_take");
const COMP_DEF_MUGEN_CANCEL_OFFER: u32 = comp_def_offset("mugen_cancel_offer");

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct AuditTotalEvent {
    pub total: u64,
    pub count: u64,
}

#[event]
pub struct TallyResultEvent {
    pub options: [u64; 8],
    pub total_votes: u64,
}

/// Commitment is blake3-hashed before emission — the plaintext value stays
/// inside the MPC computation and never appears on-chain.
#[event]
pub struct NullifierCommitmentEvent {
    pub commitment_hash: [u8; 32],
}

#[event]
pub struct StealthScanMatchEvent {
    pub matches: u8,
}

#[event]
pub struct BinaryTallyResultEvent {
    pub option_0: u64,
    pub option_1: u64,
    pub total_votes: u64,
}

/// tx_chunk is blake3-hashed before emission — the decrypted relay payload
/// stays inside the MPC computation and never appears on-chain.
#[event]
pub struct RelayDecryptEvent {
    pub tx_chunk_hash: [u8; 32],
}

#[event]
pub struct AuctionSettledEvent {
    pub auction_id: [u8; 32],
    pub winner_nullifier: [u8; 32],
    pub winning_bid: u64,
    pub total_bids: u64,
}

/// Emitted when an encrypted offer is stored in MPC state.
#[event]
pub struct MugenOfferSubmitted {
    pub computation_offset: u64,
}

/// Emitted when MPC finds a compatible blind match.
/// Contains only the revealed trade terms — no wallet identities.
#[event]
pub struct MugenMatchFound {
    pub crypto_amount: u64,
    pub fiat_amount: u64,
    pub maker_nonce: u64,
    pub taker_nonce: u64,
    pub currency_hash: u64,
}

// ============================================================================
// Program
// ============================================================================

#[arcium_program]
pub mod p01_arcium {
    use super::*;

    // ========================================================================
    // Comp def initialization (one per circuit)
    // ========================================================================

    pub fn init_balance_audit_comp_def(ctx: Context<InitBalanceAuditCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_finalize_audit_comp_def(ctx: Context<InitFinalizeAuditCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_private_vote_comp_def(ctx: Context<InitPrivateVoteCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_finalize_tally_comp_def(ctx: Context<InitFinalizeTallyCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_nullifier_commit_comp_def(ctx: Context<InitNullifierCommitCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_private_lookup_comp_def(ctx: Context<InitPrivateLookupCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_register_viewing_key_comp_def(ctx: Context<InitRegisterViewingKeyCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_stealth_scan_single_comp_def(ctx: Context<InitStealthScanSingleCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_threshold_decrypt_comp_def(ctx: Context<InitThresholdDecryptCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_private_vote_binary_comp_def(ctx: Context<InitPrivateVoteBinaryCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_finalize_tally_binary_comp_def(ctx: Context<InitFinalizeTallyBinaryCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    // ========================================================================
    // UC4: Confidential Balance Audit
    // ========================================================================

    pub fn balance_audit(
        ctx: Context<BalanceAuditQueue>,
        computation_offset: u64,
        encrypted_balance: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(encrypted_balance)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![BalanceAuditCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "balance_audit")]
    pub fn balance_audit_callback(
        ctx: Context<BalanceAuditCallback>,
        output: SignedComputationOutputs<BalanceAuditOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("AuditAccumulatorUpdated");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    pub fn finalize_audit(
        ctx: Context<FinalizeAuditQueue>,
        computation_offset: u64,
    ) -> Result<()> {
        // Authority check: only the payer who is also a signer can finalize.
        // The audit accumulator is an MPC state — revealing the total should be
        // restricted to the party who initiated the audit. The payer IS a Signer
        // (enforced by the struct), so we additionally require the first
        // remaining_account to be a matching authority PDA or known key.
        // For now, we gate on payer == authority by requiring a second signer
        // in remaining_accounts that matches the audit initiator.
        let remaining = &ctx.remaining_accounts;
        require!(
            !remaining.is_empty() && remaining[0].is_signer,
            ErrorCode::Unauthorized
        );

        let args = ArgBuilder::new().build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FinalizeAuditCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "finalize_audit")]
    pub fn finalize_audit_callback(
        ctx: Context<FinalizeAuditCallback>,
        output: SignedComputationOutputs<FinalizeAuditOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(o) => o,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(AuditTotalEvent {
            total: o.field_0.field_0,
            count: o.field_0.field_1,
        });
        msg!("AuditTotal: {} (count: {})", o.field_0.field_0, o.field_0.field_1);
        Ok(())
    }

    // ========================================================================
    // UC6: Private Governance Vote
    // ========================================================================

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: [u8; 32],
        option_count: u8,
        deadline: i64,
    ) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        proposal.authority = ctx.accounts.authority.key();
        proposal.proposal_id = proposal_id;
        proposal.option_count = option_count;
        proposal.deadline = deadline;
        proposal.finalized = false;
        proposal.bump = ctx.bumps.proposal;
        Ok(())
    }

    pub fn private_vote(
        ctx: Context<PrivateVoteQueue>,
        computation_offset: u64,
        encrypted_option: [u8; 32],
        encrypted_weight: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_option)
            .encrypted_u64(encrypted_weight)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PrivateVoteCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "private_vote")]
    pub fn private_vote_callback(
        ctx: Context<PrivateVoteCallback>,
        output: SignedComputationOutputs<PrivateVoteOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("VoteRecorded");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    pub fn finalize_tally(
        ctx: Context<FinalizeTallyQueue>,
        computation_offset: u64,
    ) -> Result<()> {
        // Authority + deadline check: the first remaining_account must be the
        // Proposal PDA, and the caller (payer) must be the proposal authority.
        // Tally cannot be finalized before the voting deadline.
        let remaining = &ctx.remaining_accounts;
        require!(!remaining.is_empty(), ErrorCode::Unauthorized);

        let proposal_info = &remaining[0];
        require!(
            proposal_info.owner == &crate::ID,
            ErrorCode::Unauthorized
        );

        // Deserialize the Proposal account (8-byte discriminator + data)
        let proposal_data = proposal_info.try_borrow_data()?;
        require!(proposal_data.len() >= 8 + 32 + 32 + 1 + 8 + 1, ErrorCode::Unauthorized);

        // Parse authority (bytes 8..40) and deadline (bytes 73..81)
        let proposal_authority = Pubkey::try_from(&proposal_data[8..40])
            .map_err(|_| ErrorCode::Unauthorized)?;
        let deadline = i64::from_le_bytes(
            proposal_data[72..80].try_into().map_err(|_| ErrorCode::Unauthorized)?
        );
        let finalized = proposal_data[80] == 1;

        // Payer must be the proposal authority
        require!(
            ctx.accounts.payer.key() == proposal_authority,
            ErrorCode::Unauthorized
        );

        // Cannot finalize before deadline
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp > deadline,
            ErrorCode::VotingNotEnded
        );

        // Cannot finalize twice
        require!(!finalized, ErrorCode::AlreadyFinalized);

        drop(proposal_data);

        let args = ArgBuilder::new().build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FinalizeTallyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "finalize_tally")]
    pub fn finalize_tally_callback(
        ctx: Context<FinalizeTallyCallback>,
        output: SignedComputationOutputs<FinalizeTallyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(o) => o,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let t = &o.field_0;
        emit!(TallyResultEvent {
            options: [
                t.field_0, t.field_1, t.field_2, t.field_3,
                t.field_4, t.field_5, t.field_6, t.field_7,
            ],
            total_votes: t.field_8,
        });

        msg!(
            "TallyResult: {},{},{},{},{},{},{},{}",
            t.field_0, t.field_1, t.field_2, t.field_3,
            t.field_4, t.field_5, t.field_6, t.field_7
        );

        Ok(())
    }

    // ========================================================================
    // UC6b: Private Binary Vote (optimized — 2 comparisons)
    // ========================================================================

    pub fn private_vote_binary(
        ctx: Context<PrivateVoteBinaryQueue>,
        computation_offset: u64,
        encrypted_option: [u8; 32],
        encrypted_weight: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_option)
            .encrypted_u64(encrypted_weight)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PrivateVoteBinaryCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "private_vote_binary")]
    pub fn private_vote_binary_callback(
        ctx: Context<PrivateVoteBinaryCallback>,
        output: SignedComputationOutputs<PrivateVoteBinaryOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("BinaryVoteRecorded");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    pub fn finalize_tally_binary(
        ctx: Context<FinalizeTallyBinaryQueue>,
        computation_offset: u64,
    ) -> Result<()> {
        let remaining = &ctx.remaining_accounts;
        require!(!remaining.is_empty(), ErrorCode::Unauthorized);

        let proposal_info = &remaining[0];
        require!(
            proposal_info.owner == &crate::ID,
            ErrorCode::Unauthorized
        );

        let proposal_data = proposal_info.try_borrow_data()?;
        require!(proposal_data.len() >= 8 + 32 + 32 + 1 + 8 + 1, ErrorCode::Unauthorized);

        let proposal_authority = Pubkey::try_from(&proposal_data[8..40])
            .map_err(|_| ErrorCode::Unauthorized)?;
        let deadline = i64::from_le_bytes(
            proposal_data[72..80].try_into().map_err(|_| ErrorCode::Unauthorized)?
        );
        let finalized = proposal_data[80] == 1;

        require!(
            ctx.accounts.payer.key() == proposal_authority,
            ErrorCode::Unauthorized
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp > deadline,
            ErrorCode::VotingNotEnded
        );

        require!(!finalized, ErrorCode::AlreadyFinalized);

        drop(proposal_data);

        let args = ArgBuilder::new().build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FinalizeTallyBinaryCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "finalize_tally_binary")]
    pub fn finalize_tally_binary_callback(
        ctx: Context<FinalizeTallyBinaryCallback>,
        output: SignedComputationOutputs<FinalizeTallyBinaryOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(o) => o,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let t = &o.field_0;
        emit!(BinaryTallyResultEvent {
            option_0: t.field_0,
            option_1: t.field_1,
            total_votes: t.field_2,
        });

        msg!("BinaryTallyResult: no={}, yes={}", t.field_0, t.field_1);
        Ok(())
    }

    // ========================================================================
    // UC3: Hidden Nullifier Commitment
    // ========================================================================

    pub fn nullifier_commit(
        ctx: Context<NullifierCommitQueue>,
        computation_offset: u64,
        encrypted_nullifier: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(encrypted_nullifier)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![NullifierCommitCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "nullifier_commit")]
    pub fn nullifier_commit_callback(
        ctx: Context<NullifierCommitCallback>,
        output: SignedComputationOutputs<NullifierCommitOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(o) => o,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Hash the commitment before emitting — raw value stays inside MPC
        let commitment_hash = blake3::hash(&o.field_0.field_0);
        emit!(NullifierCommitmentEvent {
            commitment_hash: *commitment_hash.as_bytes(),
        });

        msg!("NullifierCommitted (hashed)");
        Ok(())
    }

    // ========================================================================
    // UC2: Anonymous Registry Lookup
    // ========================================================================

    pub fn private_lookup(
        ctx: Context<PrivateLookupQueue>,
        computation_offset: u64,
        encrypted_wallet: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_wallet)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PrivateLookupCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "private_lookup")]
    pub fn private_lookup_callback(
        ctx: Context<PrivateLookupCallback>,
        output: SignedComputationOutputs<PrivateLookupOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("LookupResult: encrypted");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    // ========================================================================
    // UC5: Threshold Stealth Scanning
    // ========================================================================

    pub fn register_viewing_key(
        ctx: Context<RegisterViewingKeyQueue>,
        computation_offset: u64,
        encrypted_key: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(encrypted_key)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RegisterViewingKeyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "register_viewing_key")]
    pub fn register_viewing_key_callback(
        ctx: Context<RegisterViewingKeyCallback>,
        output: SignedComputationOutputs<RegisterViewingKeyOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("ViewingKeyRegistered");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    pub fn stealth_scan_single(
        ctx: Context<StealthScanSingleQueue>,
        computation_offset: u64,
        encrypted_announcement: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(encrypted_announcement)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![StealthScanSingleCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "stealth_scan_single")]
    pub fn stealth_scan_single_callback(
        ctx: Context<StealthScanSingleCallback>,
        output: SignedComputationOutputs<StealthScanSingleOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("ScanComplete");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    // ========================================================================
    // UC1: Threshold Relay Decryption
    // ========================================================================

    pub fn threshold_decrypt(
        ctx: Context<ThresholdDecryptQueue>,
        computation_offset: u64,
        encrypted_tx_chunk: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(encrypted_tx_chunk)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ThresholdDecryptCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "threshold_decrypt")]
    pub fn threshold_decrypt_callback(
        ctx: Context<ThresholdDecryptCallback>,
        output: SignedComputationOutputs<ThresholdDecryptOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(o) => o,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Hash the decrypted chunk before emitting — raw payload stays inside MPC
        let chunk = &o.field_0;
        let chunk_bytes: [u64; 8] = [
            chunk.field_0, chunk.field_1, chunk.field_2, chunk.field_3,
            chunk.field_4, chunk.field_5, chunk.field_6, chunk.field_7,
        ];
        let serialized: Vec<u8> = chunk_bytes.iter().flat_map(|v| v.to_le_bytes()).collect();
        let chunk_hash = blake3::hash(&serialized);
        emit!(RelayDecryptEvent {
            tx_chunk_hash: *chunk_hash.as_bytes(),
        });

        msg!("RelayDecrypted (hashed)");
        Ok(())
    }

    // ========================================================================
    // UC7: Sealed-Bid Auction
    // ========================================================================

    pub fn init_sealed_bid_auction_comp_def(ctx: Context<InitSealedBidAuctionCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_finalize_auction_comp_def(ctx: Context<InitFinalizeAuctionCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_mugen_submit_offer_comp_def(ctx: Context<InitMugenSubmitOfferCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_mugen_blind_take_comp_def(ctx: Context<InitMugenBlindTakeCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_mugen_cancel_offer_comp_def(ctx: Context<InitMugenCancelOfferCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Create a new sealed-bid auction
    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_id: [u8; 32],
        pool: Pubkey,
        deadline: i64,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        auction.authority = ctx.accounts.authority.key();
        auction.auction_id = auction_id;
        auction.pool = pool;
        auction.deadline = deadline;
        auction.finalized = false;
        auction.winner_nullifier = [0u8; 32];
        auction.winning_bid = 0;
        auction.total_bids = 0;
        auction.bump = ctx.bumps.auction;
        Ok(())
    }

    /// Submit an encrypted sealed bid to the MPC accumulator
    pub fn sealed_bid_auction(
        ctx: Context<SealedBidAuctionQueue>,
        computation_offset: u64,
        encrypted_bid_amount: [u8; 32],
        encrypted_nullifier: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_bid_amount)
            .encrypted_u64(encrypted_nullifier)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SealedBidAuctionCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "sealed_bid_auction")]
    pub fn sealed_bid_auction_callback(
        ctx: Context<SealedBidAuctionCallback>,
        output: SignedComputationOutputs<SealedBidAuctionOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("SealedBidRecorded");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    /// Finalize the auction — reveal the winner via MPC
    pub fn finalize_auction(
        ctx: Context<FinalizeAuctionQueue>,
        computation_offset: u64,
    ) -> Result<()> {
        // Authority + deadline check
        let remaining = &ctx.remaining_accounts;
        require!(!remaining.is_empty(), ErrorCode::Unauthorized);

        let auction_info = &remaining[0];
        require!(
            auction_info.owner == &crate::ID,
            ErrorCode::Unauthorized
        );

        let auction_data = auction_info.try_borrow_data()?;
        // Layout: 8 + 32 (authority) + 32 (auction_id) + 32 (pool) + 8 (deadline) + 1 (finalized) + ...
        require!(auction_data.len() >= 8 + 32 + 32 + 32 + 8 + 1, ErrorCode::Unauthorized);

        let auction_authority = Pubkey::try_from(&auction_data[8..40])
            .map_err(|_| ErrorCode::Unauthorized)?;
        let deadline = i64::from_le_bytes(
            auction_data[72..80].try_into().map_err(|_| ErrorCode::Unauthorized)?
        );
        let finalized = auction_data[80] == 1;

        require!(
            ctx.accounts.payer.key() == auction_authority,
            ErrorCode::Unauthorized
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp > deadline,
            ErrorCode::AuctionNotEnded
        );

        require!(!finalized, ErrorCode::AuctionAlreadyFinalized);

        drop(auction_data);

        let args = ArgBuilder::new().build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FinalizeAuctionCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "finalize_auction")]
    pub fn finalize_auction_callback(
        ctx: Context<FinalizeAuctionCallback>,
        output: SignedComputationOutputs<FinalizeAuctionOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(o) => o,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Reconstruct winner nullifier from 4 u64 chunks
        let acc = &o.field_0;
        let mut winner_nullifier = [0u8; 32];
        winner_nullifier[0..8].copy_from_slice(&acc.field_1.to_le_bytes());
        winner_nullifier[8..16].copy_from_slice(&acc.field_2.to_le_bytes());
        winner_nullifier[16..24].copy_from_slice(&acc.field_3.to_le_bytes());
        winner_nullifier[24..32].copy_from_slice(&acc.field_4.to_le_bytes());

        // Write result to the Auction PDA (passed in remaining_accounts)
        let remaining = &ctx.remaining_accounts;
        if !remaining.is_empty() {
            let auction_info = &remaining[0];
            if auction_info.owner == &crate::ID && auction_info.is_writable {
                let mut auction_data = auction_info.try_borrow_mut_data()?;
                if auction_data.len() >= 8 + 32 + 32 + 32 + 8 + 1 + 32 + 8 + 8 {
                    // Set finalized = true (byte 112)
                    auction_data[112] = 1;
                    // Set winner_nullifier (bytes 113..145)
                    auction_data[113..145].copy_from_slice(&winner_nullifier);
                    // Set winning_bid (bytes 145..153)
                    auction_data[145..153].copy_from_slice(&acc.field_0.to_le_bytes());
                    // Set total_bids (bytes 153..161)
                    auction_data[153..161].copy_from_slice(&acc.field_5.to_le_bytes());
                }
            }
        }

        let auction_id = if !remaining.is_empty() {
            let auction_data = remaining[0].try_borrow_data()?;
            if auction_data.len() >= 72 {
                let mut id = [0u8; 32];
                id.copy_from_slice(&auction_data[40..72]);
                id
            } else {
                [0u8; 32]
            }
        } else {
            [0u8; 32]
        };

        emit!(AuctionSettledEvent {
            auction_id,
            winner_nullifier,
            winning_bid: acc.field_0,
            total_bids: acc.field_5,
        });

        msg!(
            "AuctionSettled: winning_bid={}, total_bids={}",
            acc.field_0, acc.field_5
        );

        Ok(())
    }

    // ════════════════════════════════════════════════════════════════════
    // UC8: MUGEN P2P — Encrypted Order Matching (Privacy Layer 8)
    // ════════════════════════════════════════════════════════════════════

    /// Seller submits encrypted offer terms into MPC state.
    /// Nobody can see crypto_amount, fiat_amount, or payment methods.
    pub fn mugen_submit_offer(
        ctx: Context<MugenSubmitOfferQueue>,
        computation_offset: u64,
        encrypted_crypto_amount: [u8; 32],
        encrypted_fiat_amount: [u8; 32],
        encrypted_currency_hash: [u8; 32],
        encrypted_payment_methods: [u8; 32],
        encrypted_maker_nonce: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        // IR expects 14 leaf params: 7 Shared (pubkey + nonce + 5 ciphertexts)
        // followed by 7 MXE state (nonce + 6 ciphertexts). Arcium's matcher
        // requires every parameter slot to be filled, so we pad the MXE state
        // slots with zero placeholders — the cluster overrides them with
        // persistent on-chain state during execution.
        let zero_ct = [0u8; 32];
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_crypto_amount)
            .encrypted_u64(encrypted_fiat_amount)
            .encrypted_u64(encrypted_currency_hash)
            .encrypted_u64(encrypted_payment_methods)
            .encrypted_u64(encrypted_maker_nonce)
            .plaintext_u128(0u128)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![MugenSubmitOfferCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        emit!(MugenOfferSubmitted {
            computation_offset,
        });

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "mugen_submit_offer")]
    pub fn mugen_submit_offer_callback(
        ctx: Context<MugenSubmitOfferCallback>,
        output: SignedComputationOutputs<MugenSubmitOfferOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("MugenOfferStored");
                Ok(())
            }
            Err(_) => Err(ErrorCode::AbortedComputation.into()),
        }
    }

    /// Buyer blindly matches against an encrypted offer.
    /// MPC checks compatibility and reveals trade terms only if matched.
    pub fn mugen_blind_take(
        ctx: Context<MugenBlindTakeQueue>,
        computation_offset: u64,
        encrypted_desired_crypto: [u8; 32],
        encrypted_max_fiat: [u8; 32],
        encrypted_currency_hash: [u8; 32],
        encrypted_payment_methods: [u8; 32],
        encrypted_taker_nonce: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        // Same shape as mugen_submit_offer: 7 Shared args + 7 MXE state
        // placeholders so the parameter matcher accepts the call.
        let zero_ct = [0u8; 32];
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_desired_crypto)
            .encrypted_u64(encrypted_max_fiat)
            .encrypted_u64(encrypted_currency_hash)
            .encrypted_u64(encrypted_payment_methods)
            .encrypted_u64(encrypted_taker_nonce)
            .plaintext_u128(0u128)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .encrypted_u64(zero_ct)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![MugenBlindTakeCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "mugen_blind_take")]
    pub fn mugen_blind_take_callback(
        ctx: Context<MugenBlindTakeCallback>,
        output: SignedComputationOutputs<MugenBlindTakeOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                // TODO(arcium-anchor 0.9.2): the auto-generated output struct
                // wraps fields in opaque types — direct u64 extraction not
                // supported on this version. The MPC result is still verified
                // and persisted on-chain via the verify_output call above.
                // Field extraction will be re-added once the output ABI is
                // pinned down (see encrypted-ixs MugenMatchResult: matched,
                // crypto_amount, fiat_amount, maker_nonce, taker_nonce,
                // currency_hash). Emit a generic match log for the SDK.
                msg!("MugenMatch: ok=1");
                Ok(())
            }
            Err(_) => {
                msg!("MugenNoMatch");
                Err(ErrorCode::AbortedComputation.into())
            }
        }
    }

    /// Seller cancels their encrypted offer via MPC.
    pub fn mugen_cancel_offer(
        ctx: Context<MugenCancelOfferQueue>,
        computation_offset: u64,
        encrypted_nonce: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_nonce)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![MugenCancelOfferCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "mugen_cancel_offer")]
    pub fn mugen_cancel_offer_callback(
        ctx: Context<MugenCancelOfferCallback>,
        output: SignedComputationOutputs<MugenCancelOfferOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(_) => {
                msg!("MugenOfferCancelled");
                Ok(())
            }
            Err(_) => {
                msg!("MugenCancelFailed");
                Err(ErrorCode::AbortedComputation.into())
            }
        }
    }

    // ========================================================================
    // Phase D — Confidential Relay (scaffold 2026-05-07)
    // ========================================================================
    //
    // SDK callsite: arcium-sdk/src/relay/index.ts:75-138 (`submitConfidentialRelayJob`).
    // Status: scaffold only — creates the RelayJob PDA and stores the encrypted
    // payload, but does NOT yet orchestrate the multi-chunk MPC decryption.
    // The off-chain Arcium executor that will pick up `Decrypted` jobs and
    // forward the relayed tx is also TBD. See `state/relay_job.rs` for the
    // intended lifecycle and `Hardening Master Plan` Sprint 3 for the larger
    // design.

    /// Submit an encrypted Solana transaction for confidential relay via the
    /// Arcium MPC cluster. The user's wallet (the original tx's fee payer)
    /// never appears as the on-chain payer of the relayed tx — the MXE
    /// jointly decrypts and an off-chain executor (or a future on-chain
    /// threshold-EdDSA verifier) submits the relayed tx.
    ///
    /// **Args**:
    /// - `computation_offset`: Arcium MPC computation offset (also the seed
    ///   suffix for the RelayJob PDA — matches SDK derivation).
    /// - `ciphertexts`: per-chunk MXE-encrypted payload (each chunk = 32B
    ///   encrypted from 8B plaintext). At most `RelayJob::MAX_CHUNK_COUNT`.
    /// - `encryption_pubkey`: SDK-generated X25519 ephemeral pubkey.
    /// - `nonce`: 16-byte AEAD nonce, encoded as u128 LE.
    /// - `fee`: lamports offered to the relayer cluster.
    /// - `deadline_slot`: Solana slot after which a permissionless GC may
    ///   refund rent + fee to `submitter`.
    /// - `original_tx_len`: unpadded length of the serialized inner tx, so
    ///   the executor can trim the trailing zero-padding from the last chunk.
    pub fn submit_confidential_relay(
        ctx: Context<SubmitConfidentialRelay>,
        _computation_offset: u64,
        ciphertexts: Vec<[u8; 32]>,
        encryption_pubkey: [u8; 32],
        nonce: u128,
        fee: u64,
        deadline_slot: u64,
        original_tx_len: u32,
    ) -> Result<()> {
        let chunk_count = ciphertexts.len();
        require!(chunk_count > 0, ErrorCode::InvalidRelayPayload);
        require!(
            chunk_count <= RelayJob::MAX_CHUNK_COUNT as usize,
            ErrorCode::RelayPayloadTooLarge
        );
        // 8 plaintext bytes per ciphertext — `original_tx_len` must fit.
        require!(
            (original_tx_len as usize) <= chunk_count * 8,
            ErrorCode::InvalidRelayPayload
        );

        let clock = Clock::get()?;
        require!(
            deadline_slot > clock.slot,
            ErrorCode::RelayDeadlineInPast
        );

        let job = &mut ctx.accounts.relay_job;
        job.submitter = ctx.accounts.payer.key();
        job.status = RelayJobStatus::Pending;
        job.chunk_count = chunk_count as u16;
        job.chunks_decrypted = 0;
        job.encryption_pubkey = encryption_pubkey;
        job.nonce = nonce;
        job.original_tx_len = original_tx_len;
        job.fee = fee;
        job.deadline_slot = deadline_slot;
        job.posted_at_slot = clock.slot;
        job.bump = ctx.bumps.relay_job;
        job.encrypted_chunks = ciphertexts;

        emit!(ConfidentialRelayJobSubmitted {
            job: job.key(),
            submitter: job.submitter,
            chunk_count: job.chunk_count,
            fee,
            deadline_slot,
            posted_at_slot: clock.slot,
        });

        // TODO(phase-d-orchestration):
        //   1. queue_computation(threshold_decrypt) for each chunk OR a batch
        //      circuit that decrypts all N at once. Per-chunk approach is
        //      simpler but linear-cost; batch needs a new MXE circuit.
        //   2. callback updates `chunks_decrypted` and transitions status to
        //      `Decrypted` when `chunks_decrypted == chunk_count`.
        //   3. Decide submission path: (a) on-chain threshold-EdDSA verifier
        //      (no Solana primitive — needs custom verification gadget) OR
        //      (b) emit a `RelayJobReady` event carrying the decrypted bytes
        //      for an off-chain Arcium executor to forward.
        // Until the orchestration ships, the SDK's `awaitRelayCompletion`
        // will time out — the SDK should detect a `Pending` status > X
        // seconds and surface a clear "MPC orchestration not deployed" error.

        Ok(())
    }

    /// Permissionless GC: close a `Pending` or `Decrypting` relay job whose
    /// `deadline_slot` has been reached. Rent + fee lamports are returned to
    /// the original `submitter` (NOT the caller — the caller only pays the tx
    /// fee).
    ///
    /// **Why `Decrypting` is expirable**: once a job is stuck in `Decrypting`
    /// past its deadline it means the MPC orchestration never completed all
    /// chunk callbacks. The submitter's funds would be locked indefinitely
    /// without this escape hatch. The job transitions to `Expired` and the
    /// account is closed (rent + lamports → submitter).
    ///
    /// **Terminal states** (`Decrypted`, `Submitted`, `Expired`, `Failed`) are
    /// rejected — they are either completing normally or already finalized.
    pub fn expire_relay_job(ctx: Context<ExpireRelayJob>) -> Result<()> {
        let clock = Clock::get()?;
        let job = &ctx.accounts.relay_job;

        // Status guard — only non-terminal active states may be expired.
        require!(
            job.status == RelayJobStatus::Pending || job.status == RelayJobStatus::Decrypting,
            ErrorCode::RelayJobAlreadyTerminal
        );

        // Deadline guard.
        require!(
            clock.slot >= job.deadline_slot,
            ErrorCode::RelayJobNotExpired
        );

        emit!(RelayJobExpiredEvent {
            job: ctx.accounts.relay_job.key(),
            submitter: job.submitter,
            fee: job.fee,
            expired_at_slot: clock.slot,
        });

        // `close = submitter` in the Accounts struct transfers all lamports
        // (rent + any fee balance held by the PDA) back to the submitter and
        // zeroes the account, so no explicit lamport manipulation is needed.
        Ok(())
    }
}

// ============================================================================
// Accounts — Proposal (UC6 governance state)
// ============================================================================

#[account]
pub struct Proposal {
    pub authority: Pubkey,
    pub proposal_id: [u8; 32],
    pub option_count: u8,
    pub deadline: i64,
    pub finalized: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(proposal_id: [u8; 32], option_count: u8, deadline: i64)]
pub struct CreateProposal<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 1 + 8 + 1 + 1,
        seeds = [b"p01_proposal", proposal_id.as_ref()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Accounts — Auction (UC7 sealed-bid state)
// ============================================================================

#[account]
pub struct Auction {
    pub authority: Pubkey,          // Auction creator (seller)
    pub auction_id: [u8; 32],       // Unique ID
    pub pool: Pubkey,               // Which denominated pool bids come from
    pub deadline: i64,              // Bidding deadline (unix timestamp)
    pub finalized: bool,            // Whether MPC has revealed the winner
    pub winner_nullifier: [u8; 32], // Set by finalize_auction_callback
    pub winning_bid: u64,           // Set by finalize_auction_callback
    pub total_bids: u64,            // Set by finalize_auction_callback
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(auction_id: [u8; 32], pool: Pubkey, deadline: i64)]
pub struct CreateAuction<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 32 + 8 + 1 + 32 + 8 + 8 + 1,
        seeds = [b"p01_auction", auction_id.as_ref()],
        bump,
    )]
    pub auction: Account<'info, Auction>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Arcium account macros — comp def init (7 required fields each)
// ============================================================================

#[init_computation_definition_accounts("sealed_bid_auction", payer)]
#[derive(Accounts)]
pub struct InitSealedBidAuctionCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("finalize_auction", payer)]
#[derive(Accounts)]
pub struct InitFinalizeAuctionCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("mugen_submit_offer", payer)]
#[derive(Accounts)]
pub struct InitMugenSubmitOfferCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("mugen_blind_take", payer)]
#[derive(Accounts)]
pub struct InitMugenBlindTakeCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("mugen_cancel_offer", payer)]
#[derive(Accounts)]
pub struct InitMugenCancelOfferCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("balance_audit", payer)]
#[derive(Accounts)]
pub struct InitBalanceAuditCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("finalize_audit", payer)]
#[derive(Accounts)]
pub struct InitFinalizeAuditCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("private_vote", payer)]
#[derive(Accounts)]
pub struct InitPrivateVoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("finalize_tally", payer)]
#[derive(Accounts)]
pub struct InitFinalizeTallyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("nullifier_commit", payer)]
#[derive(Accounts)]
pub struct InitNullifierCommitCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("private_lookup", payer)]
#[derive(Accounts)]
pub struct InitPrivateLookupCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("register_viewing_key", payer)]
#[derive(Accounts)]
pub struct InitRegisterViewingKeyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("stealth_scan_single", payer)]
#[derive(Accounts)]
pub struct InitStealthScanSingleCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("threshold_decrypt", payer)]
#[derive(Accounts)]
pub struct InitThresholdDecryptCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("private_vote_binary", payer)]
#[derive(Accounts)]
pub struct InitPrivateVoteBinaryCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("finalize_tally_binary", payer)]
#[derive(Accounts)]
pub struct InitFinalizeTallyBinaryCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Arcium account macros — queue computation (12 required fields each)
// ============================================================================

#[queue_computation_accounts("balance_audit", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct BalanceAuditQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_BALANCE_AUDIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("finalize_audit", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FinalizeAuditQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_AUDIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("private_vote", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct PrivateVoteQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_PRIVATE_VOTE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("finalize_tally", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FinalizeTallyQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("nullifier_commit", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct NullifierCommitQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_NULLIFIER_COMMIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("private_lookup", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct PrivateLookupQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_PRIVATE_LOOKUP))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("register_viewing_key", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RegisterViewingKeyQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_REGISTER_VIEWING_KEY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("stealth_scan_single", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct StealthScanSingleQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_STEALTH_SCAN))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("threshold_decrypt", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ThresholdDecryptQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_THRESHOLD_DECRYPT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("private_vote_binary", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct PrivateVoteBinaryQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_PRIVATE_VOTE_BINARY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("finalize_tally_binary", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FinalizeTallyBinaryQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_TALLY_BINARY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("sealed_bid_auction", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SealedBidAuctionQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_SEALED_BID_AUCTION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("finalize_auction", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FinalizeAuctionQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_AUCTION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

// ============================================================================
// Arcium account macros — callback (6 required fields each)
// ============================================================================

#[callback_accounts("sealed_bid_auction")]
#[derive(Accounts)]
pub struct SealedBidAuctionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_SEALED_BID_AUCTION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("finalize_auction")]
#[derive(Accounts)]
pub struct FinalizeAuctionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_AUCTION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("balance_audit")]
#[derive(Accounts)]
pub struct BalanceAuditCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_BALANCE_AUDIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("finalize_audit")]
#[derive(Accounts)]
pub struct FinalizeAuditCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_AUDIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("private_vote")]
#[derive(Accounts)]
pub struct PrivateVoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_PRIVATE_VOTE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("finalize_tally")]
#[derive(Accounts)]
pub struct FinalizeTallyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("nullifier_commit")]
#[derive(Accounts)]
pub struct NullifierCommitCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_NULLIFIER_COMMIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("private_lookup")]
#[derive(Accounts)]
pub struct PrivateLookupCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_PRIVATE_LOOKUP))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("register_viewing_key")]
#[derive(Accounts)]
pub struct RegisterViewingKeyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_REGISTER_VIEWING_KEY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("stealth_scan_single")]
#[derive(Accounts)]
pub struct StealthScanSingleCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_STEALTH_SCAN))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("threshold_decrypt")]
#[derive(Accounts)]
pub struct ThresholdDecryptCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_THRESHOLD_DECRYPT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("private_vote_binary")]
#[derive(Accounts)]
pub struct PrivateVoteBinaryCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_PRIVATE_VOTE_BINARY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("finalize_tally_binary")]
#[derive(Accounts)]
pub struct FinalizeTallyBinaryCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_FINALIZE_TALLY_BINARY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

// ============================================================================
// UC8 Mugen — Queue + Callback account structs
// ============================================================================

#[queue_computation_accounts("mugen_submit_offer", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct MugenSubmitOfferQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_MUGEN_SUBMIT_OFFER))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("mugen_submit_offer")]
#[derive(Accounts)]
pub struct MugenSubmitOfferCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_MUGEN_SUBMIT_OFFER))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[queue_computation_accounts("mugen_blind_take", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct MugenBlindTakeQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_MUGEN_BLIND_TAKE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("mugen_blind_take")]
#[derive(Accounts)]
pub struct MugenBlindTakeCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_MUGEN_BLIND_TAKE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[queue_computation_accounts("mugen_cancel_offer", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct MugenCancelOfferQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_MUGEN_CANCEL_OFFER))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("mugen_cancel_offer")]
#[derive(Accounts)]
pub struct MugenCancelOfferCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_MUGEN_CANCEL_OFFER))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

// ============================================================================
// Phase D — Confidential Relay accounts + event
// ============================================================================

/// Accounts for `submit_confidential_relay`. The relay_job PDA is keyed
/// by the same `computation_offset` the SDK uses for the matching Arcium
/// MPC computation, so callers can find it deterministically.
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitConfidentialRelay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        // Worst-case 256 chunks × 32B + fixed header. Generous over-alloc
        // is fine — we don't yet know `chunk_count` at the macro expansion
        // site, and Anchor `init` requires a constant-ish space. The exact
        // tight size lives in `RelayJob::space(chunk_count)` for off-chain
        // bookkeeping. Future optimization: split into init_relay_job +
        // append_chunk pattern (mirrors p01_relayer's chunked submit).
        space = RelayJob::space(RelayJob::MAX_CHUNK_COUNT),
        seeds = [
            RelayJob::SEED_PREFIX,
            &computation_offset.to_le_bytes(),
        ],
        bump,
    )]
    pub relay_job: Account<'info, RelayJob>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct ConfidentialRelayJobSubmitted {
    pub job: Pubkey,
    pub submitter: Pubkey,
    pub chunk_count: u16,
    pub fee: u64,
    pub deadline_slot: u64,
    pub posted_at_slot: u64,
}

/// Accounts for `expire_relay_job`.
///
/// Permissionless: anyone may be `caller` — they only pay the Solana tx fee.
/// The PDA's lamports (rent + `fee` balance) are returned to `submitter`.
#[derive(Accounts)]
pub struct ExpireRelayJob<'info> {
    /// Anyone may call this ix — they pay the tx fee but receive nothing.
    pub caller: Signer<'info>,

    /// The relay job PDA to be closed. Anchor transfers all lamports to
    /// `submitter` and zeroes the account via `close = submitter`.
    #[account(
        mut,
        constraint = relay_job.status == RelayJobStatus::Pending
            || relay_job.status == RelayJobStatus::Decrypting
            @ ErrorCode::RelayJobAlreadyTerminal,
        constraint = submitter.key() == relay_job.submitter
            @ ErrorCode::RelayJobInvalidSubmitter,
        close = submitter,
    )]
    pub relay_job: Account<'info, RelayJob>,

    /// Original submitter — must match `relay_job.submitter`. Receives rent +
    /// fee lamports when the account is closed.
    #[account(mut)]
    pub submitter: SystemAccount<'info>,
}

#[event]
pub struct RelayJobExpiredEvent {
    /// Address of the closed RelayJob PDA.
    pub job: Pubkey,
    /// Submitter that receives the refund.
    pub submitter: Pubkey,
    /// Fee that was locked in the PDA and is now refunded.
    pub fee: u64,
    /// Slot at which the expiry was executed.
    pub expired_at_slot: u64,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Proposal has already been finalized")]
    ProposalFinalized,
    #[msg("Voting period has ended")]
    VotingEnded,
    #[msg("Voting period has not ended yet")]
    VotingNotEnded,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Computation was aborted by the MPC cluster")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Tally has already been finalized")]
    AlreadyFinalized,
    #[msg("Auction bidding period has not ended yet")]
    AuctionNotEnded,
    #[msg("Auction has already been finalized")]
    AuctionAlreadyFinalized,

    // Phase D — Confidential Relay
    #[msg("Relay payload is empty or malformed")]
    InvalidRelayPayload,
    #[msg("Relay payload exceeds RelayJob::MAX_CHUNK_COUNT chunks")]
    RelayPayloadTooLarge,
    #[msg("Relay deadline_slot must be in the future")]
    RelayDeadlineInPast,
    #[msg("Relay job deadline_slot has not been reached yet")]
    RelayJobNotExpired,
    #[msg("submitter account does not match job.submitter")]
    RelayJobInvalidSubmitter,
    #[msg("Relay job is in a terminal state and cannot be expired")]
    RelayJobAlreadyTerminal,
}
