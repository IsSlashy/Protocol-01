//! AIR (Algebraic Intermediate Representation) definitions for Protocol 01 circuits.
//!
//! Each circuit is expressed as an execution trace + transition constraints,
//! verified without trusted setup using FRI-based STARK proofs.

pub mod subscriber_ownership;
pub mod merkle_path;
pub mod merkle_update;
pub mod denominated_pool;
pub mod balance_proof;
pub mod confidential_balance;
pub mod transfer;


// C7 — the depth-12 spend circuit. Present so its 34 unit tests run on the
// unified tree, but gated on `cfg(test)` DELIBERATELY: it is unwired into the
// compact pipeline, and referencing it from a non-test build changes the
// shipped prover blob (measured 2026-08-24 — `pub use` of it in lib.rs shifted
// the wasm at byte 227819, breaking reproduction of the deployed 51a947e3).
// ⛔ Do not promote this to `pub mod spend;` or re-export it from lib.rs until
// C7 is actually wired (C7_SPEND_CIRCUIT_PLAN Step 4) and the verifier is
// redeployed to accept circuit 7. The full C7 source with its exports lives on
// branch feat/c7-depth12-blinding-2026-08-23.
#[cfg(test)]
pub mod spend;
