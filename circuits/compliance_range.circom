pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// ============================================================================
// Compliance Range Proof — Selective Disclosure for Regulators
// ============================================================================
//
// PURPOSE:
//   Prove "my balance is between MIN and MAX" WITHOUT revealing the exact amount.
//   This enables regulatory compliance without breaking privacy.
//
// USE CASES:
//   - FATF Travel Rule: prove transaction volume < €1,000 threshold
//   - AML compliance: prove balance < $10,000 reporting threshold
//   - KYC tiers: prove balance within tier bounds (e.g., $100-$50,000)
//   - Solvency: prove reserves >= liabilities without revealing exact holdings
//   - DeFi composability: prove you're within risk parameters
//
// HOW IT WORKS:
//   Two range proofs in one circuit:
//   1. balance >= min_bound  →  (balance - min_bound) fits in 64 bits
//   2. balance <= max_bound  →  (max_bound - balance) fits in 64 bits
//   If either condition fails, the difference is "negative" in the field
//   (becomes p - small_number, which is > 2^64) → Num2Bits(64) fails.
//
// ATTESTATION:
//   The attestation_nonce links this proof to a specific compliance request,
//   preventing replay of old proofs for new compliance checks.
//
// ============================================================================


// Balance commitment template (matches balance_proof.circom / confidential_balance.circom)
// commitment = Poseidon(balance, Poseidon(salt, nonce), owner_pubkey, token_mint)
template ComplianceBalanceCommitment() {
    signal input balance;
    signal input salt;
    signal input nonce;
    signal input owner_pubkey;
    signal input token_mint;

    signal output commitment;

    // Bind nonce into salt (matches confidential_balance.circom)
    component augSalt = Poseidon(2);
    augSalt.inputs[0] <== salt;
    augSalt.inputs[1] <== nonce;

    component hasher = Poseidon(4);
    hasher.inputs[0] <== balance;
    hasher.inputs[1] <== augSalt.out;
    hasher.inputs[2] <== owner_pubkey;
    hasher.inputs[3] <== token_mint;

    commitment <== hasher.out;
}


// Owner derivation (matches balance_proof.circom)
template ComplianceOwnerDerivation() {
    signal input spending_key;
    signal output owner_pubkey;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== spending_key;
    hasher.inputs[1] <== 0;

    owner_pubkey <== hasher.out;
}


// ============================================================================
// MAIN CIRCUIT: ComplianceRangeProof
// ============================================================================
// Proves: min_bound <= balance <= max_bound
// Without revealing: balance, salt, nonce, spending_key
// ============================================================================
template ComplianceRangeProof() {

    // ========================================================================
    // PUBLIC INPUTS (5)
    // ========================================================================

    // On-chain balance commitment (from ConfidentialAccount PDA)
    signal input balance_commitment;

    // Lower bound (inclusive): prove balance >= min_bound
    // Set to 0 for "prove balance <= max_bound" only
    signal input min_bound;

    // Upper bound (inclusive): prove balance <= max_bound
    // Example: 10000000000 for $10,000 USDC (6 decimals)
    signal input max_bound;

    // Which token this commitment is for
    signal input token_mint;

    // Unique nonce binding this proof to a specific compliance request
    // Prevents replay: each attestation request gets a unique nonce
    signal input attestation_nonce;


    // ========================================================================
    // PRIVATE INPUTS (4)
    // ========================================================================

    // Actual balance (secret — never revealed)
    signal input balance;

    // Commitment salt (secret)
    signal input salt;

    // Anti-replay nonce (must match the commitment's nonce)
    signal input nonce;

    // Spending key (proves ownership of the account)
    signal input spending_key;


    // ========================================================================
    // STEP 1: Prove ownership via spending key derivation
    // ========================================================================
    component ownerDerivation = ComplianceOwnerDerivation();
    ownerDerivation.spending_key <== spending_key;

    signal owner_pubkey;
    owner_pubkey <== ownerDerivation.owner_pubkey;


    // ========================================================================
    // STEP 2: Verify balance commitment matches on-chain data
    // ========================================================================
    component commCheck = ComplianceBalanceCommitment();
    commCheck.balance <== balance;
    commCheck.salt <== salt;
    commCheck.nonce <== nonce;
    commCheck.owner_pubkey <== owner_pubkey;
    commCheck.token_mint <== token_mint;

    commCheck.commitment === balance_commitment;


    // ========================================================================
    // STEP 3: Prove balance >= min_bound (lower bound)
    // ========================================================================
    // diff_lower = balance - min_bound
    // If balance >= min_bound → diff_lower >= 0 → fits in 64 bits ✓
    // If balance < min_bound → diff_lower wraps to huge field element → fails ✗

    signal diff_lower;
    diff_lower <== balance - min_bound;

    component rangeLower = Num2Bits(64);
    rangeLower.in <== diff_lower;


    // ========================================================================
    // STEP 4: Prove balance <= max_bound (upper bound)
    // ========================================================================
    // diff_upper = max_bound - balance
    // If balance <= max_bound → diff_upper >= 0 → fits in 64 bits ✓
    // If balance > max_bound → diff_upper wraps to huge field element → fails ✗

    signal diff_upper;
    diff_upper <== max_bound - balance;

    component rangeUpper = Num2Bits(64);
    rangeUpper.in <== diff_upper;


    // ========================================================================
    // STEP 5: Range-check all values to prevent field wraparound attacks
    // ========================================================================

    // Balance must fit in 64 bits (no field overflow)
    component rangeBalance = Num2Bits(64);
    rangeBalance.in <== balance;

    // min_bound must fit in 64 bits
    component rangeMin = Num2Bits(64);
    rangeMin.in <== min_bound;

    // max_bound must fit in 64 bits
    component rangeMax = Num2Bits(64);
    rangeMax.in <== max_bound;


    // ========================================================================
    // STEP 6: Enforce min_bound <= max_bound (sanity check)
    // ========================================================================
    // diff_bounds = max_bound - min_bound (must be >= 0)
    signal diff_bounds;
    diff_bounds <== max_bound - min_bound;

    component rangeBounds = Num2Bits(64);
    rangeBounds.in <== diff_bounds;


    // ========================================================================
    // STEP 7: Bind attestation nonce (anti-replay)
    // ========================================================================
    // The attestation_nonce is a public input that binds this proof
    // to a specific compliance request. It doesn't need constraints
    // beyond being a public input (it's verified by the on-chain program).
    // We add a dummy constraint to prevent compiler optimization.
    signal attestation_square;
    attestation_square <== attestation_nonce * attestation_nonce;
}


// ============================================================================
// INSTANTIATION
// ============================================================================
// 5 public inputs: [balance_commitment, min_bound, max_bound, token_mint, attestation_nonce]
// 4 private inputs: [balance, salt, nonce, spending_key]
// Estimated constraints: ~900
// ============================================================================

component main {public [
    balance_commitment,
    min_bound,
    max_bound,
    token_mint,
    attestation_nonce
]} = ComplianceRangeProof();
