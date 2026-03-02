# Contributing to @p01/solana-verifier

Thanks for your interest in contributing.

## Getting Started

1. Fork and clone the repository
2. Install Rust (stable toolchain)
3. Run tests: `cargo test`

## Guidelines

- Keep the crate `no_std`-compatible where possible (Solana BPF target)
- All public APIs need doc comments with examples
- The `cfg(target_os = "solana")` / `cfg(not(target_os = "solana"))` pattern must be maintained for all syscall wrappers so that tests can run on the host
- Do not add dependencies beyond `solana-program`, `solana-bn254`, `sha3`, and `bytemuck` without discussion
- Pattern modules (`src/patterns/`) are documentation-only -- they contain no executable code, just well-commented Anchor examples

## Testing

```bash
# Run all tests (off-chain stubs)
cargo test

# Check it compiles for Solana BPF target
cargo build-sbf
```

## Pull Requests

- One logical change per PR
- Include tests for new functionality
- Update doc comments if APIs change
- Run `cargo clippy` and `cargo fmt` before submitting

## Reporting Bugs

Open an issue with:
- Rust and Solana CLI version
- Minimal reproduction
- Expected vs actual behavior
