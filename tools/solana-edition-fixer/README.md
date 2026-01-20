# Solana Edition 2024 Fixer

A comprehensive tool to fix Rust **edition 2024** compatibility issues for Solana/Anchor projects.

## The Problem

Starting in late 2024, many popular Rust crates began publishing new versions that require `edition = "2024"`. However:

- **Solana platform-tools** (v1.42 - v1.52) bundle **Cargo 1.84.x**
- **Edition 2024** support requires **Cargo 1.85+**
- This creates a dependency resolution conflict that breaks builds

When you try to build a Solana program, you may see errors like:

```
error: failed to download `constant_time_eq v0.4.2`
  the feature `edition2024` is required
  this Cargo does not support nightly features
```

## The Solution

This tool automatically downgrades affected crates to their last compatible versions (before edition 2024 was required).

## Quick Start

### Option 1: Shell Script (Linux/WSL/macOS)

```bash
# Make executable
chmod +x fix-edition2024.sh

# Run in your project directory
./fix-edition2024.sh

# Or specify a path
./fix-edition2024.sh /path/to/your/solana/project
```

### Option 2: Node.js Tool

```bash
# Check for issues (dry run)
node solana-edition-fixer.js

# Apply fixes automatically
node solana-edition-fixer.js --fix

# Check a specific project
node solana-edition-fixer.js /path/to/project --fix

# Output as JSON (for CI/CD)
node solana-edition-fixer.js --json
```

### Option 3: Manual Fix

Add to your `Cargo.toml`:

```toml
[package]
# ... your package info
rust-version = "1.75"  # Tell Cargo your minimum Rust version

[patch.crates-io]
constant_time_eq = "=0.3.1"
base64ct = "=1.6.0"
subtle = "=2.5.0"
# ... add more as needed from the database
```

Create `.cargo/config.toml`:

```toml
[resolver]
incompatible-rust-versions = "fallback"

[net]
git-fetch-with-cli = true

[registries.crates-io]
protocol = "sparse"
```

## Affected Crates Database

See `edition2024-database.json` for the complete list. Key crates include:

| Crate | Max Compatible | First Incompatible |
|-------|---------------|-------------------|
| `constant_time_eq` | 0.3.1 | 0.4.0 |
| `base64ct` | 1.6.0 | 1.7.0 |
| `subtle` | 2.5.0 | 2.6.0 |
| `zeroize` | 1.7.0 | 1.8.0 |
| `crypto-common` | 0.1.6 | 0.2.0 |
| `blake3` | 1.5.0 | 1.6.0 |
| `wit-bindgen` | 0.24.0 | 0.25.0 |
| `yoke` | 0.7.4 | 0.8.0 |

## How It Works

1. **Parses `Cargo.lock`** to find all dependencies
2. **Compares versions** against the known-incompatible database
3. **Runs `cargo update`** with `--precise` flags to downgrade
4. **Verifies** the resulting `Cargo.lock` is compatible

## MSRV-Aware Resolver

For Cargo 1.84+, you can use the MSRV-aware resolver:

```toml
# .cargo/config.toml
[resolver]
incompatible-rust-versions = "fallback"
```

This tells Cargo to automatically prefer crate versions compatible with your `rust-version`.

## Contributing

Found a new problematic crate? Add it to `edition2024-database.json`:

```json
{
  "crate_name": {
    "maxCompatible": "X.Y.Z",
    "firstIncompatible": "X.Y.W",
    "reason": "X.Y.W+ requires edition 2024",
    "usedBy": ["parent_crate1", "parent_crate2"]
  }
}
```

## Why Not Just Upgrade?

Solana's toolchain is intentionally conservative about Rust versions to ensure:
- Deterministic builds across all validators
- BPF/SBF compatibility
- Security audit consistency

Until Solana's platform-tools upgrade to Cargo 1.85+, this workaround is necessary.

## License

MIT - Created by **Protocol 01 / Volta Team**

## Related Resources

- [Solana Platform Tools](https://github.com/solana-labs/platform-tools)
- [Cargo MSRV-aware Resolver RFC](https://github.com/rust-lang/cargo/issues/9930)
- [Rust Edition 2024](https://doc.rust-lang.org/edition-guide/rust-2024/)
