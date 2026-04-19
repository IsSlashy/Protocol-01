pub mod init_pool;
pub mod update_params;
pub mod deposit;
pub mod withdraw;
pub mod prefund;
pub mod settle;

// Glob re-exports so Anchor's `#[program]` macro can see the
// `__client_accounts_*` modules each `#[derive(Accounts)]` generates.
// `#[allow(ambiguous_glob_reexports)]` silences the per-module `handler`
// name clashes — the macro accesses `<module>::handler` directly.
#[allow(ambiguous_glob_reexports)]
pub use init_pool::*;
#[allow(ambiguous_glob_reexports)]
pub use update_params::*;
#[allow(ambiguous_glob_reexports)]
pub use deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use withdraw::*;
#[allow(ambiguous_glob_reexports)]
pub use prefund::*;
#[allow(ambiguous_glob_reexports)]
pub use settle::*;
