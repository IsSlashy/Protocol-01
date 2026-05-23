#!/bin/bash
# Build + deploy p01_quantum_wallet to devnet from WSL.
# Pre-req: .wsl-bootstrap.sh has been run and printed ALL_GREEN.
set -euxo pipefail

REPO="/mnt/c/Users/amirr/Protocol-01"
KEYPAIR_USER="/mnt/c/Users/amirr/.config/solana/id.json"
PROGRAM_KP="$REPO/target/deploy/p01_quantum_wallet-keypair.json"

source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "=== [1/3] cargo-build-sbf ==="
cd "$REPO"
cargo-build-sbf --manifest-path programs/p01_quantum_wallet/Cargo.toml

ls -la target/deploy/p01_quantum_wallet.so

echo "=== [2/3] configure solana CLI ==="
solana config set --keypair "$KEYPAIR_USER" --url devnet
solana address
solana balance

echo "=== [3/3] deploy to devnet ==="
solana program deploy target/deploy/p01_quantum_wallet.so \
  --program-id "$PROGRAM_KP" \
  --commitment confirmed

echo "ALL_DEPLOYED"
