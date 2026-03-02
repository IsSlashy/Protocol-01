# Gotcha: __rust_probestack Linker Error with wasmer_vm

**Time lost discovering this: ~4 hours**

## The Problem

When building a Rust-based ZK prover that uses `ark-circom` (which depends on
`wasmer` for WASM execution), you may encounter a linker error on Linux:

```
undefined reference to `__rust_probestack`
```

This happens because:
1. Rust 1.85+ uses inline stack probing, removing the `__rust_probestack` symbol
2. `wasmer_vm` still references it (compiled against an older Rust version)
3. The linker can't find the symbol

## The Symptom

- Compilation succeeds on macOS but fails on Linux
- Error appears only when linking the final binary
- The error references `wasmer_vm` or `wasmer_compiler`

## The Fix

Add a stub in your `main.rs`:

```rust
// Provide __rust_probestack stub for wasmer_vm compatibility
// Rust 1.85+ uses inline probing, but wasmer_vm still references this symbol
#[cfg(target_os = "linux")]
core::arch::global_asm!(
    ".global __rust_probestack",
    "__rust_probestack:",
    "ret"
);
```

## What Doesn't Work

- `-C probe-stack=call` — this compiler flag was removed/never stabilized
- Pinning to Rust 1.84 — too old for `edition = "2024"`
- Upgrading wasmer — the issue is in how wasmer_vm was compiled

## Notes

- The stub is safe: it simply returns immediately
- The actual stack probing is handled inline by the compiler
- This works with any Rust version (1.85+)
- Only needed on Linux (macOS handles it differently)
