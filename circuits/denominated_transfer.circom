pragma circom 2.1.0;

// ==========================================================================
// Protocol 01 — Denominated Pool Transfer (Peer-to-Peer Note Transfer)
// ==========================================================================
//
// Transfers a note within a denominated pool to a new owner without
// moving funds. The old note is nullified and a new commitment is
// inserted into the Merkle tree in a single atomic transaction.
//
// The circuit proves:
//   1. The prover knows a valid note (secret + nullifier_preimage)
//   2. The note exists in the Merkle tree
//   3. The nullifier is correctly derived (prevents double-spend)
//   4. The note is mature (deposit_epoch <= min_epoch) — always enforced
//   5. The new commitment is correctly formed
//
// Old commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
// Old nullifier  = Poseidon(nullifier_preimage, secret)
// New commitment = Poseidon(new_nullifier_preimage, new_secret, new_deposit_epoch, token_mint)
//
// Public inputs:  merkle_root, nullifier, min_epoch, token_mint, new_commitment
// Private inputs: secret, nullifier_preimage, deposit_epoch, path_elements,
//                 path_indices, new_secret, new_nullifier_preimage, new_deposit_epoch
//
// Security properties:
//   - Old note is provably consumed (nullifier published on-chain)
//   - New note commitment is verified by the circuit (no tampering)
//   - No funds move: same pool, same denomination
//   - Maturity is always enforced for transfers (no emergency bypass)
//   - Recipient can only spend with knowledge of new_secret + new_nullifier_preimage
// ==========================================================================

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "./merkle.circom";

template DenominatedTransfer(merkleDepth) {
    // ========================================
    // PUBLIC INPUTS
    // ========================================
    signal input merkle_root;
    signal input nullifier;
    signal input min_epoch;          // current_epoch - required_delay_epochs
    signal input token_mint;
    signal input new_commitment;     // Commitment for the recipient's new note

    // ========================================
    // PRIVATE INPUTS — Old note (sender)
    // ========================================
    signal input secret;              // Sender's spending key
    signal input nullifier_preimage;  // Sender's nullifier preimage
    signal input deposit_epoch;       // Epoch when sender's note was created
    signal input path_elements[merkleDepth];
    signal input path_indices[merkleDepth];

    // ========================================
    // PRIVATE INPUTS — New note (recipient)
    // ========================================
    signal input new_secret;              // Recipient's spending key
    signal input new_nullifier_preimage;  // Recipient's nullifier preimage
    signal input new_deposit_epoch;       // Epoch for the new note

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
    merkleChecker.root <== merkle_root;
    for (var i = 0; i < merkleDepth; i++) {
        merkleChecker.pathElements[i] <== path_elements[i];
        merkleChecker.pathIndices[i] <== path_indices[i];
    }

    merkleChecker.computedRoot === merkle_root;

    // ========================================
    // STEP 4: Time delay verification (always enforced)
    // ========================================
    signal epoch_diff;
    epoch_diff <== min_epoch - deposit_epoch;

    component rangeCheck = Num2Bits(40);
    rangeCheck.in <== epoch_diff;

    // ========================================
    // STEP 5: Compute and verify new commitment
    // ========================================
    component newCommitHasher = Poseidon(4);
    newCommitHasher.inputs[0] <== new_nullifier_preimage;
    newCommitHasher.inputs[1] <== new_secret;
    newCommitHasher.inputs[2] <== new_deposit_epoch;
    newCommitHasher.inputs[3] <== token_mint;

    // New commitment must match the public input
    newCommitHasher.out === new_commitment;
}

// Main component: tree depth 15 (same as denominated pool)
component main {public [merkle_root, nullifier, min_epoch, token_mint, new_commitment]} = DenominatedTransfer(15);
