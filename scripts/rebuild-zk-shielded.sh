#!/bin/bash
# Rebuild and deploy zk_shielded program with Poseidon-based Merkle tree
# Run this script with elevated privileges (admin/sudo) or on Linux/macOS/WSL

set -e

# Navigate to project root
cd "$(dirname "$0")/.."

# Set up Solana paths
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "==================================="
echo "ZK Shielded Program Rebuild Script"
echo "==================================="

# Check Solana installation
echo "Checking Solana installation..."
solana --version

# Build the program
echo ""
echo "Building zk_shielded program for SBF target..."
cd programs/zk_shielded
cargo build-sbf

# Copy to target/deploy
echo ""
echo "Copying built program to target/deploy..."
cp ../../target/sbf-solana-solana/release/zk_shielded.so ../../target/deploy/zk_shielded.so

# Deploy to devnet
echo ""
echo "Deploying to devnet..."
cd ../..
solana config set --url devnet
solana program deploy target/deploy/zk_shielded.so --program-id target/deploy/zk_shielded-keypair.json

echo ""
echo "==================================="
echo "Deployment complete!"
echo "==================================="
echo "Program ID: 8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY"
echo ""
echo "To test the full transfer flow, run:"
echo "  pnpm run test:zk-e2e"
