#!/usr/bin/env bash
# =============================================================================
# Protocol 01 × Arcium — WSL2 Setup Script
# Run this inside WSL2 Ubuntu after installing it.
# =============================================================================
set -euo pipefail

echo "=== Protocol 01 × Arcium WSL2 Setup ==="
echo ""

# 1. System dependencies
echo "[1/6] Installing system dependencies..."
sudo apt-get update -y
sudo apt-get install -y \
  pkg-config build-essential libudev-dev libssl-dev \
  curl git docker.io docker-compose

# 2. Add user to docker group (avoid sudo docker)
echo "[2/6] Configuring Docker..."
sudo usermod -aG docker "$USER"
sudo service docker start || true

# 3. Install Rust 1.89.0 (Arcium requirement)
echo "[3/6] Installing Rust 1.89.0..."
if ! command -v rustup &>/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
rustup install 1.89.0
rustup default 1.89.0
echo "  Rust: $(rustc --version)"

# 4. Install Solana CLI 2.3.0 (Arcium requirement)
echo "[4/6] Installing Solana CLI 2.3.0..."
if ! command -v solana &>/dev/null; then
  sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.0/install)"
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi
echo "  Solana: $(solana --version)"

# 5. Install Anchor 0.32.1
echo "[5/6] Installing Anchor CLI 0.32.1..."
if ! command -v anchor &>/dev/null; then
  cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
  avm install 0.32.1
  avm use 0.32.1
fi
echo "  Anchor: $(anchor --version)"

# 6. Install Arcium CLI
echo "[6/6] Installing Arcium CLI..."
curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ | bash
source "$HOME/.bashrc" 2>/dev/null || true
export PATH="$HOME/.arcium/bin:$PATH"
arcup install
echo "  Arcium: $(arcium --version)"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. cd /mnt/d/Protocol-01"
echo "  2. cd programs/p01_arcium"
echo "  3. arcium build"
echo "  4. arcium deploy --cluster-offset 456 --recovery-set-size 4 --keypair-path ~/.config/solana/id.json --rpc-url https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
echo ""
echo "After deploy, update the program ID in:"
echo "  - programs/p01_arcium/src/lib.rs (declare_id!)"
echo "  - packages/arcium-sdk/src/client.ts (P01_ARCIUM_PROGRAM_ID)"
echo "  - Anchor.toml (p01_arcium)"
echo "  - tests/p01-arcium.test.ts (PROGRAM_ID)"
