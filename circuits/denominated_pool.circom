pragma circom 2.1.0;

// ==========================================================================
// Protocol 01 — Denominated Shielded Pool (Tornado Cash model)
// ==========================================================================
//
// Fixed-denomination pool: all notes have the same value (enforced by the
// Solana program, NOT the circuit). The circuit proves:
//
//   1. The prover knows a valid note (secret + nullifier_preimage)
//   2. The note exists in the Merkle tree
//   3. The nullifier is correctly derived (prevents double-spend)
//   4. The note is old enough (deposit_epoch <= min_epoch)
//
// Commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
//   - No amount in the commitment. Denomination is implicit per pool.
//   - deposit_epoch = floor(slot / EPOCH_SIZE) — rounded to ~1h windows
//   - All deposits in the same epoch share the same deposit_epoch value,
//     preventing fine-grained timing correlation.
//
// Nullifier = Poseidon(nullifier_preimage, secret)
//   - Deterministic: same note always produces the same nullifier
//   - Revealed on-chain during withdrawal to prevent double-spend
//
// Public inputs:  merkle_root, nullifier, min_epoch, token_mint
// Private inputs: secret, nullifier_preimage, deposit_epoch, path_elements, path_indices
//
// Security properties:
//   - Depositing X and withdrawing Y is impossible: program always sends pool.denomination
//   - Double-spend is impossible: nullifier is deterministic and checked on-chain
//   - Timing correlation is mitigated: deposit_epoch rounds to ~1h windows
//   - Note ownership is proven: only the secret holder can compute the nullifier
// ==========================================================================

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "./merkle.circom";

template DenominatedPool(merkleDepth) {
    // ========================================
    // PUBLIC INPUTS
    // ========================================
    signal input merkle_root;
    signal input nullifier;
    signal input min_epoch;     // current_epoch - required_delay_epochs
    signal input token_mint;

    // ========================================
    // PRIVATE INPUTS
    // ========================================
    signal input secret;              // User's spending key
    signal input nullifier_preimage;  // Random value, unique per deposit
    signal input deposit_epoch;       // Epoch when note was created
    signal input path_elements[merkleDepth];
    signal input path_indices[merkleDepth];

    // ========================================
    // STEP 1: Compute commitment
    // ========================================
    // commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
    component commitHasher = Poseidon(4);
    commitHasher.inputs[0] <== nullifier_preimage;
    commitHasher.inputs[1] <== secret;
    commitHasher.inputs[2] <== deposit_epoch;
    commitHasher.inputs[3] <== token_mint;

    signal commitment;
    commitment <== commitHasher.out;

    // ========================================
    // STEP 2: Compute and verify nullifier
    // ========================================
    // nullifier = Poseidon(nullifier_preimage, secret)
    component nullHasher = Poseidon(2);
    nullHasher.inputs[0] <== nullifier_preimage;
    nullHasher.inputs[1] <== secret;

    // Nullifier must match the public input
    nullHasher.out === nullifier;

    // ========================================
    // STEP 3: Verify Merkle tree membership
    // ========================================
    component merkleChecker = MerkleTreeChecker(merkleDepth);
    merkleChecker.leaf <== commitment;
    merkleChecker.root <== merkle_root;
    for (var i = 0; i < merkleDepth; i++) {
        merkleChecker.pathElements[i] <== path_elements[i];
        merkleChecker.pathIndices[i] <== path_indices[i];
    }

    // Computed root must match the public merkle_root
    merkleChecker.computedRoot === merkle_root;

    // ========================================
    // STEP 4: Time delay verification
    // ========================================
    // Prove: deposit_epoch <= min_epoch
    // Equivalently: min_epoch - deposit_epoch >= 0
    // We verify this by decomposing (min_epoch - deposit_epoch) into bits.
    // If the difference is negative (in the field), Num2Bits will fail
    // because the field element would be huge (close to the prime).
    // 40 bits supports epochs up to ~1 trillion (way more than needed).
    signal epoch_diff;
    epoch_diff <== min_epoch - deposit_epoch;

    component rangeCheck = Num2Bits(40);
    rangeCheck.in <== epoch_diff;
}

// Main component: tree depth 15 (~32K notes per pool)
// 32K notes per denomination is sufficient for launch.
// Depth 15 = ~4,273 constraints (22% less than depth 20 = 5,503).
// Faster proving on mobile: ~185ms vs ~237ms (snarkjs JS).
component main {public [merkle_root, nullifier, min_epoch, token_mint]} = DenominatedPool(15);
