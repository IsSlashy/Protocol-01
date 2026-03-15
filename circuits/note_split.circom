pragma circom 2.1.0;

// ==========================================================================
// Protocol 01 — Privacy Router: Cross-Pool Note Split
// ==========================================================================
//
// Splits a single high-denomination note into up to 20 smaller notes in a
// target pool. This is the core circuit for Protocol 01's Privacy Router,
// enabling users to break large denominations into many smaller ones for
// improved privacy and usability.
//
// Example: 1 note of 10 SOL (in the 10 SOL pool) -> 20 notes of 0.5 SOL
//          (in the 0.5 SOL pool). The on-chain program enforces that the
//          total value is conserved (source denomination = num_active * target
//          denomination). The circuit does NOT check amounts — denomination
//          matching is the Solana program's responsibility.
//
// The circuit proves:
//   1. The prover knows a valid note in the source pool (secret + nullifier_preimage)
//   2. The source note exists in the source pool's Merkle tree
//   3. The nullifier is correctly derived (prevents double-spend of source note)
//   4. The source note is mature (deposit_epoch <= min_epoch) — when enforced
//   5. All active output commitments are correctly formed Poseidon hashes
//   6. All dummy output slots (beyond num_active_outputs) are zero
//   7. num_active_outputs is in the valid range [1, MAX_OUTPUTS]
//
// Source commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
// Source nullifier  = Poseidon(nullifier_preimage, secret)
// Output commitment = Poseidon(output_nullifier_preimages[i], output_secrets[i],
//                              output_deposit_epoch, token_mint)
//
// Public inputs:
//   source_merkle_root    — Merkle root of the source denominated pool
//   nullifier             — derived from the source note (published on-chain)
//   min_epoch             — current_epoch - required_delay_epochs
//   token_mint            — SPL token mint (same for source and all outputs)
//   enforce_maturity      — 1 = enforce epoch delay, 0 = emergency bypass
//   num_active_outputs    — how many of the 20 output slots are real (1..20)
//   output_commitments[20]— the 20 new note commitments (zeros for dummies)
//
// Private inputs:
//   secret                — user's spending key for the source note
//   nullifier_preimage    — random value from the source deposit
//   deposit_epoch         — epoch when the source note was created
//   path_elements[15]     — Merkle proof siblings
//   path_indices[15]      — Merkle path direction bits (0=left, 1=right)
//   output_secrets[20]    — new spending secrets for each output note
//   output_nullifier_preimages[20] — new random values for each output note
//   output_deposit_epoch  — epoch for all new notes (set by the on-chain program)
//
// Security properties:
//   - Source note is provably consumed: nullifier is deterministic and
//     published on-chain by the Solana program
//   - Double-spend is impossible: same nullifier cannot be used twice (PDA check)
//   - All active outputs are bound to the circuit: their commitments are
//     verified as Poseidon hashes of the private inputs
//   - Dummy outputs are provably zero: an adversary cannot sneak non-zero
//     commitments into inactive slots
//   - num_active_outputs is range-checked: cannot be 0 (would allow spending
//     without creating outputs) or exceed 20 (would overflow the array)
//   - output_deposit_epoch is range-checked: prevents field overflow attacks
//   - Token mint is embedded in both source and output commitments: prevents
//     cross-token attacks (e.g., splitting a SOL note into USDC notes)
//   - Timing correlation is mitigated: deposit_epoch rounds to ~1h windows,
//     and all outputs share the same output_deposit_epoch
//   - Value conservation is NOT checked here — that is the Solana program's
//     responsibility (source_pool.denomination == num_active * target_pool.denomination)
// ==========================================================================

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./merkle.circom";

template NoteSplit(merkleDepth, maxOutputs) {
    // ========================================
    // PUBLIC INPUTS
    // ========================================
    signal input source_merkle_root;
    signal input nullifier;
    signal input min_epoch;              // current_epoch - required_delay_epochs
    signal input token_mint;
    signal input enforce_maturity;       // 1 = enforce epoch delay, 0 = skip (emergency)
    signal input num_active_outputs;     // How many outputs are real (1..maxOutputs)
    signal input output_commitments[maxOutputs];

    // ========================================
    // PRIVATE INPUTS — Source note
    // ========================================
    signal input secret;                 // User's spending key for source note
    signal input nullifier_preimage;     // Random value, unique per source deposit
    signal input deposit_epoch;          // Epoch when source note was created
    signal input path_elements[merkleDepth];
    signal input path_indices[merkleDepth];

    // ========================================
    // PRIVATE INPUTS — Output notes
    // ========================================
    signal input output_secrets[maxOutputs];
    signal input output_nullifier_preimages[maxOutputs];
    signal input output_deposit_epoch;   // Single epoch for all outputs (set by program)

    // ================================================================
    // STEP 1: Verify source note ownership — compute commitment
    // ================================================================
    // commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
    component commitHasher = Poseidon(4);
    commitHasher.inputs[0] <== nullifier_preimage;
    commitHasher.inputs[1] <== secret;
    commitHasher.inputs[2] <== deposit_epoch;
    commitHasher.inputs[3] <== token_mint;

    signal source_commitment;
    source_commitment <== commitHasher.out;

    // ================================================================
    // STEP 2: Compute and verify nullifier
    // ================================================================
    // nullifier = Poseidon(nullifier_preimage, secret)
    component nullHasher = Poseidon(2);
    nullHasher.inputs[0] <== nullifier_preimage;
    nullHasher.inputs[1] <== secret;

    // Nullifier must match the public input
    nullHasher.out === nullifier;

    // ================================================================
    // STEP 3: Verify Merkle tree membership in source pool
    // ================================================================
    component merkleChecker = MerkleTreeChecker(merkleDepth);
    merkleChecker.leaf <== source_commitment;
    for (var i = 0; i < merkleDepth; i++) {
        merkleChecker.pathElements[i] <== path_elements[i];
        merkleChecker.pathIndices[i] <== path_indices[i];
    }

    // Computed root must match the public source_merkle_root
    merkleChecker.computedRoot === source_merkle_root;

    // ================================================================
    // STEP 4: Time delay verification (gated by enforce_maturity)
    // ================================================================
    // enforce_maturity must be binary (0 or 1)
    enforce_maturity * (enforce_maturity - 1) === 0;

    // Prove: deposit_epoch <= min_epoch (when enforce_maturity=1)
    // Range check deposit_epoch to prevent overflow attacks
    component depositEpochRange = Num2Bits(40);
    depositEpochRange.in <== deposit_epoch;

    signal epoch_diff_raw;
    epoch_diff_raw <== min_epoch - deposit_epoch;

    // Gated epoch diff: enforce_maturity=1 -> epoch_diff_raw, enforce_maturity=0 -> 0
    signal epoch_diff;
    epoch_diff <== enforce_maturity * epoch_diff_raw;

    component rangeCheck = Num2Bits(40);
    rangeCheck.in <== epoch_diff;

    // ================================================================
    // STEP 5: Range check num_active_outputs (must be in [1, maxOutputs])
    // ================================================================
    // We need: 1 <= num_active_outputs <= maxOutputs
    //
    // Check num_active_outputs >= 1:
    //   Equivalent to num_active_outputs > 0, i.e., 0 < num_active_outputs
    //   Using LessThan(5): in[0]=0, in[1]=num_active_outputs => out=1
    //   5 bits supports values up to 31 (maxOutputs=20 fits in 5 bits)
    component minOutputCheck = LessThan(5);
    minOutputCheck.in[0] <== 0;
    minOutputCheck.in[1] <== num_active_outputs;
    minOutputCheck.out === 1;  // Assert: 0 < num_active_outputs

    // Check num_active_outputs <= maxOutputs:
    //   Equivalent to num_active_outputs < maxOutputs + 1
    component maxOutputCheck = LessThan(5);
    maxOutputCheck.in[0] <== num_active_outputs;
    maxOutputCheck.in[1] <== maxOutputs + 1;
    maxOutputCheck.out === 1;  // Assert: num_active_outputs <= maxOutputs

    // ================================================================
    // STEP 6: Range check output_deposit_epoch (prevent overflow)
    // ================================================================
    component outputEpochRange = Num2Bits(40);
    outputEpochRange.in <== output_deposit_epoch;

    // ================================================================
    // STEP 7: Verify all output commitments
    // ================================================================
    // For each slot i in [0, maxOutputs):
    //   - Compute is_active = (i < num_active_outputs) ? 1 : 0
    //   - If active: output_commitments[i] must equal Poseidon(output_nullifier_preimages[i],
    //                output_secrets[i], output_deposit_epoch, token_mint)
    //   - If dummy:  output_commitments[i] must equal 0
    //
    // Constraints use conditional multiplication to handle both cases:
    //   is_active * (computed_commitment - output_commitments[i]) === 0
    //     => When active (is_active=1): computed_commitment must equal output_commitments[i]
    //     => When dummy  (is_active=0): constraint is trivially satisfied
    //
    //   (1 - is_active) * output_commitments[i] === 0
    //     => When active (is_active=1): constraint is trivially satisfied
    //     => When dummy  (is_active=0): output_commitments[i] must equal 0

    component outputHashers[maxOutputs];
    component isActiveCheck[maxOutputs];
    signal diff_active[maxOutputs];
    signal check_active[maxOutputs];
    signal is_dummy[maxOutputs];
    signal check_dummy[maxOutputs];

    for (var i = 0; i < maxOutputs; i++) {
        // Determine if this slot is active: i < num_active_outputs
        // LessThan(5) compares two values that fit in 5 bits (max 31)
        // We compare constant i against public num_active_outputs
        isActiveCheck[i] = LessThan(5);
        isActiveCheck[i].in[0] <== i;
        isActiveCheck[i].in[1] <== num_active_outputs;
        // isActiveCheck[i].out = 1 if i < num_active_outputs, else 0

        // Compute output commitment for this slot
        // Poseidon(output_nullifier_preimages[i], output_secrets[i], output_deposit_epoch, token_mint)
        outputHashers[i] = Poseidon(4);
        outputHashers[i].inputs[0] <== output_nullifier_preimages[i];
        outputHashers[i].inputs[1] <== output_secrets[i];
        outputHashers[i].inputs[2] <== output_deposit_epoch;
        outputHashers[i].inputs[3] <== token_mint;

        // Constraint A: If active, computed hash must match the public commitment
        // is_active * (computed - declared) === 0
        diff_active[i] <== outputHashers[i].out - output_commitments[i];
        check_active[i] <== isActiveCheck[i].out * diff_active[i];
        check_active[i] === 0;

        // Constraint B: If dummy, the public commitment must be zero
        // (1 - is_active) * declared === 0
        is_dummy[i] <== 1 - isActiveCheck[i].out;
        check_dummy[i] <== is_dummy[i] * output_commitments[i];
        check_dummy[i] === 0;
    }
}

// ==========================================================================
// Main component instantiation
// ==========================================================================
// Merkle depth 15: supports ~32K notes per pool (same as denominated_pool)
// Max outputs 20: supports splitting into up to 20 smaller notes
//
// Estimated constraints: ~7,500-8,500
//   - Source verification: ~4,273 (same as denominated_pool with depth 15)
//   - 20 output Poseidon hashes: ~5,400 (20 * ~270)
//   - 20 LessThan comparators: ~120 (20 * ~6)
//   - Range checks + misc: ~200
//   Total: ~10,000
//
// Expected proof time: ~400-600ms on mobile (snarkjs JS via WebView)
component main {public [source_merkle_root, nullifier, min_epoch, token_mint, enforce_maturity, num_active_outputs, output_commitments]} = NoteSplit(15, 20);
