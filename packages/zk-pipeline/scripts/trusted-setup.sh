#!/bin/bash
# trusted-setup.sh — Run trusted setup (Powers of Tau + Phase 2)
#
# Usage: ./trusted-setup.sh <path_prefix> [ptau_file]
#
# The path_prefix is the R1CS file path without extension.
# Examples:
#   ./trusted-setup.sh circuit                        -> build/circuit.r1cs -> keys/
#   ./trusted-setup.sh examples/app/build/circuit     -> examples/app/build/circuit.r1cs -> examples/app/keys/
#
# Prerequisites: snarkjs >= 0.7.0
#
# This generates:
#   <keys_dir>/<name>_final.zkey       — Proving key
#   <keys_dir>/<name>_vk.json          — Verification key (JSON)
#
# For production, use a community ceremony PTAU file.
# For development, this script generates a local one.

set -euo pipefail

PATH_PREFIX="${1:?Usage: $0 <path_prefix> [ptau_file]}"
PTAU="${2:-}"

# Derive paths from prefix
BASENAME=$(basename "$PATH_PREFIX")
PREFIX_DIR=$(dirname "$PATH_PREFIX")

# Support both simple name ("circuit" -> build/) and full path
if [[ "$PATH_PREFIX" == */* ]]; then
  R1CS="${PATH_PREFIX}.r1cs"
  KEYS_DIR="$(cd "$PREFIX_DIR/.." 2>/dev/null && pwd)/keys"
  # Fallback if can't resolve parent
  if [ ! -d "$(dirname "$KEYS_DIR")" ]; then
    KEYS_DIR="${PREFIX_DIR}/../keys"
  fi
else
  R1CS="build/${BASENAME}.r1cs"
  KEYS_DIR="keys"
fi

if [ ! -f "$R1CS" ]; then
  echo "Error: R1CS file not found: $R1CS"
  echo "Run compile-circuit.sh first."
  exit 1
fi

mkdir -p "$KEYS_DIR"

echo "=== Trusted Setup ==="
echo "  R1CS: $R1CS"
echo "  Keys: $KEYS_DIR"

# Use provided PTAU or generate a development one
if [ -z "$PTAU" ]; then
  echo ""
  echo "=== Generating development PTAU (pot14) ==="
  echo "WARNING: For production, use a community ceremony PTAU file!"
  PTAU="$KEYS_DIR/dev_pot14.ptau"
  if [ ! -f "$PTAU" ]; then
    npx snarkjs powersoftau new bn128 14 "$KEYS_DIR/pot14_0000.ptau" -v
    npx snarkjs powersoftau contribute "$KEYS_DIR/pot14_0000.ptau" "$KEYS_DIR/pot14_0001.ptau" --name="dev" -v -e="random entropy"
    npx snarkjs powersoftau prepare phase2 "$KEYS_DIR/pot14_0001.ptau" "$PTAU" -v
    rm -f "$KEYS_DIR/pot14_0000.ptau" "$KEYS_DIR/pot14_0001.ptau"
  fi
fi

echo ""
echo "=== Phase 2: Circuit-specific setup ==="
echo "Using PTAU: $PTAU"

# Phase 2 setup
npx snarkjs groth16 setup "$R1CS" "$PTAU" "$KEYS_DIR/${BASENAME}_0000.zkey"

# Contribute to Phase 2
npx snarkjs zkey contribute "$KEYS_DIR/${BASENAME}_0000.zkey" "$KEYS_DIR/${BASENAME}_final.zkey" \
  --name="dev contribution" -v -e="more random entropy"

# Export verification key
npx snarkjs zkey export verificationkey "$KEYS_DIR/${BASENAME}_final.zkey" "$KEYS_DIR/${BASENAME}_vk.json"

# Clean up intermediate files
rm -f "$KEYS_DIR/${BASENAME}_0000.zkey"

echo ""
echo "=== Trusted setup complete ==="
echo "  Proving key: $KEYS_DIR/${BASENAME}_final.zkey"
echo "  Verification key: $KEYS_DIR/${BASENAME}_vk.json"
echo ""
echo "IMPORTANT: For production use, run multiple contribution rounds"
echo "and verify the final zkey with: snarkjs zkey verify $R1CS $PTAU $KEYS_DIR/${BASENAME}_final.zkey"
