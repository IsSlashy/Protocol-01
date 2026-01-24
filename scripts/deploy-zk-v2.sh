#!/bin/bash
set -e

# Source cargo environment
source ~/.cargo/env 2>/dev/null || true

# Add Solana to PATH
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "=== Deploying zk_shielded v2 to devnet ==="
echo "Solana: $(solana --version)"

cd "/mnt/p/Protocol 01"

# Check balance
echo ""
echo "Checking wallet balance..."
solana balance --url devnet

# Deploy
echo ""
echo "Deploying program..."
solana program deploy \
  --program-id target/deploy/zk_shielded_v2-keypair.json \
  target/deploy/zk_shielded.so \
  --url devnet \
  -v

echo ""
echo "=== Deployment Complete ==="
echo "Program ID: 8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY"
