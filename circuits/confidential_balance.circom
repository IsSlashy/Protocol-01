pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// ============================================================================
// zkSPL - Confidential Balance Circuit
// ============================================================================
//
// PURPOSE:
//   Prove that a balance update is valid WITHOUT revealing any amounts.
//   This single circuit handles 4 operations:
//
//   1. DEPOSIT  (SPL → zkSPL):  public_credit = deposit amount, rest = 0
//   2. WITHDRAW (zkSPL → SPL):  public_debit = withdraw amount, rest = 0
//   3. SEND     (private):      is_debit = 1, amount = transfer amount
//   4. RECEIVE  (private):      is_debit = 0, amount = transfer amount
//
// SECURITY MODEL:
//   - Balance commitments use Poseidon hash (quantum-resistant)
//   - Range proofs prevent overflow/underflow (no negative balances)
//   - Conservation law prevents inflation (money can't appear from nowhere)
//   - Salt/randomness prevents brute-force balance guessing
//   - Nonce prevents replay attacks (reusing old proofs)
//
// QUANTUM RESISTANCE:
//   - Poseidon hash commitments are NOT based on elliptic curves
//   - They rely on algebraic hash security, resistant to Shor's algorithm
//   - Only the proof system (Groth16) needs future migration to STARKs
//   - The committed data (balances, salts) remains safe regardless
//
// ============================================================================


// ----------------------------------------------------------------------------
// Balance Commitment
// ----------------------------------------------------------------------------
// Creates a "locked box" containing your balance.
// Nobody can open it without knowing all 4 ingredients.
//
// commitment = Poseidon(balance, augmented_salt, owner_pubkey, token_mint)
// where augmented_salt = Poseidon(salt, nonce)
//
// - balance:      Your actual token balance (e.g., 100 USDC)
// - salt:         A random number only you know (prevents guessing)
// - nonce:        Anti-replay counter (bound into commitment)
// - owner_pubkey: Your public key (derived from spending_key)
// - token_mint:   Which token (USDC, SOL, etc.)
// ----------------------------------------------------------------------------
template BalanceCommitment() {
    signal input balance;
    signal input salt;
    signal input nonce;
    signal input owner_pubkey;
    signal input token_mint;

    signal output commitment;

    // Bind nonce into salt to prevent replay attacks
    component nonceHasher = Poseidon(2);
    nonceHasher.inputs[0] <== salt;
    nonceHasher.inputs[1] <== nonce;

    signal augmented_salt;
    augmented_salt <== nonceHasher.out;

    component hasher = Poseidon(4);
    hasher.inputs[0] <== balance;
    hasher.inputs[1] <== augmented_salt;
    hasher.inputs[2] <== owner_pubkey;
    hasher.inputs[3] <== token_mint;

    commitment <== hasher.out;
}


// ----------------------------------------------------------------------------
// Amount Commitment
// ----------------------------------------------------------------------------
// For private transfers: hides the transfer amount.
// The sender creates this, the recipient verifies it later.
//
// commitment = Poseidon(amount, amount_salt)
//
// Both sender and recipient use the SAME amount_salt to agree on the amount
// without revealing it publicly.
// ----------------------------------------------------------------------------
template AmountCommitment() {
    signal input amount;
    signal input amount_salt;

    signal output commitment;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== amount;
    hasher.inputs[1] <== amount_salt;

    commitment <== hasher.out;
}


// ----------------------------------------------------------------------------
// Owner Key Derivation  (reuses pattern from existing poseidon.circom)
// ----------------------------------------------------------------------------
// owner_pubkey = Poseidon(spending_key, 0)
//
// Your spending_key is SECRET (like a password).
// Your owner_pubkey is PUBLIC (like a username).
// Nobody can reverse the hash to find your spending_key.
// Domain tag 0 separates this from SpendingKeyHash (tag 1).
// ----------------------------------------------------------------------------
template OwnerDerivation() {
    signal input spending_key;
    signal output owner_pubkey;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== spending_key;
    hasher.inputs[1] <== 0;

    owner_pubkey <== hasher.out;
}


// ============================================================================
// MAIN CIRCUIT: ConfidentialBalance
// ============================================================================
//
// The math in plain English:
//
//   old_balance + what_you_receive = new_balance + what_you_send
//
// More precisely:
//   old_balance + private_credit + public_credit
//     = new_balance + private_debit + public_debit
//
// Where:
//   private_credit = amount    (if is_debit = 0, i.e., receiving)
//   private_debit  = amount    (if is_debit = 1, i.e., sending)
//   public_credit  = deposit   (visible on-chain, 0 for private transfers)
//   public_debit   = withdraw  (visible on-chain, 0 for private transfers)
//
// ============================================================================
template ConfidentialBalance() {

    // ========================================================================
    // PUBLIC INPUTS  (visible to everyone, stored on-chain)
    // ========================================================================

    // Current balance commitment (read from on-chain account)
    signal input old_commitment;

    // New balance commitment (will be written to on-chain account)
    signal input new_commitment;

    // Hash of the private transfer amount: Poseidon(amount, amount_salt)
    // This links sender and recipient without revealing the amount.
    // For deposit/withdraw (public amounts), this is Poseidon(0, 0).
    signal input amount_hash;

    // Public deposit amount (SPL tokens coming IN to zkSPL)
    // Non-zero only for deposit operations
    signal input public_credit;

    // Public withdraw amount (zkSPL tokens going OUT to SPL)
    // Non-zero only for withdraw operations
    signal input public_debit;

    // Which token (USDC mint address, SOL = 0, etc.)
    signal input token_mint;

    // Anti-replay counter (must match on-chain account nonce)
    // Prevents someone from resubmitting an old valid proof
    signal input nonce;


    // ========================================================================
    // PRIVATE INPUTS  (known only to the prover, never revealed)
    // ========================================================================

    // Your current actual balance
    signal input old_balance;

    // Random number used in your current commitment
    signal input old_salt;

    // Your balance AFTER this operation
    signal input new_balance;

    // NEW random number for your updated commitment
    // (Must be different from old_salt for privacy!)
    signal input new_salt;

    // Transfer amount (for private send/receive, 0 for deposit/withdraw)
    signal input amount;

    // Random number for the amount commitment
    signal input amount_salt;

    // Your secret spending key (proves you own this account)
    signal input spending_key;

    // Direction flag: 1 = sending (subtracting), 0 = receiving (adding)
    signal input is_debit;


    // ========================================================================
    // STEP 1: Prove you own this account
    // ========================================================================
    // Derive public key from spending key: owner = Poseidon(spending_key)
    // This is like proving you know the password for your account.
    // The circuit computes the pubkey and uses it in commitment checks below.
    // If you don't know the real spending_key, the commitments won't match.

    component ownerDerivation = OwnerDerivation();
    ownerDerivation.spending_key <== spending_key;

    signal owner_pubkey;
    owner_pubkey <== ownerDerivation.owner_pubkey;


    // ========================================================================
    // STEP 2: Verify you know your current balance
    // ========================================================================
    // Recompute the commitment from your claimed balance and salt.
    // It MUST match the on-chain commitment (old_commitment).
    // If you lie about your balance, the hash won't match → proof fails.

    component oldCommCheck = BalanceCommitment();
    oldCommCheck.balance <== old_balance;
    oldCommCheck.salt <== old_salt;
    oldCommCheck.nonce <== nonce;
    oldCommCheck.owner_pubkey <== owner_pubkey;
    oldCommCheck.token_mint <== token_mint;

    // CONSTRAINT: computed commitment must equal on-chain commitment
    oldCommCheck.commitment === old_commitment;


    // ========================================================================
    // STEP 3: Verify your new balance commitment is correctly formed
    // ========================================================================
    // Same check but for the NEW balance and NEW salt.
    // This ensures you're not putting garbage on-chain.

    component newCommCheck = BalanceCommitment();
    newCommCheck.balance <== new_balance;
    newCommCheck.salt <== new_salt;
    newCommCheck.nonce <== nonce;
    newCommCheck.owner_pubkey <== owner_pubkey;
    newCommCheck.token_mint <== token_mint;

    // CONSTRAINT: computed new commitment must equal what goes on-chain
    newCommCheck.commitment === new_commitment;


    // ========================================================================
    // STEP 4: Verify the amount commitment
    // ========================================================================
    // For private transfers, this links sender to recipient.
    // Sender proves they subtracted `amount`, recipient proves they added it.
    // Both use the same amount_hash = Poseidon(amount, amount_salt).
    //
    // For deposit/withdraw: amount = 0, amount_salt = 0
    // → amount_hash = Poseidon(0, 0) (a known constant)

    component amountCommCheck = AmountCommitment();
    amountCommCheck.amount <== amount;
    amountCommCheck.amount_salt <== amount_salt;

    // CONSTRAINT: amount hash must match public input
    amountCommCheck.commitment === amount_hash;


    // ========================================================================
    // STEP 5: Direction flag must be binary (0 or 1, nothing else)
    // ========================================================================
    // is_debit = 1 means you're SENDING (balance goes down)
    // is_debit = 0 means you're RECEIVING (balance goes up)
    //
    // The trick: x * (1 - x) = 0 is only true when x = 0 or x = 1.
    // Any other value (like 0.5 or 42) would fail this check.

    is_debit * (1 - is_debit) === 0;


    // ========================================================================
    // STEP 6: Value conservation (THE core constraint)
    // ========================================================================
    // This is the law of physics for money: nothing created, nothing destroyed.
    //
    // private_debit:  if is_debit=1 → amount,  if is_debit=0 → 0
    // private_credit: if is_debit=1 → 0,       if is_debit=0 → amount
    //
    // Then: old_balance + private_credit + public_credit
    //         = new_balance + private_debit + public_debit

    signal private_debit;
    private_debit <== is_debit * amount;
    // When is_debit = 1: private_debit = 1 * amount = amount  ✓
    // When is_debit = 0: private_debit = 0 * amount = 0       ✓

    signal private_credit;
    private_credit <== (1 - is_debit) * amount;
    // When is_debit = 1: private_credit = 0 * amount = 0      ✓
    // When is_debit = 0: private_credit = 1 * amount = amount  ✓

    // THE CONSERVATION LAW:
    // Everything coming in = Everything going out
    old_balance + private_credit + public_credit === new_balance + private_debit + public_debit;

    // Example — DEPOSIT 100 USDC:
    //   old=500, private_credit=0, public_credit=100, new=600, private_debit=0, public_debit=0
    //   500 + 0 + 100 === 600 + 0 + 0  →  600 === 600  ✓
    //
    // Example — SEND 30 (private):
    //   old=600, private_credit=0, public_credit=0, new=570, private_debit=30, public_debit=0
    //   600 + 0 + 0 === 570 + 30 + 0  →  600 === 600  ✓
    //
    // Example — RECEIVE 30 (private):
    //   old=200, private_credit=30, public_credit=0, new=230, private_debit=0, public_debit=0
    //   200 + 30 + 0 === 230 + 0 + 0  →  230 === 230  ✓
    //
    // Example — WITHDRAW 50:
    //   old=230, private_credit=0, public_credit=0, new=180, private_debit=0, public_debit=50
    //   230 + 0 + 0 === 180 + 0 + 50  →  230 === 230  ✓


    // ========================================================================
    // STEP 7: Range proofs (prevent cheating with overflow)
    // ========================================================================
    // In a finite field, -1 is actually a HUGE number (p - 1).
    // Without range proofs, someone could claim new_balance = -1 = p-1
    // which is astronomically large!
    //
    // Num2Bits(64) decomposes a number into 64 binary digits.
    // If the number doesn't fit in 64 bits (i.e., it's ≥ 2^64), this FAILS.
    // This means all amounts must be between 0 and 2^64 - 1.
    //
    // 2^64 = 18,446,744,073,709,551,616 (18.4 quintillion)
    // That's 18.4 billion SOL in lamports, or 18.4 trillion USDC in base units.
    // More than enough for any realistic balance.

    component rangeCheckNewBalance = Num2Bits(64);
    rangeCheckNewBalance.in <== new_balance;

    component rangeCheckOldBalance = Num2Bits(64);
    rangeCheckOldBalance.in <== old_balance;

    component rangeCheckAmount = Num2Bits(64);
    rangeCheckAmount.in <== amount;

    component rangeCheckPublicCredit = Num2Bits(64);
    rangeCheckPublicCredit.in <== public_credit;

    component rangeCheckPublicDebit = Num2Bits(64);
    rangeCheckPublicDebit.in <== public_debit;
}


// ============================================================================
// INSTANTIATION
// ============================================================================
// 7 public inputs:
//   [old_commitment, new_commitment, amount_hash,
//    public_credit, public_debit, token_mint, nonce]
//
// All other inputs are private (never revealed).
// ============================================================================

component main {public [
    old_commitment,
    new_commitment,
    amount_hash,
    public_credit,
    public_debit,
    token_mint,
    nonce
]} = ConfidentialBalance();
