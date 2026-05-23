pub mod init;
pub mod deposit;
pub mod withdraw;
pub mod transfer;
pub mod rotate;
pub mod recover;

// Anchor's `#[program]` macro expects each instruction's `__client_accounts_*`
// auto-generated module to be visible at crate root, so we re-export every
// public item from each instruction file. Each file defines a `handler` fn,
// which means the glob exports collide — but we never refer to
// `instructions::handler` directly (always `init::handler`, etc), so the
// resulting ambiguity is harmless. Silence the lint locally rather than
// renaming every handler.
#[allow(ambiguous_glob_reexports)]
mod _reexport {
    pub use super::init::*;
    pub use super::deposit::*;
    pub use super::withdraw::*;
    pub use super::transfer::*;
    pub use super::rotate::*;
    pub use super::recover::*;
}

pub use _reexport::*;
