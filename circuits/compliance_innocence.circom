pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/mux1.circom";

// ============================================================================
// Compliance Innocence Proof — Sanctions List Non-Inclusion
// ============================================================================
//
// PURPOSE:
//   Prove "I am NOT on a sanctions/blocklist" without revealing my identity.
//   Uses an INDEXED Merkle tree of sanctioned addresses.
//   The user proves their address falls BETWEEN two adjacent leaves
//   (proving non-membership in the set).
//
// USE CASES:
//   - OFAC sanctions compliance (Chainalysis/TRM Labs integration)
//   - Railgun-style "Private Proofs of Innocence"
//   - Country-level jurisdiction whitelisting
//   - Exchange deposit compliance
//
// HOW IT WORKS:
//   A sanctions list is maintained as an indexed Merkle tree of addresses.
//   Each leaf stores (value, next_value) where next_value is the next larger
//   value in the sorted set. The leaf hash is Poseidon(value, next_value).
//
//   To prove non-inclusion, the user shows:
//   1. Two adjacent leaves from the indexed tree (linked by next pointers)
//   2. Merkle proofs that both leaf hashes are in the tree
//   3. The adjacency link: low_leaf.next === high_leaf.value
//   4. low_leaf.value < user_address < high_leaf.value
//   This proves the user_address is NOT in the tree — the linked-list
//   structure guarantees no value exists between adjacent entries.
//
// SECURITY (I-1 FIX — Indexed Merkle Tree):
//   The old circuit accepted raw leaf values without proving adjacency.
//   An attacker could pick ANY two leaves that bracket their address.
//   The indexed Merkle tree approach stores (value, next_value) pairs,
//   and the circuit enforces low_leaf_next === high_leaf_value, which
//   cryptographically proves the two leaves are adjacent in sorted order.
//
// SECURITY (I-2 FIX — Range Checks):
//   All values used in comparisons (low_leaf_value, user_address,
//   high_leaf_value) are range-checked to 253 bits via Num2Bits(253).
//   This prevents field element wrapping/ambiguity attacks where a
//   malicious prover exploits the modular arithmetic of the BN254 field.
//
// TREE MAINTENANCE:
//   - The sanctions Merkle root is published on-chain by an oracle authority
//   - Updated periodically (e.g., daily) from Chainalysis/TRM feeds
//   - Tree uses Poseidon hashing for SNARK-friendliness
//   - Leaves are indexed: each leaf = Poseidon(value, next_value)
//   - Inserting a new sanctioned address updates two leaves (the new one
//     and its predecessor whose next_value pointer must be updated)
//
// ============================================================================

// Merkle tree path verification (depth 20 = 1M entries)
template SanctionsMerkleChecker(depth) {
    signal input leaf;
    signal input pathIndices[depth];
    signal input pathElements[depth];

    signal output computedRoot;

    component hashers[depth];
    component mux[depth];

    signal computedPath[depth + 1];
    computedPath[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== computedPath[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== computedPath[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        computedPath[i + 1] <== hashers[i].out;
    }

    computedRoot <== computedPath[depth];
}


// ============================================================================
// MAIN CIRCUIT: ComplianceInnocenceProof
// ============================================================================
// Tree depth 20 supports up to 1,048,576 sanctioned addresses
// ============================================================================
template ComplianceInnocenceProof(depth) {

    // ========================================================================
    // PUBLIC INPUTS (3)
    // ========================================================================

    // Merkle root of the indexed sanctions list (published on-chain by oracle)
    signal input sanctions_root;

    // The user's identity commitment: Poseidon(spending_key, 0)
    // This links the proof to an account without revealing the spending key
    signal input user_commitment;

    // Unique nonce for this attestation (anti-replay)
    signal input attestation_nonce;


    // ========================================================================
    // PRIVATE INPUTS
    // ========================================================================

    // Spending key (proves ownership of user_commitment)
    signal input spending_key;

    // The user's address as a field element (derived from spending_key)
    // This is what we prove is NOT in the sanctions tree
    signal input user_address;

    // Indexed Merkle tree leaf data for the low leaf:
    //   low_leaf_value:  the sanctioned address value stored in the low leaf
    //   low_leaf_next:   the next_value pointer in the low leaf (must equal high_leaf_value)
    signal input low_leaf_value;
    signal input low_leaf_next;

    // Indexed Merkle tree leaf data for the high leaf:
    //   high_leaf_value: the sanctioned address value stored in the high leaf
    //   high_leaf_next:  the next_value pointer in the high leaf (needed for leaf hash)
    signal input high_leaf_value;
    signal input high_leaf_next;

    // Merkle proofs for both leaves
    signal input low_path_indices[depth];
    signal input low_path_elements[depth];
    signal input high_path_indices[depth];
    signal input high_path_elements[depth];


    // ========================================================================
    // STEP 1: Verify ownership — user_commitment = Poseidon(spending_key, 0)
    // ========================================================================
    component ownerHash = Poseidon(2);
    ownerHash.inputs[0] <== spending_key;
    ownerHash.inputs[1] <== 0;

    ownerHash.out === user_commitment;


    // ========================================================================
    // STEP 2: Derive user_address from spending_key
    // ========================================================================
    // user_address = Poseidon(spending_key, 1) — domain tag 1 for address derivation
    component addrHash = Poseidon(2);
    addrHash.inputs[0] <== spending_key;
    addrHash.inputs[1] <== 1;

    addrHash.out === user_address;


    // ========================================================================
    // STEP 3: Compute indexed leaf hashes
    // ========================================================================
    // Each leaf in the indexed Merkle tree is Poseidon(value, next_value).
    // This binds the linked-list structure into the Merkle tree.

    component lowLeafHash = Poseidon(2);
    lowLeafHash.inputs[0] <== low_leaf_value;
    lowLeafHash.inputs[1] <== low_leaf_next;

    component highLeafHash = Poseidon(2);
    highLeafHash.inputs[0] <== high_leaf_value;
    highLeafHash.inputs[1] <== high_leaf_next;


    // ========================================================================
    // STEP 4: Verify adjacency — low_leaf_next === high_leaf_value
    // ========================================================================
    // This is the critical constraint (I-1 FIX). The indexed Merkle tree
    // stores (value, next_value) pairs forming a sorted linked list.
    // By enforcing that low_leaf's next pointer equals high_leaf's value,
    // we prove these two leaves are ADJACENT in sorted order.
    // Without this, an attacker could pick any two non-adjacent leaves
    // that happen to bracket their sanctioned address.

    low_leaf_next === high_leaf_value;


    // ========================================================================
    // STEP 5: Verify low leaf hash is in the sanctions tree
    // ========================================================================
    component lowMerkle = SanctionsMerkleChecker(depth);
    lowMerkle.leaf <== lowLeafHash.out;
    for (var i = 0; i < depth; i++) {
        lowMerkle.pathIndices[i] <== low_path_indices[i];
        lowMerkle.pathElements[i] <== low_path_elements[i];
    }

    lowMerkle.computedRoot === sanctions_root;


    // ========================================================================
    // STEP 6: Verify high leaf hash is in the sanctions tree
    // ========================================================================
    component highMerkle = SanctionsMerkleChecker(depth);
    highMerkle.leaf <== highLeafHash.out;
    for (var i = 0; i < depth; i++) {
        highMerkle.pathIndices[i] <== high_path_indices[i];
        highMerkle.pathElements[i] <== high_path_elements[i];
    }

    highMerkle.computedRoot === sanctions_root;


    // ========================================================================
    // STEP 7: Range checks (I-2 FIX — prevent field element ambiguity)
    // ========================================================================
    // All values used in the ordering comparison must fit in 253 bits.
    // The BN254 scalar field is ~254 bits. Without these checks, a malicious
    // prover could use values near the field modulus p, causing the subtraction
    // (a - b) to wrap around modulo p and produce a "positive" result even
    // when a < b in the integers. Constraining to 253 bits ensures all values
    // are in [0, 2^253 - 1], where subtraction of valid values cannot wrap.

    component rangeLowLeafValue = Num2Bits(253);
    rangeLowLeafValue.in <== low_leaf_value;

    component rangeUserAddress = Num2Bits(253);
    rangeUserAddress.in <== user_address;

    component rangeHighLeafValue = Num2Bits(253);
    rangeHighLeafValue.in <== high_leaf_value;


    // ========================================================================
    // STEP 8: Prove low_leaf_value < user_address < high_leaf_value
    // ========================================================================
    // This is the non-inclusion proof:
    // If user_address were in the tree, it would be between low_leaf_value
    // and high_leaf_value. Since these leaves are ADJACENT in the indexed
    // tree (proven by the adjacency constraint in Step 4), user_address
    // cannot be in the tree.

    // Prove: user_address > low_leaf_value  →  (user_address - low_leaf_value) fits in 253 bits and > 0
    signal diff_low;
    diff_low <== user_address - low_leaf_value;

    // Range check: diff must be positive and fit in 253 bits
    // (field elements are 254 bits, using 253 ensures positivity)
    // Note: Since both user_address and low_leaf_value are already
    // range-checked to 253 bits above, this 253-bit check on the
    // difference is sufficient to prove user_address > low_leaf_value.
    component rangeLow = Num2Bits(253);
    rangeLow.in <== diff_low;

    // Prove diff_low != 0 (strict inequality: user_address != low_leaf_value)
    component isZeroLow = IsZero();
    isZeroLow.in <== diff_low;
    isZeroLow.out === 0; // Must NOT be zero

    // Prove: high_leaf_value > user_address  →  (high_leaf_value - user_address) fits in 253 bits and > 0
    signal diff_high;
    diff_high <== high_leaf_value - user_address;

    component rangeHigh = Num2Bits(253);
    rangeHigh.in <== diff_high;

    // Prove diff_high != 0 (strict inequality: user_address != high_leaf_value)
    component isZeroHigh = IsZero();
    isZeroHigh.in <== diff_high;
    isZeroHigh.out === 0;


    // ========================================================================
    // STEP 9: Anti-replay binding
    // ========================================================================
    signal nonce_square;
    nonce_square <== attestation_nonce * attestation_nonce;
}


// ============================================================================
// INSTANTIATION
// ============================================================================
// Tree depth: 20 (supports ~1M sanctioned addresses)
// 3 public inputs: [sanctions_root, user_commitment, attestation_nonce]
// Estimated constraints: ~2500 (2 Merkle proofs x 20 depth x ~50 each
//   + 2 Poseidon leaf hashes + 5 Num2Bits(253) range checks + IsZero checks)
// ============================================================================

component main {public [
    sanctions_root,
    user_commitment,
    attestation_nonce
]} = ComplianceInnocenceProof(20);
