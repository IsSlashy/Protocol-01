#!/bin/bash
# Build and deploy zk_shielded program using Docker
set -e

echo "============================================"
echo "Building zk_shielded program with Docker"
echo "============================================"

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH"
    exit 1
fi

# Navigate to project root
cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

echo "Project root: $PROJECT_ROOT"

# Pull the Anchor build image
echo ""
echo "Pulling Anchor build image..."
docker pull projectserum/build:v0.30.1

# Build the program
echo ""
echo "Building zk_shielded program..."
docker run --rm \
    -v "$PROJECT_ROOT:/workdir" \
    -w /workdir \
    projectserum/build:v0.30.1 \
    bash -c "
        cd programs/zk_shielded && \
        cargo build-sbf --manifest-path Cargo.toml && \
        echo '' && \
        echo 'Build complete!' && \
        ls -la /workdir/target/sbf-solana-solana/release/zk_shielded.so 2>/dev/null || \
        ls -la /workdir/target/deploy/zk_shielded.so 2>/dev/null || \
        echo 'Searching for output...' && find /workdir/target -name 'zk_shielded.so' 2>/dev/null
    "

# Copy to target/deploy if needed
echo ""
echo "Checking output..."
if [ -f "target/sbf-solana-solana/release/zk_shielded.so" ]; then
    mkdir -p target/deploy
    cp target/sbf-solana-solana/release/zk_shielded.so target/deploy/
    echo "Copied to target/deploy/zk_shielded.so"
fi

if [ -f "target/deploy/zk_shielded.so" ]; then
    echo ""
    echo "============================================"
    echo "Build successful!"
    echo "============================================"
    echo ""
    echo "Program binary: target/deploy/zk_shielded.so"
    echo "Size: $(ls -lh target/deploy/zk_shielded.so | awk '{print $5}')"
    echo ""
    echo "To deploy to devnet, run:"
    echo "  solana config set --url devnet"
    echo "  solana program deploy target/deploy/zk_shielded.so --program-id 8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY"
    echo ""
    echo "After deployment, initialize the SOL pool:"
    echo "  npx ts-node scripts/init-sol-pool.ts"
else
    echo "Error: Build output not found"
    exit 1
fi
