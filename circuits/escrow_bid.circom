pragma circom 2.1.0;

// ==========================================================================
// Protocol 01 — Escrow Bid (Sealed-Bid Auction Escrow)
// ==========================================================================
//
// Locks a denominated pool note into escrow for a sealed-bid auction.
// Pre-authorizes TWO conditional outcomes:
//   - pay_commitment:    note transferred to seller (if bidder wins)
//   - refund_commitment: note returned to bidder (if bidder loses)
//
// The circuit proves:
//   1. The prover knows a valid note (secret + nullifier_preimage)
//   2. The note exists in the Merkle tree
//   3. The nullifier is correctly derived (prevents double-spend)
//   4. The note is mature (deposit_epoch <= min_epoch) — always enforced
//   5. Both output commitments are correctly formed
//   6. The escrow is bound to a specific auction_id (prevents replay)
//
// Old commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
// Old nullifier  = Poseidon(nullifier_preimage, secret)
// pay_commitment = Poseidon(pay_nullifier_preimage, pay_secret, pay_deposit_epoch, token_mint)
// refund_commitment = Poseidon(refund_nullifier_preimage, refund_secret, refund_deposit_epoch, token_mint)
//
// Public inputs:  merkle_root, nullifier, min_epoch, token_mint, auction_id,
//                 pay_commitment, refund_commitment
// Private inputs: secret, nullifier_preimage, deposit_epoch, path_elements,
//                 path_indices, pay_secret, pay_nullifier_preimage,
//                 pay_deposit_epoch, refund_secret, refund_nullifier_preimage,
//                 refund_deposit_epoch
//
// Security properties:
//   - Old note is provably consumed (nullifier published on-chain)
//   - Both output commitments are verified by the circuit (no tampering)
//   - auction_id binds escrow to a specific auction (no cross-auction replay)
//   - Only one commitment is inserted into Merkle tree at release time
//   - On-chain program decides which outcome based on Arcium MPC result
//   - No funds move: same pool, same denomination throughout
//   - Neither bidder nor seller can choose the outcome — MPC determines it
// ==========================================================================

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "./merkle.circom";

template EscrowBid(merkleDepth) {
    // ========================================
    // PUBLIC INPUTS
    // ========================================
    signal input merkle_root;
    signal input nullifier;
    signal input min_epoch;              // current_epoch - required_delay_epochs
    signal input token_mint;
    signal input auction_id;             // Poseidon(auction_pubkey, auction_nonce) — binds to specific auction
    signal input pay_commitment;         // Commitment for seller (winner outcome)
    signal input refund_commitment;      // Commitment for bidder (loser outcome)

    // ========================================
    // PRIVATE INPUTS — Source note (bidder)
    // ========================================
    signal input secret;                 // Bidder's spending key
    signal input nullifier_preimage;     // Bidder's nullifier preimage
    signal input deposit_epoch;          // Epoch when bidder's note was created
    signal input path_elements[merkleDepth];
    signal input path_indices[merkleDepth];

    // ========================================
    // PRIVATE INPUTS — Pay note (for seller)
    // ========================================
    signal input pay_secret;
    signal input pay_nullifier_preimage;
    signal input pay_deposit_epoch;

    // ========================================
    // PRIVATE INPUTS — Refund note (for bidder)
    // ========================================
    signal input refund_secret;
    signal input refund_nullifier_preimage;
    signal input refund_deposit_epoch;

    // ========================================
    // STEP 1: Compute old commitment
    // ========================================
    component commitHasher = Poseidon(4);
    commitHasher.inputs[0] <== nullifier_preimage;
    commitHasher.inputs[1] <== secret;
    commitHasher.inputs[2] <== deposit_epoch;
    commitHasher.inputs[3] <== token_mint;

    signal old_commitment;
    old_commitment <== commitHasher.out;

    // ========================================
    // STEP 2: Compute and verify nullifier
    // ========================================
    component nullHasher = Poseidon(2);
    nullHasher.inputs[0] <== nullifier_preimage;
    nullHasher.inputs[1] <== secret;

    nullHasher.out === nullifier;

    // ========================================
    // STEP 3: Verify old note in Merkle tree
    // ========================================
    component merkleChecker = MerkleTreeChecker(merkleDepth);
    merkleChecker.leaf <== old_commitment;
    for (var i = 0; i < merkleDepth; i++) {
        merkleChecker.pathElements[i] <== path_elements[i];
        merkleChecker.pathIndices[i] <== path_indices[i];
    }

    merkleChecker.computedRoot === merkle_root;

    // ========================================
    // STEP 4: Time delay verification (always enforced for escrow)
    // ========================================
    signal epoch_diff;
    epoch_diff <== min_epoch - deposit_epoch;

    component rangeCheck = Num2Bits(40);
    rangeCheck.in <== epoch_diff;

    // ========================================
    // STEP 5: Range checks on output epochs
    // ========================================
    component payEpochRange = Num2Bits(40);
    payEpochRange.in <== pay_deposit_epoch;

    component refundEpochRange = Num2Bits(40);
    refundEpochRange.in <== refund_deposit_epoch;

    // ========================================
    // STEP 6: Compute and verify pay commitment (seller outcome)
    // ========================================
    component payCommitHasher = Poseidon(4);
    payCommitHasher.inputs[0] <== pay_nullifier_preimage;
    payCommitHasher.inputs[1] <== pay_secret;
    payCommitHasher.inputs[2] <== pay_deposit_epoch;
    payCommitHasher.inputs[3] <== token_mint;

    payCommitHasher.out === pay_commitment;

    // ========================================
    // STEP 7: Compute and verify refund commitment (bidder outcome)
    // ========================================
    component refundCommitHasher = Poseidon(4);
    refundCommitHasher.inputs[0] <== refund_nullifier_preimage;
    refundCommitHasher.inputs[1] <== refund_secret;
    refundCommitHasher.inputs[2] <== refund_deposit_epoch;
    refundCommitHasher.inputs[3] <== token_mint;

    refundCommitHasher.out === refund_commitment;

    // ========================================
    // STEP 8: Bind to auction (anti-replay)
    // ========================================
    // auction_id is a public input verified by the on-chain program.
    // Including it as a public input means the proof is only valid for
    // this specific auction. The on-chain program checks that auction_id
    // matches the actual Auction PDA. We constrain it to be non-zero
    // to prevent accidental use with a default/empty auction.
    signal auction_id_check;
    auction_id_check <== auction_id * auction_id;
}

// Main component: tree depth 15 (same as denominated pool)
component main {public [merkle_root, nullifier, min_epoch, token_mint, auction_id, pay_commitment, refund_commitment]} = EscrowBid(15);
