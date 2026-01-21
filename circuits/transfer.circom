pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "./merkle.circom";
include "./poseidon.circom";

// Main transfer circuit for Specter Protocol ZK Shielded Pool
// Supports 2-in-2-out transfers (Zcash-style)
//
// Public inputs:
//   - merkle_root: Current Merkle tree root
//   - nullifier_1, nullifier_2: Nullifiers of spent notes
//   - output_commitment_1, output_commitment_2: New note commitments
//   - public_amount: Net public amount (positive for shield, negative for unshield, 0 for private transfer)
//   - token_mint: Token mint address (for multi-token support)
//
// Private inputs:
//   - Input notes (amount, owner_pubkey, randomness, merkle path)
//   - Output notes (amount, recipient, randomness)
//   - Spending key

template Transfer(merkleDepth) {
    // ========================================
    // PUBLIC INPUTS
    // ========================================
    signal input merkle_root;
    signal input nullifier_1;
    signal input nullifier_2;
    signal input output_commitment_1;
    signal input output_commitment_2;
    signal input public_amount;  // Can be negative (represented in field)
    signal input token_mint;

    // ========================================
    // PRIVATE INPUTS - Input Notes
    // ========================================
    // Note 1
    signal input in_amount_1;
    signal input in_owner_pubkey_1;
    signal input in_randomness_1;
    signal input in_path_indices_1[merkleDepth];
    signal input in_path_elements_1[merkleDepth];

    // Note 2 (can be dummy note with amount=0)
    signal input in_amount_2;
    signal input in_owner_pubkey_2;
    signal input in_randomness_2;
    signal input in_path_indices_2[merkleDepth];
    signal input in_path_elements_2[merkleDepth];

    // ========================================
    // PRIVATE INPUTS - Output Notes
    // ========================================
    signal input out_amount_1;
    signal input out_recipient_1;
    signal input out_randomness_1;

    signal input out_amount_2;
    signal input out_recipient_2;
    signal input out_randomness_2;

    // ========================================
    // PRIVATE INPUTS - Spending Key
    // ========================================
    signal input spending_key;

    // ========================================
    // STEP 1: Verify spending key ownership
    // ========================================
    component spendingKeyDerivation = SpendingKeyDerivation();
    spendingKeyDerivation.spending_key <== spending_key;

    // Owner pubkey must match derived pubkey for both input notes
    // (or input note amount is 0 for dummy notes)
    component isZeroAmount1 = IsZero();
    isZeroAmount1.in <== in_amount_1;

    component isZeroAmount2 = IsZero();
    isZeroAmount2.in <== in_amount_2;

    // If amount > 0, owner must match
    (1 - isZeroAmount1.out) * (in_owner_pubkey_1 - spendingKeyDerivation.owner_pubkey) === 0;
    (1 - isZeroAmount2.out) * (in_owner_pubkey_2 - spendingKeyDerivation.owner_pubkey) === 0;

    // ========================================
    // STEP 2: Compute input commitments
    // ========================================
    component inCommitment1 = NoteCommitment();
    inCommitment1.amount <== in_amount_1;
    inCommitment1.owner_pubkey <== in_owner_pubkey_1;
    inCommitment1.randomness <== in_randomness_1;
    inCommitment1.token_mint <== token_mint;

    component inCommitment2 = NoteCommitment();
    inCommitment2.amount <== in_amount_2;
    inCommitment2.owner_pubkey <== in_owner_pubkey_2;
    inCommitment2.randomness <== in_randomness_2;
    inCommitment2.token_mint <== token_mint;

    // ========================================
    // STEP 3: Verify Merkle tree membership
    // ========================================
    component merkleChecker1 = MerkleTreeChecker(merkleDepth);
    merkleChecker1.leaf <== inCommitment1.commitment;
    merkleChecker1.root <== merkle_root;
    for (var i = 0; i < merkleDepth; i++) {
        merkleChecker1.pathIndices[i] <== in_path_indices_1[i];
        merkleChecker1.pathElements[i] <== in_path_elements_1[i];
    }

    component merkleChecker2 = MerkleTreeChecker(merkleDepth);
    merkleChecker2.leaf <== inCommitment2.commitment;
    merkleChecker2.root <== merkle_root;
    for (var i = 0; i < merkleDepth; i++) {
        merkleChecker2.pathIndices[i] <== in_path_indices_2[i];
        merkleChecker2.pathElements[i] <== in_path_elements_2[i];
    }

    // ========================================
    // STEP 4: Compute and verify nullifiers
    // ========================================
    component spendingKeyHash = SpendingKeyHash();
    spendingKeyHash.spending_key <== spending_key;

    component nullifierComp1 = NullifierComputation();
    nullifierComp1.commitment <== inCommitment1.commitment;
    nullifierComp1.spending_key_hash <== spendingKeyHash.spending_key_hash;
    nullifierComp1.nullifier === nullifier_1;

    component nullifierComp2 = NullifierComputation();
    nullifierComp2.commitment <== inCommitment2.commitment;
    nullifierComp2.spending_key_hash <== spendingKeyHash.spending_key_hash;
    nullifierComp2.nullifier === nullifier_2;

    // ========================================
    // STEP 5: Compute output commitments
    // ========================================
    component outCommitment1 = NoteCommitment();
    outCommitment1.amount <== out_amount_1;
    outCommitment1.owner_pubkey <== out_recipient_1;
    outCommitment1.randomness <== out_randomness_1;
    outCommitment1.token_mint <== token_mint;
    outCommitment1.commitment === output_commitment_1;

    component outCommitment2 = NoteCommitment();
    outCommitment2.amount <== out_amount_2;
    outCommitment2.owner_pubkey <== out_recipient_2;
    outCommitment2.randomness <== out_randomness_2;
    outCommitment2.token_mint <== token_mint;
    outCommitment2.commitment === output_commitment_2;

    // ========================================
    // STEP 6: Value conservation
    // ========================================
    // sum(inputs) + public_amount = sum(outputs)
    signal total_in;
    signal total_out;

    total_in <== in_amount_1 + in_amount_2 + public_amount;
    total_out <== out_amount_1 + out_amount_2;

    total_in === total_out;

    // ========================================
    // STEP 7: Range proofs (amounts are non-negative and < 2^64)
    // ========================================
    component rangeCheck1 = Num2Bits(64);
    rangeCheck1.in <== out_amount_1;

    component rangeCheck2 = Num2Bits(64);
    rangeCheck2.in <== out_amount_2;

    component rangeCheck3 = Num2Bits(64);
    rangeCheck3.in <== in_amount_1;

    component rangeCheck4 = Num2Bits(64);
    rangeCheck4.in <== in_amount_2;
}

// Main component with tree depth of 20 (~1M notes)
component main {public [merkle_root, nullifier_1, nullifier_2, output_commitment_1, output_commitment_2, public_amount, token_mint]} = Transfer(20);
