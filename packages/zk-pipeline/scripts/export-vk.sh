#!/bin/bash
# export-vk.sh — Export verification key in various formats
#
# Usage: ./export-vk.sh <path_prefix>
#
# The path_prefix is the zkey file path without _final.zkey suffix.
# Examples:
#   ./export-vk.sh circuit                      -> keys/circuit_final.zkey
#   ./export-vk.sh examples/app/keys/circuit    -> examples/app/keys/circuit_final.zkey
#
# Outputs:
#   <dir>/<name>_vk.json       — JSON format (for snarkjs verification)

set -euo pipefail

PATH_PREFIX="${1:?Usage: $0 <path_prefix>}"
BASENAME=$(basename "$PATH_PREFIX")

# Support both simple name and full path
if [[ "$PATH_PREFIX" == */* ]]; then
  KEYS_DIR=$(dirname "$PATH_PREFIX")
else
  KEYS_DIR="keys"
fi

ZKEY="$KEYS_DIR/${BASENAME}_final.zkey"

if [ ! -f "$ZKEY" ]; then
  echo "Error: zkey not found: $ZKEY"
  echo "Run trusted-setup.sh first."
  exit 1
fi

echo "=== Exporting verification key for: $BASENAME ==="

# Export JSON VK
npx snarkjs zkey export verificationkey "$ZKEY" "$KEYS_DIR/${BASENAME}_vk.json"
echo "  JSON: $KEYS_DIR/${BASENAME}_vk.json"

echo ""
echo "=== VK exported ==="
echo ""
echo "To convert JSON VK to binary format for Solana:"
echo "  See p01-solana-verifier crate documentation"
echo "  Binary format: alpha_g1(64) | beta_g2(128) | gamma_g2(128) | delta_g2(128) | ic_count(4) | IC[](64*N)"
