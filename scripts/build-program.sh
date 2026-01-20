#!/bin/bash
# Build the Anchor program with proper Cargo.lock handling
# Run this from the project root in WSL

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_ROOT=$(pwd)
PROGRAM_DIR="$PROJECT_ROOT/programs/stream"

echo "=== Building P01 Stream Program ==="
echo ""

# Step 1: Clean old Cargo.lock if it exists (to avoid v4 format issues)
if [ -f "$PROGRAM_DIR/Cargo.lock" ]; then
    echo -e "${YELLOW}Removing old Cargo.lock (may have incompatible v4 format)${NC}"
    rm "$PROGRAM_DIR/Cargo.lock"
fi

if [ -f "$PROJECT_ROOT/Cargo.lock" ]; then
    echo -e "${YELLOW}Removing root Cargo.lock${NC}"
    rm "$PROJECT_ROOT/Cargo.lock"
fi

# Step 2: Update Cargo.toml to pin compatible versions
echo -e "${YELLOW}Checking Cargo.toml...${NC}"
cat > "$PROGRAM_DIR/Cargo.toml" << 'EOF'
[package]
name = "p01-stream"
version = "0.1.0"
description = "Protocol 01 Stream Payments - Recurring subscription payments on Solana"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "p01_stream"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]

[dependencies]
anchor-lang = "0.30.1"
anchor-spl = "0.30.1"
EOF

echo -e "${GREEN}✓ Cargo.toml updated with Anchor 0.30.1${NC}"

# Step 3: Update the declare_id in lib.rs if needed
echo -e "${YELLOW}Syncing program keys...${NC}"
cd "$PROJECT_ROOT"

# Generate new keypair if needed
if [ ! -f "target/deploy/p01_stream-keypair.json" ]; then
    mkdir -p target/deploy
    solana-keygen new --no-bip39-passphrase --silent --outfile target/deploy/p01_stream-keypair.json
    echo -e "${GREEN}✓ Generated new program keypair${NC}"
fi

# Get the program ID
PROGRAM_ID=$(solana-keygen pubkey target/deploy/p01_stream-keypair.json)
echo -e "${GREEN}Program ID: $PROGRAM_ID${NC}"

# Update lib.rs with correct program ID
sed -i "s/declare_id!(\"[^\"]*\")/declare_id!(\"$PROGRAM_ID\")/" "$PROGRAM_DIR/src/lib.rs"
echo -e "${GREEN}✓ Updated lib.rs with program ID${NC}"

# Step 4: Build
echo ""
echo -e "${YELLOW}Building program...${NC}"
anchor build

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}=== Build Successful ===${NC}"
    echo ""
    echo "Program ID: $PROGRAM_ID"
    echo "Binary: target/deploy/p01_stream.so"
    echo ""
    echo "To deploy:"
    echo "  anchor deploy --provider.cluster devnet"
    echo ""
    echo "Or manually:"
    echo "  solana program deploy target/deploy/p01_stream.so"
else
    echo -e "${RED}Build failed!${NC}"
    exit 1
fi
