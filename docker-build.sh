#!/bin/bash
# Build and deploy Anchor program using Docker

# Pull the Solana/Anchor build image
docker pull projectserum/build:v0.30.1

# Run the build
docker run --rm -v $(pwd):/workdir -w /workdir projectserum/build:v0.30.1 \
  bash -c "cd programs/stream && anchor build"

echo "Build complete! Check target/deploy/ for the compiled program"
echo ""
echo "To deploy manually:"
echo "  solana program deploy target/deploy/p01_stream.so --program-id <KEYPAIR>"
