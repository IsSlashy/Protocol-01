pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";
include "circomlib/circuits/bitify.circom";

// Merkle tree path verification
// Verifies that a leaf exists at a specific position in the tree
// Outputs computedRoot for conditional checking by caller
template MerkleTreeChecker(depth) {
    signal input leaf;
    signal input pathIndices[depth];  // 0 = left, 1 = right
    signal input pathElements[depth];

    signal output computedRoot;

    component hashers[depth];
    component mux[depth];

    signal computedPath[depth + 1];
    computedPath[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // Ensure pathIndices[i] is binary
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // Select left and right inputs based on path index
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== computedPath[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== computedPath[i];
        mux[i].s <== pathIndices[i];

        // Hash the pair
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        computedPath[i + 1] <== hashers[i].out;
    }

    // Output computed root for conditional checking by caller
    computedRoot <== computedPath[depth];
}

