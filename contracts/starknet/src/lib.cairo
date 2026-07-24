//! Specter × STRK20 — Starknet contracts.
//!
//! We do NOT rebuild STRK20's Privacy Pool (protocol-native, sequencer-verified).
//! The only chain-specific piece is `pq_announcer`: a transport that emits
//! ML-KEM ciphertext chunks as events for post-quantum recipient discovery.
//! See ../ARCHITECTURE.md. STARK/PQ only — no Groth16, no pairings, no trusted setup.

pub mod pq_announcer;
