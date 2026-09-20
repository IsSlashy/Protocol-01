//! Protocol 01 security levels: one source of truth for the STARK parameters,
//! and the calculator that turns them into the figures of
//! `docs/SECURITY-LEVELS.md`.
//!
//! # Where the parameters come from
//!
//! * **v1, the deployed verifier.** The eight `CircuitConfig` constants,
//!   `get_circuit_config` and `GRINDING_BITS` are read from
//!   `programs/p01_stark_verifier/src/compact_proof.rs` itself: the module
//!   below is that file, compiled into this crate through `#[path]`, not a
//!   copy of its numbers. The same goes for `MODULUS` in `goldilocks.rs`. A
//!   change to either file changes the calculator's output, and then
//!   `tests/generated_doc.rs` fails until `docs/SECURITY-LEVELS.md` is
//!   regenerated.
//! * **v2, the candidate profiles.** `params.rs` holds profiles Q, R and R-128
//!   of the v2 design. They are candidates behind the D1 decision gate, not a
//!   deployed system.
//!
//! # Commands
//!
//! ```text
//! cargo run  --manifest-path tools/security-levels/Cargo.toml             # print the document
//! cargo run  --manifest-path tools/security-levels/Cargo.toml -- --write  # regenerate docs/SECURITY-LEVELS.md
//! cargo run  --manifest-path tools/security-levels/Cargo.toml -- --check  # exit 1 if the file is stale
//! cargo run  --manifest-path tools/security-levels/Cargo.toml -- --terms  # every term, every regime
//! cargo test --manifest-path tools/security-levels/Cargo.toml
//! ```

/// The verifier's field, compiled from the verifier's own file.
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../../../programs/p01_stark_verifier/src/goldilocks.rs"]
pub mod goldilocks;

/// The verifier's circuit configurations, compiled from the verifier's own
/// file. Only the `CircuitConfig` constants, `get_circuit_config` and
/// `GRINDING_BITS` are used here; the proof parser comes along unused.
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../../../programs/p01_stark_verifier/src/compact_proof.rs"]
pub mod compact_proof;

pub mod calc;
pub mod params;
pub mod prose;
pub mod render;

use std::path::PathBuf;

/// The repository root, resolved from this crate's manifest directory.
pub fn repo_root() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = here.join("..").join("..");
    root.canonicalize().unwrap_or(root)
}

/// Where the generated document lives, relative to the repository root.
pub const DOC_PATH: &str = "docs/SECURITY-LEVELS.md";
