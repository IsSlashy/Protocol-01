#!/bin/bash
set -e

# Setup environment
source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/solana-release/bin:$PATH"

echo "=== Building zk_shielded for Solana BPF ==="
echo "Solana version: $(solana --version)"
echo "Rust version: $(rustc --version)"

# Navigate to program directory
cd "/mnt/p/Protocol 01/programs/zk_shielded"

# Build
echo ""
echo "Building..."
cargo build-sbf

echo ""
echo "=== Build Complete ==="
ls -la "/mnt/p/Protocol 01/target/deploy/zk_shielded.so" 2>/dev/null || echo "Checking sbf output..."
ls -la "/mnt/p/Protocol 01/target/sbf-solana-solana/release/zk_shielded.so" 2>/dev/null || true
