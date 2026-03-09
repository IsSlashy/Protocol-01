#!/usr/bin/env bash
# =============================================================================
# Build and deploy p01_arcium to Solana devnet via Arcium CLI
# Run from WSL2: bash /mnt/d/Protocol-01/scripts/build-and-deploy-arcium.sh
# =============================================================================
set -euo pipefail

PROJECT_DIR="/mnt/d/Protocol-01/programs/p01_arcium"
ROOT_DIR="/mnt/d/Protocol-01"
RPC_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
KEYPAIR="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
CLUSTER_OFFSET=456

echo "=== Building p01_arcium ==="
cd "$PROJECT_DIR"

# Step 1: Build Arcis circuits + Anchor program
echo "[1/4] Building circuits + program..."
arcium build
echo "  Build complete."

# Step 2: Check compiled circuits exist
echo "[2/4] Verifying compiled circuits..."
for circuit in balance_audit finalize_audit private_vote finalize_tally \
               nullifier_commit private_lookup register_viewing_key \
               stealth_scan_single threshold_decrypt; do
  if [ -f "build/${circuit}.arcis" ]; then
    echo "  ✓ ${circuit}.arcis"
  else
    echo "  ✗ MISSING: ${circuit}.arcis"
    exit 1
  fi
done

# Step 3: Deploy to devnet
echo "[3/4] Deploying to devnet..."
arcium deploy \
  --cluster-offset "$CLUSTER_OFFSET" \
  --recovery-set-size 4 \
  --keypair-path "$KEYPAIR" \
  --rpc-url "$RPC_URL"

# Step 4: Extract program ID
PROGRAM_ID=$(solana program show --keypair "$KEYPAIR" --url "$RPC_URL" \
  --programs | grep "p01_arcium" | awk '{print $1}' || true)

if [ -z "$PROGRAM_ID" ]; then
  echo ""
  echo "Deploy complete. Find your program ID in the output above."
  echo "Then update it in these files:"
else
  echo ""
  echo "=== Deployed: $PROGRAM_ID ==="
  echo ""
  echo "Update program ID in:"
fi

echo "  - programs/p01_arcium/src/lib.rs → declare_id!(\"$PROGRAM_ID\")"
echo "  - packages/arcium-sdk/src/client.ts → P01_ARCIUM_PROGRAM_ID"
echo "  - Anchor.toml → p01_arcium"
echo "  - tests/p01-arcium.test.ts → PROGRAM_ID"
