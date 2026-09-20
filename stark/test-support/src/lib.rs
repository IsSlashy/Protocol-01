//! Deliberately empty. This crate exists only for the feature edge its
//! manifest declares; see `Cargo.toml` for why.
//!
//! ⛔ Do not add code here. If something needs to be shared between
//! `stark/tests/*.rs`, put it in a `mod` inside those tests: anything exported
//! from here would become reachable from any crate that dev-depends on it,
//! which is the opposite of what LEAK-LEDGER A8 asks for.
