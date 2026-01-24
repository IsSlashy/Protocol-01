#!/bin/bash
set -e

# Source cargo environment
source ~/.cargo/env 2>/dev/null || true

# Add Solana to PATH
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:/usr/bin:/bin"

echo "=== Building zk_shielded ==="
echo "Solana: $(solana --version)"
echo "Cargo: $(cargo --version)"

# Navigate to program
cd "/mnt/p/Protocol 01/programs/zk_shielded"

# Build with explicit output directory
echo ""
echo "Building..."
cargo build-sbf --sbf-out-dir "/mnt/p/Protocol 01/target/deploy"

echo ""
echo "=== Build Complete ==="

# Verify output
if [ -f "/mnt/p/Protocol 01/target/deploy/zk_shielded.so" ]; then
    ls -lh "/mnt/p/Protocol 01/target/deploy/zk_shielded.so"
    echo "Build successful!"
else
    echo "ERROR: zk_shielded.so not found!"
    exit 1
fi
