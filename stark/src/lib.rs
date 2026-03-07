//! Protocol 01 STARK Proof System
//!
//! Quantum-resistant zero-knowledge proofs using Winterfell STARKs.
//! No trusted setup required — security based on hash functions (collision-resistant),
//! not elliptic curve pairings (vulnerable to Shor's algorithm).
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────┐
//! │ Client (browser WASM / mobile WebView)                  │
//! │                                                         │
//! │  ┌─────────┐    ┌───────────┐    ┌──────────────────┐  │
//! │  │ Witness  │───>│ Prover    │───>│ STARK Proof      │  │
//! │  │ (secret) │    │ (winter)  │    │ (~50KB, PQ-safe) │  │
//! │  └─────────┘    └───────────┘    └──────────────────┘  │
//! └──────────────────────────────────┬──────────────────────┘
//!                                    │ submit proof on-chain
//!                                    ▼
//! ┌─────────────────────────────────────────────────────────┐
//! │ Solana Program (p01_stark_verifier)                     │
//! │                                                         │
//! │  ┌──────────────────┐    ┌───────────────────────────┐  │
//! │  │ STARK Proof      │───>│ FRI Verifier (no_std)     │  │
//! │  │ (from account)   │    │ ~1.1M CU, hash-based     │  │
//! │  └──────────────────┘    └───────────────────────────┘  │
//! └─────────────────────────────────────────────────────────┘
//! ```
//!
//! # Circuits (AIR definitions)
//!
//! | Circuit                 | Circom Equivalent          | Status |
//! |-------------------------|----------------------------|--------|
//! | subscriber_ownership    | subscriber_ownership.circom| POC    |
//! | balance_proof           | balance_proof.circom       | TODO   |
//! | confidential_balance    | confidential_balance.circom| TODO   |
//! | denominated_pool        | denominated_pool.circom    | TODO   |
//! | denominated_transfer    | denominated_transfer.circom| TODO   |
//! | transfer                | transfer.circom            | TODO   |
//!
//! # Field
//!
//! Uses Goldilocks field (p = 2^64 - 2^32 + 1) for fast arithmetic.
//! This is a different field than BN254 used by Groth16 — existing commitments
//! are NOT compatible and require migration.

pub mod air;
pub mod poseidon;
pub mod prover;

#[cfg(feature = "std")]
pub mod verifier;

// Re-exports for convenience
pub use air::subscriber_ownership::{
    build_trace, compute_commitment, SubscriberOwnershipAir, SubscriberOwnershipPublicInputs,
};
pub use prover::{prove_subscriber_ownership, StarkProofBytes};
pub use winterfell::math::fields::f64::BaseElement;

#[cfg(feature = "std")]
pub use verifier::verify_subscriber_ownership;
