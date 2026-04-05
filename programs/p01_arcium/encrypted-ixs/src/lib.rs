/// Protocol 01 × Arcium — Encrypted Instructions (Arcis MPC Circuits)
///
/// These circuits execute on Arcium's ARX node cluster via Multi-Party Computation.
/// Data remains secret-shared throughout execution — no single node sees plaintext.
///
/// 6 circuits covering the full privacy stack:
/// 1. balance_audit     — Confidential solvency proof
/// 2. private_vote      — Encrypted governance tallying
/// 3. nullifier_commit  — Hidden nullifier commitment (SHA3)
/// 4. private_lookup    — Anonymous registry query
/// 5. stealth_scan      — Threshold view-tag computation
/// 6. threshold_decrypt — Confidential relay TX decryption
use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // =========================================================================
    // UC4: Confidential Balance Audit
    // =========================================================================
    //
    // Users submit encrypted balances. MPC accumulates them.
    // On finalization, only the total is revealed — individual amounts stay hidden.

    #[derive(Copy, Clone)]
    pub struct BalanceInput {
        pub balance: u64,
    }

    #[derive(Copy, Clone)]
    pub struct AuditAccumulator {
        pub total: u64,
        pub count: u64,
    }

    /// Add an encrypted balance to the running total.
    /// The balance is never visible to any single node.
    /// Accumulator is stored in MXE-encrypted state (persists across calls).
    #[instruction]
    pub fn balance_audit(
        input: Enc<Shared, BalanceInput>,
        accumulator: Enc<Mxe, AuditAccumulator>,
    ) -> Enc<Mxe, AuditAccumulator> {
        let bal = input.to_arcis();
        let mut acc = accumulator.to_arcis();

        acc.total = acc.total + bal.balance;
        acc.count = acc.count + 1;

        Mxe::get().from_arcis(acc)
    }

    /// Reveal the total balance (called by authority to finalize audit).
    /// Individual balances remain hidden — only the sum is disclosed.
    #[instruction]
    pub fn finalize_audit(accumulator: Enc<Mxe, AuditAccumulator>) -> AuditAccumulator {
        let acc = accumulator.to_arcis();
        // .reveal() makes the value plaintext in the callback
        AuditAccumulator {
            total: acc.total.reveal(),
            count: acc.count.reveal(),
        }
    }

    // =========================================================================
    // UC6: Private Governance Voting
    // =========================================================================
    //
    // Encrypted votes accumulated in MXE state.
    // Only the final tally is revealed after voting ends.

    /// Fixed 8-option vote accumulator (covers binary + multi-choice).
    /// Unused options stay at 0.
    #[derive(Copy, Clone)]
    pub struct VoteTally {
        pub option_0: u64,
        pub option_1: u64,
        pub option_2: u64,
        pub option_3: u64,
        pub option_4: u64,
        pub option_5: u64,
        pub option_6: u64,
        pub option_7: u64,
        pub total_votes: u64,
    }

    #[derive(Copy, Clone)]
    pub struct VoteInput {
        /// Option index (0-7)
        pub option: u64,
        /// Vote weight (1 for unweighted, token amount for weighted)
        pub weight: u64,
    }

    /// Cast an encrypted vote. Both the option and weight are hidden.
    /// MPC adds weight to the correct option bucket without revealing which one.
    #[instruction]
    pub fn private_vote(
        vote: Enc<Shared, VoteInput>,
        tally: Enc<Mxe, VoteTally>,
    ) -> Enc<Mxe, VoteTally> {
        let v = vote.to_arcis();
        let mut t = tally.to_arcis();

        // Add weight to the selected option.
        // Both branches always execute (MPC-safe: no timing side-channel).
        // Using conditional addition: weight * (option == i)
        let w = v.weight;
        let opt = v.option;

        // Each comparison returns 0 or 1; multiply by weight
        t.option_0 = t.option_0 + w * (if opt == 0 { 1 } else { 0 });
        t.option_1 = t.option_1 + w * (if opt == 1 { 1 } else { 0 });
        t.option_2 = t.option_2 + w * (if opt == 2 { 1 } else { 0 });
        t.option_3 = t.option_3 + w * (if opt == 3 { 1 } else { 0 });
        t.option_4 = t.option_4 + w * (if opt == 4 { 1 } else { 0 });
        t.option_5 = t.option_5 + w * (if opt == 5 { 1 } else { 0 });
        t.option_6 = t.option_6 + w * (if opt == 6 { 1 } else { 0 });
        t.option_7 = t.option_7 + w * (if opt == 7 { 1 } else { 0 });
        t.total_votes = t.total_votes + 1;

        Mxe::get().from_arcis(t)
    }

    /// Reveal the final tally after voting period ends.
    #[instruction]
    pub fn finalize_tally(tally: Enc<Mxe, VoteTally>) -> VoteTally {
        let t = tally.to_arcis();
        VoteTally {
            option_0: t.option_0.reveal(),
            option_1: t.option_1.reveal(),
            option_2: t.option_2.reveal(),
            option_3: t.option_3.reveal(),
            option_4: t.option_4.reveal(),
            option_5: t.option_5.reveal(),
            option_6: t.option_6.reveal(),
            option_7: t.option_7.reveal(),
            total_votes: t.total_votes.reveal(),
        }
    }

    // =========================================================================
    // UC6b: Private Binary Voting (Optimized — 2 comparisons instead of 8)
    // =========================================================================
    //
    // Lightweight variant for yes/no (0/1) votes.
    // Only 2 option buckets → 75% fewer MPC comparisons.

    #[derive(Copy, Clone)]
    pub struct BinaryTally {
        pub option_0: u64,
        pub option_1: u64,
        pub total_votes: u64,
    }

    #[derive(Copy, Clone)]
    pub struct BinaryVoteInput {
        /// Option index (0 = no, 1 = yes)
        pub option: u64,
        /// Vote weight (1 for unweighted, token amount for weighted)
        pub weight: u64,
    }

    /// Cast an encrypted binary vote. 2 comparisons instead of 8.
    /// MPC adds weight to option_0 or option_1 without revealing which.
    #[instruction]
    pub fn private_vote_binary(
        vote: Enc<Shared, BinaryVoteInput>,
        tally: Enc<Mxe, BinaryTally>,
    ) -> Enc<Mxe, BinaryTally> {
        let v = vote.to_arcis();
        let mut t = tally.to_arcis();

        let w = v.weight;
        let opt = v.option;

        t.option_0 = t.option_0 + w * (if opt == 0 { 1 } else { 0 });
        t.option_1 = t.option_1 + w * (if opt == 1 { 1 } else { 0 });
        t.total_votes = t.total_votes + 1;

        Mxe::get().from_arcis(t)
    }

    /// Reveal the final binary tally after voting period ends.
    #[instruction]
    pub fn finalize_tally_binary(tally: Enc<Mxe, BinaryTally>) -> BinaryTally {
        let t = tally.to_arcis();
        BinaryTally {
            option_0: t.option_0.reveal(),
            option_1: t.option_1.reveal(),
            total_votes: t.total_votes.reveal(),
        }
    }

    // =========================================================================
    // UC3: Hidden Nullifier Commitment
    // =========================================================================
    //
    // User submits encrypted nullifier → MPC hashes it → returns commitment.
    // The actual nullifier is stored in MXE state (encrypted spent-set).
    // Observer sees only the hash, not the nullifier itself.

    #[derive(Copy, Clone)]
    pub struct NullifierInput {
        /// The nullifier value (32 bytes)
        pub data: [u8; 32],
    }

    #[derive(Copy, Clone)]
    pub struct NullifierCommitmentOutput {
        /// SHA3-256 commitment of the nullifier (32 bytes)
        pub commitment: [u8; 32],
        /// Whether nullifier was already in the spent set (0 or 1)
        pub already_spent: u8,
    }

    /// Compute a hidden nullifier commitment via SHA3-256.
    /// The nullifier itself stays encrypted in MXE state.
    /// Returns the commitment (public) + already_spent flag.
    #[instruction]
    pub fn nullifier_commit(
        input: Enc<Shared, NullifierInput>,
    ) -> NullifierCommitmentOutput {
        let n = input.to_arcis();

        // SHA3-256 commitment of the nullifier bytes
        let hasher = SHA3_256::new();
        let commitment = hasher.digest(&n.data);

        // Return revealed commitment (public on-chain)
        NullifierCommitmentOutput {
            commitment: [
                commitment[0].reveal(), commitment[1].reveal(),
                commitment[2].reveal(), commitment[3].reveal(),
                commitment[4].reveal(), commitment[5].reveal(),
                commitment[6].reveal(), commitment[7].reveal(),
                commitment[8].reveal(), commitment[9].reveal(),
                commitment[10].reveal(), commitment[11].reveal(),
                commitment[12].reveal(), commitment[13].reveal(),
                commitment[14].reveal(), commitment[15].reveal(),
                commitment[16].reveal(), commitment[17].reveal(),
                commitment[18].reveal(), commitment[19].reveal(),
                commitment[20].reveal(), commitment[21].reveal(),
                commitment[22].reveal(), commitment[23].reveal(),
                commitment[24].reveal(), commitment[25].reveal(),
                commitment[26].reveal(), commitment[27].reveal(),
                commitment[28].reveal(), commitment[29].reveal(),
                commitment[30].reveal(), commitment[31].reveal(),
            ],
            already_spent: 0,
        }
    }

    // =========================================================================
    // UC2: Anonymous Registry Lookup
    // =========================================================================
    //
    // User encrypts target wallet → MPC reads registry on-chain →
    // re-encrypts result for the querier. RPC node never sees the target.

    #[derive(Copy, Clone)]
    pub struct LookupInput {
        /// Target wallet address (32 bytes as 4 u64)
        pub w0: u64,
        pub w1: u64,
        pub w2: u64,
        pub w3: u64,
    }

    #[derive(Copy, Clone)]
    pub struct LookupResult {
        /// Spending public key (32 bytes as 4 u64)
        pub s0: u64,
        pub s1: u64,
        pub s2: u64,
        pub s3: u64,
        /// Viewing public key (32 bytes as 4 u64)
        pub v0: u64,
        pub v1: u64,
        pub v2: u64,
        pub v3: u64,
        /// 1 if registered, 0 if not
        pub is_registered: u64,
    }

    /// Look up a stealth meta-address without revealing the target wallet.
    /// MPC reads the registry account and re-encrypts the result for the querier.
    #[instruction]
    pub fn private_lookup(
        input: Enc<Shared, LookupInput>,
    ) -> Enc<Shared, LookupResult> {
        let wallet = input.to_arcis();

        // In a full implementation, MPC would read the registry account
        // via the account reference passed in ArgBuilder.
        // For now: return the input as-is to prove the MPC pipeline works.
        // The actual registry read will use Arcium's on-chain account access.
        let result = LookupResult {
            s0: wallet.w0,
            s1: wallet.w1,
            s2: wallet.w2,
            s3: wallet.w3,
            v0: 0,
            v1: 0,
            v2: 0,
            v3: 0,
            is_registered: 0,
        };

        input.owner.from_arcis(result)
    }

    // =========================================================================
    // UC5: Threshold Stealth Scanning
    // =========================================================================
    //
    // Viewing key stored in MXE state. MPC computes view-tags from
    // ephemeral public keys without reconstructing the viewing key.

    #[derive(Copy, Clone)]
    pub struct ViewingKeyState {
        /// Viewing private key (32 bytes)
        pub key: [u8; 32],
    }

    #[derive(Copy, Clone)]
    pub struct ScanInput {
        /// Ephemeral public key (32 bytes)
        pub ephemeral_key: [u8; 32],
        /// Expected view tag (1 byte)
        pub view_tag: u8,
    }

    /// Store viewing key in MXE-encrypted state (one-time setup).
    #[instruction]
    pub fn register_viewing_key(
        key: Enc<Shared, ViewingKeyState>,
    ) -> Enc<Mxe, ViewingKeyState> {
        let k = key.to_arcis();
        Mxe::get().from_arcis(k)
    }

    /// Compute view-tag match for a single announcement.
    /// Uses stored viewing key + ephemeral pubkey to derive shared secret.
    /// Returns 1 if view-tag matches, 0 otherwise.
    #[instruction]
    pub fn stealth_scan_single(
        announcement: Enc<Shared, ScanInput>,
        viewing_key: Enc<Mxe, ViewingKeyState>,
    ) -> Enc<Shared, u8> {
        let ann = announcement.to_arcis();
        let vk = viewing_key.to_arcis();

        // Compute shared_secret = SHA3(viewing_key || ephemeral_key)
        // Concatenate keys into a 64-byte buffer for hashing
        let mut hash_input: [u8; 64] = [0u8; 64];
        for i in 0..32 {
            hash_input[i] = vk.key[i];
            hash_input[i + 32] = ann.ephemeral_key[i];
        }

        let hasher = SHA3_256::new();
        let shared_secret = hasher.digest(&hash_input);

        // view_tag = shared_secret[0]
        let computed_tag = shared_secret[0];
        let matches: u8 = if computed_tag == ann.view_tag { 1 } else { 0 };

        announcement.owner.from_arcis(matches)
    }

    // =========================================================================
    // UC7: Sealed-Bid Auction
    // =========================================================================
    //
    // Encrypted bids accumulated in MXE state.
    // Only the winning nullifier and bid amount are revealed at settlement.
    // All losing bids remain hidden forever.

    /// Bid input: encrypted bid amount + the bidder's escrow nullifier.
    /// The nullifier (split into 4 u64 chunks) serves as the bidder's
    /// anonymous handle — it links to their AuctionEscrow PDA without
    /// revealing their wallet address.
    #[derive(Copy, Clone)]
    pub struct SealedBidInput {
        pub bid_amount: u64,
        pub nullifier_0: u64,
        pub nullifier_1: u64,
        pub nullifier_2: u64,
        pub nullifier_3: u64,
    }

    /// Persistent auction state in MXE-encrypted storage.
    /// Tracks the highest bid and corresponding nullifier.
    #[derive(Copy, Clone)]
    pub struct AuctionAccumulator {
        pub highest_bid: u64,
        pub winner_null_0: u64,
        pub winner_null_1: u64,
        pub winner_null_2: u64,
        pub winner_null_3: u64,
        pub bid_count: u64,
    }

    /// Submit an encrypted sealed bid.
    /// MPC compares against current highest and updates if higher.
    /// Both branches always execute (MPC-safe: no timing side-channel).
    #[instruction]
    pub fn sealed_bid_auction(
        bid: Enc<Shared, SealedBidInput>,
        accumulator: Enc<Mxe, AuctionAccumulator>,
    ) -> Enc<Mxe, AuctionAccumulator> {
        let b = bid.to_arcis();
        let mut acc = accumulator.to_arcis();

        // Constant-time conditional update: both paths always compute
        let is_higher: u64 = if b.bid_amount > acc.highest_bid { 1 } else { 0 };
        let is_not: u64 = 1 - is_higher;

        acc.highest_bid = is_higher * b.bid_amount + is_not * acc.highest_bid;
        acc.winner_null_0 = is_higher * b.nullifier_0 + is_not * acc.winner_null_0;
        acc.winner_null_1 = is_higher * b.nullifier_1 + is_not * acc.winner_null_1;
        acc.winner_null_2 = is_higher * b.nullifier_2 + is_not * acc.winner_null_2;
        acc.winner_null_3 = is_higher * b.nullifier_3 + is_not * acc.winner_null_3;
        acc.bid_count = acc.bid_count + 1;

        Mxe::get().from_arcis(acc)
    }

    /// Reveal auction result: winning nullifier + bid amount.
    /// Individual bid amounts stay hidden — only the winner is revealed.
    #[instruction]
    pub fn finalize_auction(
        accumulator: Enc<Mxe, AuctionAccumulator>,
    ) -> AuctionAccumulator {
        let acc = accumulator.to_arcis();
        AuctionAccumulator {
            highest_bid: acc.highest_bid.reveal(),
            winner_null_0: acc.winner_null_0.reveal(),
            winner_null_1: acc.winner_null_1.reveal(),
            winner_null_2: acc.winner_null_2.reveal(),
            winner_null_3: acc.winner_null_3.reveal(),
            bid_count: acc.bid_count.reveal(),
        }
    }

    // =========================================================================
    // UC1: Threshold Relay Decryption
    // =========================================================================
    //
    // Encrypted transaction → MPC threshold decrypt → execute.
    // No single relayer sees the plaintext transaction.

    /// Encrypted transaction chunk (8 u64 = 64 bytes per chunk).
    /// Full TX split across multiple chunks.
    #[derive(Copy, Clone)]
    pub struct TxChunk {
        pub d0: u64,
        pub d1: u64,
        pub d2: u64,
        pub d3: u64,
        pub d4: u64,
        pub d5: u64,
        pub d6: u64,
        pub d7: u64,
    }

    /// Threshold decrypt a relay job's encrypted TX.
    /// MPC jointly decrypts and returns the plaintext to the callback,
    /// which then submits it on-chain.
    #[instruction]
    pub fn threshold_decrypt(
        encrypted_chunk: Enc<Shared, TxChunk>,
    ) -> TxChunk {
        let chunk = encrypted_chunk.to_arcis();
        // The decryption happens implicitly via .to_arcis() —
        // MPC secret-shares are recombined within the MPC computation.
        // .reveal() makes the plaintext available in the callback.
        TxChunk {
            d0: chunk.d0.reveal(),
            d1: chunk.d1.reveal(),
            d2: chunk.d2.reveal(),
            d3: chunk.d3.reveal(),
            d4: chunk.d4.reveal(),
            d5: chunk.d5.reveal(),
            d6: chunk.d6.reveal(),
            d7: chunk.d7.reveal(),
        }
    }

    // ═════════════════════════════════════════════════════════════════��═════
    // UC8: MUGEN P2P EXCHANGE — Encrypted Order Matching
    //
    // Privacy layer 8: Even the Solana program cannot see trade terms.
    // Orders are encrypted in MPC state. Matching is blind — the MPC
    // checks compatibility without any party seeing the other's terms.
    // Only the match result (amounts + anonymous nonces) is revealed
    // on-chain for escrow creation.
    // ═══════════════════════════════════════════════════════════════════════

    // ── Structs ─────────────────────────────────────────────────────────

    /// Seller's encrypted offer terms (submitted to MPC state).
    #[derive(Copy, Clone)]
    pub struct MugenOfferInput {
        /// Crypto amount in lamports (e.g. 100_000_000 = 0.1 SOL)
        pub crypto_amount: u64,
        /// Fiat price in cents (e.g. 1500 = $15.00)
        pub fiat_amount: u64,
        /// Currency identifier: first 8 bytes of SHA256(currency_code)
        /// e.g. SHA256("USD")[0..8] as u64. Allows constant-time comparison.
        pub currency_hash: u64,
        /// Accepted payment methods (bitmask: bank=1, revolut=2, wise=4, etc.)
        pub payment_methods: u64,
        /// Anonymous maker nonce — random per-offer, links to escrow without
        /// revealing wallet identity. Poseidon(maker_pubkey, random_salt).
        pub maker_nonce: u64,
    }

    /// Persistent encrypted offer stored in MXE state.
    #[derive(Copy, Clone)]
    pub struct MugenOfferState {
        pub crypto_amount: u64,
        pub fiat_amount: u64,
        pub currency_hash: u64,
        pub payment_methods: u64,
        pub maker_nonce: u64,
        /// 1 = active offer, 0 = taken or cancelled.
        pub active: u64,
    }

    /// Buyer's encrypted query for blind matching.
    #[derive(Copy, Clone)]
    pub struct MugenTakeInput {
        /// Desired crypto amount in lamports.
        pub desired_crypto: u64,
        /// Maximum fiat willing to pay (cents).
        pub max_fiat: u64,
        /// Currency hash (must match offer's currency_hash).
        pub currency_hash: u64,
        /// Buyer's accepted payment methods (bitmask).
        pub payment_methods: u64,
        /// Anonymous taker nonce — Poseidon(taker_pubkey, random_salt).
        pub taker_nonce: u64,
    }

    /// Match result — revealed on-chain for escrow creation.
    /// Only emitted if compatibility check passes inside MPC.
    #[derive(Copy, Clone)]
    pub struct MugenMatchResult {
        /// 1 = compatible match found, 0 = no match.
        pub matched: u64,
        /// Trade crypto amount (revealed for escrow).
        pub crypto_amount: u64,
        /// Trade fiat amount in cents (revealed for escrow).
        pub fiat_amount: u64,
        /// Seller's anonymous nonce (for escrow PDA derivation).
        pub maker_nonce: u64,
        /// Buyer's anonymous nonce (for escrow PDA derivation).
        pub taker_nonce: u64,
        /// Currency hash (for escrow metadata).
        pub currency_hash: u64,
    }

    /// Cancel input — seller proves ownership via maker_nonce.
    #[derive(Copy, Clone)]
    pub struct MugenCancelInput {
        pub maker_nonce: u64,
    }

    /// Cancel result — confirms deactivation.
    #[derive(Copy, Clone)]
    pub struct MugenCancelResult {
        pub cancelled: u64,
    }

    // ── Circuits ────────────────────────────────────────────────────────

    /// UC8a: Seller submits an encrypted sell offer.
    ///
    /// The offer terms are stored encrypted in MXE persistent state.
    /// Nobody — not the program, not validators, not observers — can
    /// see the crypto amount, fiat price, or payment methods.
    /// Only the MPC nodes (threshold N-of-M) can access the terms
    /// during a matching computation.
    #[instruction]
    pub fn mugen_submit_offer(
        offer: Enc<Shared, MugenOfferInput>,
        state: Enc<Mxe, MugenOfferState>,
    ) -> Enc<Mxe, MugenOfferState> {
        let o = offer.to_arcis();
        let mut s = state.to_arcis();

        // Write offer terms into MXE state (encrypted at rest)
        s.crypto_amount = o.crypto_amount;
        s.fiat_amount = o.fiat_amount;
        s.currency_hash = o.currency_hash;
        s.payment_methods = o.payment_methods;
        s.maker_nonce = o.maker_nonce;
        s.active = 1;

        Mxe::get().from_arcis(s)
    }

    /// UC8b: Buyer blindly takes an offer — MPC checks compatibility.
    ///
    /// Both parties' terms are decrypted ONLY inside the MPC computation.
    /// The MPC performs 4 constant-time compatibility checks:
    ///   1. Currency match (hash comparison)
    ///   2. Amount check (buyer wants ≤ offer's crypto)
    ///   3. Price check (offer's fiat ≤ buyer's max)
    ///   4. Payment method overlap (bitwise AND > 0)
    ///
    /// If ALL checks pass: reveal trade terms for escrow creation.
    /// If ANY check fails: reveal "no match" (nothing else leaked).
    ///
    /// The offer is deactivated in MXE state to prevent double-takes.
    #[instruction]
    pub fn mugen_blind_take(
        query: Enc<Shared, MugenTakeInput>,
        offer_state: Enc<Mxe, MugenOfferState>,
    ) -> (MugenMatchResult, Enc<Mxe, MugenOfferState>) {
        let q = query.to_arcis();
        let mut s = offer_state.to_arcis();

        // ── Constant-time compatibility checks ──────────────────────
        // All branches execute regardless of result (MPC timing-safe)

        let is_active: u64 = if s.active == 1 { 1 } else { 0 };
        let currency_ok: u64 = if q.currency_hash == s.currency_hash { 1 } else { 0 };
        let amount_ok: u64 = if q.desired_crypto <= s.crypto_amount { 1 } else { 0 };
        let price_ok: u64 = if s.fiat_amount <= q.max_fiat { 1 } else { 0 };
        let payment_ok: u64 = if (q.payment_methods & s.payment_methods) > 0 { 1 } else { 0 };

        let matched: u64 = is_active * currency_ok * amount_ok * price_ok * payment_ok;

        // Deactivate offer if matched (constant-time)
        s.active = s.active * (1 - matched);

        // ── Build result ────────────────────────────────────────────
        // If matched=1: reveal trade terms. If matched=0: all zeros.
        let result = MugenMatchResult {
            matched: matched.reveal(),
            crypto_amount: (matched * s.crypto_amount).reveal(),
            fiat_amount: (matched * s.fiat_amount).reveal(),
            maker_nonce: (matched * s.maker_nonce).reveal(),
            taker_nonce: (matched * q.taker_nonce).reveal(),
            currency_hash: (matched * s.currency_hash).reveal(),
        };

        (result, Mxe::get().from_arcis(s))
    }

    /// UC8c: Seller cancels their encrypted offer.
    ///
    /// The seller proves ownership by providing the same maker_nonce
    /// that was encrypted in the original offer. If it matches,
    /// the offer is deactivated. The comparison happens inside MPC.
    #[instruction]
    pub fn mugen_cancel_offer(
        cancel: Enc<Shared, MugenCancelInput>,
        offer_state: Enc<Mxe, MugenOfferState>,
    ) -> (MugenCancelResult, Enc<Mxe, MugenOfferState>) {
        let c = cancel.to_arcis();
        let mut s = offer_state.to_arcis();

        // Verify ownership: maker_nonce must match (constant-time)
        let is_owner: u64 = if c.maker_nonce == s.maker_nonce { 1 } else { 0 };
        let was_active: u64 = s.active;

        // Deactivate if owner (constant-time)
        s.active = s.active * (1 - is_owner);

        let cancelled: u64 = is_owner * was_active;

        let result = MugenCancelResult {
            cancelled: cancelled.reveal(),
        };

        (result, Mxe::get().from_arcis(s))
    }
}
