pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// ============================================================================
// zkSPL - Balance Sufficiency Proof
// ============================================================================
//
// PURPOSE:
//   Prove "I have at least X tokens" WITHOUT revealing your actual balance.
//
//   Example: A DEX needs to know you have ≥ 50 USDC to trade.
//   You prove it. The DEX never learns if you have 50, 500, or 5000.
//
// USE CASES:
//   - DeFi protocols verifying collateral requirements
//   - DEXes checking sufficient balance for trades
//   - Lending protocols confirming minimum deposits
//   - Any smart contract that needs "enough funds?" without seeing the number
//
// HOW IT WORKS:
//   If balance ≥ threshold, then (balance - threshold) is non-negative.
//   Non-negative means it fits in 64 bits (range proof).
//   If balance < threshold, (balance - threshold) is "negative" in the field,
//   which means it's a HUGE number that won't fit in 64 bits → proof fails.
//
// ============================================================================


// Balance commitment template (same as confidential_balance.circom)
template BalanceCommitmentProof() {
    signal input balance;
    signal input salt;
    signal input owner_pubkey;
    signal input token_mint;

    signal output commitment;

    component hasher = Poseidon(4);
    hasher.inputs[0] <== balance;
    hasher.inputs[1] <== salt;
    hasher.inputs[2] <== owner_pubkey;
    hasher.inputs[3] <== token_mint;

    commitment <== hasher.out;
}


// Owner derivation template (domain tag 0, matches SpendingKeyDerivation)
template OwnerDerivationProof() {
    signal input spending_key;
    signal output owner_pubkey;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== spending_key;
    hasher.inputs[1] <== 0;

    owner_pubkey <== hasher.out;
}


// ============================================================================
// MAIN CIRCUIT: BalanceSufficiency
// ============================================================================
template BalanceSufficiency() {

    // ========================================================================
    // PUBLIC INPUTS
    // ========================================================================

    // Your balance commitment (from on-chain account)
    signal input balance_commitment;

    // The minimum amount you're proving you have
    // Example: threshold = 50 means "I have ≥ 50"
    signal input threshold;

    // Which token
    signal input token_mint;


    // ========================================================================
    // PRIVATE INPUTS
    // ========================================================================

    // Your actual balance (secret)
    signal input balance;

    // Your commitment salt (secret)
    signal input salt;

    // Your spending key (proves ownership)
    signal input spending_key;


    // ========================================================================
    // STEP 1: Prove ownership
    // ========================================================================
    component ownerDerivation = OwnerDerivationProof();
    ownerDerivation.spending_key <== spending_key;

    signal owner_pubkey;
    owner_pubkey <== ownerDerivation.owner_pubkey;


    // ========================================================================
    // STEP 2: Verify balance commitment
    // ========================================================================
    // Recompute commitment from your claimed balance.
    // Must match the on-chain commitment.

    component commCheck = BalanceCommitmentProof();
    commCheck.balance <== balance;
    commCheck.salt <== salt;
    commCheck.owner_pubkey <== owner_pubkey;
    commCheck.token_mint <== token_mint;

    commCheck.commitment === balance_commitment;


    // ========================================================================
    // STEP 3: Prove balance ≥ threshold
    // ========================================================================
    // The key insight:
    //   difference = balance - threshold
    //
    //   If balance ≥ threshold → difference ≥ 0 → fits in 64 bits ✓
    //   If balance < threshold → difference is "negative"
    //     → In field arithmetic, it becomes (p - small_number)
    //     → That's a HUGE number (> 2^64)
    //     → Num2Bits(64) FAILS → proof cannot be generated ✗

    signal difference;
    difference <== balance - threshold;

    // Range proof: difference must fit in 64 bits (i.e., ≥ 0 and < 2^64)
    component rangeCheck = Num2Bits(64);
    rangeCheck.in <== difference;

    // Also range-check the balance itself for safety
    component rangeCheckBalance = Num2Bits(64);
    rangeCheckBalance.in <== balance;

    // M4: Range check threshold to prevent field wraparound
    component thresholdRange = Num2Bits(64);
    thresholdRange.in <== threshold;
}


// ============================================================================
// INSTANTIATION
// ============================================================================
// 3 public inputs: [balance_commitment, threshold, token_mint]
// ============================================================================

component main {public [
    balance_commitment,
    threshold,
    token_mint
]} = BalanceSufficiency();
