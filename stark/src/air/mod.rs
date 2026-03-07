//! AIR (Algebraic Intermediate Representation) definitions for Protocol 01 circuits.
//!
//! Each circuit is expressed as an execution trace + transition constraints,
//! verified without trusted setup using FRI-based STARK proofs.

pub mod subscriber_ownership;
