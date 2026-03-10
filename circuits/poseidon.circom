pragma circom 2.1.0;

// Poseidon hash implementation - ZK-friendly hash function
// Based on the Poseidon specification for BN254 curve

include "circomlib/circuits/poseidon.circom";

// Poseidon hash for commitment creation
// Commitment = Poseidon(amount, owner_pubkey, randomness, token_mint)
template NoteCommitment() {
    signal input amount;
    signal input owner_pubkey;
    signal input randomness;
    signal input token_mint;

    signal output commitment;

    component hasher = Poseidon(4);
    hasher.inputs[0] <== amount;
    hasher.inputs[1] <== owner_pubkey;
    hasher.inputs[2] <== randomness;
    hasher.inputs[3] <== token_mint;

    commitment <== hasher.out;
}

// Nullifier computation
// Nullifier = Poseidon(commitment, spending_key_hash)
template NullifierComputation() {
    signal input commitment;
    signal input spending_key_hash;

    signal output nullifier;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== commitment;
    hasher.inputs[1] <== spending_key_hash;

    nullifier <== hasher.out;
}

// Public key derivation from spending key (domain tag = 0)
// owner_pubkey = Poseidon(spending_key, 0)
// Domain-separated from SpendingKeyHash to prevent cross-use
template SpendingKeyDerivation() {
    signal input spending_key;
    signal output owner_pubkey;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== spending_key;
    hasher.inputs[1] <== 0;

    owner_pubkey <== hasher.out;
}

// Spending key hash for nullifier (domain tag = 1)
// spending_key_hash = Poseidon(spending_key, 1)
// Domain-separated from SpendingKeyDerivation to prevent cross-use
template SpendingKeyHash() {
    signal input spending_key;
    signal output spending_key_hash;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== spending_key;
    hasher.inputs[1] <== 1;

    spending_key_hash <== hasher.out;
}
