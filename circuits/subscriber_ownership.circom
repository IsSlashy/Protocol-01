pragma circom 2.1.0;

// ==========================================================================
// Protocol 01 — Subscriber Ownership Proof
// ==========================================================================
//
// Lightweight circuit (~250 constraints) that proves knowledge of a secret
// whose Poseidon hash equals a public commitment. Used for private
// subscription vaults: the subscriber proves they own the vault without
// revealing their identity.
//
// Commitment = Poseidon(subscriber_secret)
// Public input:  commitment
// Private input: subscriber_secret
//
// Usage:
//   - pause_private / resume_private / cancel_private subscription actions
//   - The commitment is stored in the SubscriptionVault account on-chain
//   - The subscriber generates a proof off-chain to authenticate

include "node_modules/circomlib/circuits/poseidon.circom";

template SubscriberOwnership() {
    // Public input
    signal input commitment;

    // Private input
    signal input subscriber_secret;

    // Compute Poseidon(subscriber_secret)
    component hasher = Poseidon(1);
    hasher.inputs[0] <== subscriber_secret;

    // Constrain: hash must equal the public commitment
    commitment === hasher.out;
}

component main {public [commitment]} = SubscriberOwnership();
