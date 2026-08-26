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


// C7 — the depth-12 spend circuit. PROMOTED out of `cfg(test)` on 2026-08-24,
// because Step 4 of C7_SPEND_CIRCUIT_PLAN wires it into the compact pipeline
// and `compact.rs` cannot reference a test-only module.
//
// 🚨 THE REASON IT WAS GATED IS STILL TRUE, it has just moved. Measured
// 2026-08-24: referencing this module from a non-test build changes the shipped
// prover blob (a `pub use` in lib.rs shifted the wasm at byte 227819), and the
// blob the three surfaces ship — web, extension, mobile — must keep hashing to
// 51a947e3 for the DEPLOYED verifier to accept its proofs. The gate is no
// longer what protects that; what protects it now is that nobody rebuilds the
// blob. `packages/stark-prover/src/shippedBlob.test.ts` pins the artifact on
// disk, so the current blob cannot change by accident.
//
// ⛔ DO NOT run `wasm-pack build stark ...` and ship the result until the
// verifier that accepts circuit 7 is DEPLOYED (Plan steps 6, 8 and 11, in that
// order). A rebuilt blob is not rejected early: it fails at the END of a ~150
// transaction upload.
//
// ⚠ An earlier version of this note said the full C7 source "with its
// exports" lived on branch `feat/c7-depth12-blinding-2026-08-23`. Checked
// 2026-08-24: that branch does not exist on `origin` (`git ls-remote --heads`)
// and does not exist locally. Either it landed through the b7 reconciliation --
// this file's depth-12 + blinding-region work IS on master -- or it never left
// the other machine. The exports it referred to were written fresh in
// `compact.rs` (`generate_spend_compact_proof`) and `lib.rs`
// (`generate_spend_stark_proof`) on 2026-08-24. Do not go looking for it.
pub mod spend;
