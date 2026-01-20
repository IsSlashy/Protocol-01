#!/bin/bash
# Setup script for Solana/Anchor development on WSL
# Run this in WSL Ubuntu

set -e

echo "=== Protocol 01 - Solana Build Environment Setup ==="
echo ""

# Versions that work together
RUST_VERSION="1.75.0"
SOLANA_VERSION="1.18.17"
ANCHOR_VERSION="0.30.1"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Step 1: Installing Rust ${RUST_VERSION}${NC}"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain ${RUST_VERSION}
source "$HOME/.cargo/env"
rustup default ${RUST_VERSION}
rustc --version

echo -e "${GREEN}✓ Rust installed${NC}"
echo ""

echo -e "${YELLOW}Step 2: Installing Solana CLI ${SOLANA_VERSION}${NC}"
sh -c "$(curl -sSfL https://release.solana.com/v${SOLANA_VERSION}/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
solana --version

echo -e "${GREEN}✓ Solana CLI installed${NC}"
echo ""

echo -e "${YELLOW}Step 3: Installing Anchor ${ANCHOR_VERSION}${NC}"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install ${ANCHOR_VERSION}
avm use ${ANCHOR_VERSION}
export PATH="$HOME/.avm/bin:$PATH"
echo 'export PATH="$HOME/.avm/bin:$PATH"' >> ~/.bashrc
anchor --version

echo -e "${GREEN}✓ Anchor installed${NC}"
echo ""

echo -e "${YELLOW}Step 4: Configuring Solana for devnet${NC}"
solana config set --url devnet
solana-keygen new --no-bip39-passphrase --silent --outfile ~/.config/solana/id.json 2>/dev/null || true
solana config set --keypair ~/.config/solana/id.json
echo -e "${GREEN}✓ Solana configured${NC}"
echo ""

echo -e "${YELLOW}Step 5: Requesting devnet airdrop${NC}"
solana airdrop 2 || echo "Airdrop failed - use https://faucet.solana.com"
echo ""

echo "=== Setup Complete ==="
echo ""
echo "Versions installed:"
echo "  Rust:   $(rustc --version)"
echo "  Solana: $(solana --version)"
echo "  Anchor: $(anchor --version)"
echo ""
echo "Next steps:"
echo "  1. cd to your project"
echo "  2. Run: ./scripts/build-program.sh"
