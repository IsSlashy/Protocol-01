#!/bin/bash
# compile-circuit.sh — Compile a circom circuit to WASM and R1CS
#
# Usage: ./compile-circuit.sh <circuit.circom> [output_dir] [include_path]
#
# Prerequisites: circom >= 2.1.0
#
# Output files:
#   <output_dir>/<name>_js/<name>.wasm   — WASM witness generator
#   <output_dir>/<name>.r1cs             — Rank-1 constraint system

set -euo pipefail

CIRCUIT="${1:?Usage: $0 <circuit.circom> [output_dir] [include_path]}"
OUTPUT_DIR="${2:-build}"
INCLUDE="${3:-}"

NAME=$(basename "$CIRCUIT" .circom)

echo "=== Compiling circuit: $CIRCUIT ==="
echo "Output directory: $OUTPUT_DIR"

mkdir -p "$OUTPUT_DIR"

# Build include flags — search common locations for circomlib
INCLUDE_FLAGS=""
if [ -n "$INCLUDE" ]; then
  INCLUDE_FLAGS="-l $INCLUDE"
else
  # Auto-detect: check common node_modules locations
  CIRCUIT_DIR=$(dirname "$CIRCUIT")
  for candidate in \
    "node_modules" \
    "$CIRCUIT_DIR/node_modules" \
    "$CIRCUIT_DIR/../../node_modules" \
    "$CIRCUIT_DIR/../../../node_modules" \
    "$CIRCUIT_DIR/../../../../node_modules"; do
    if [ -d "$candidate/circomlib" ]; then
      INCLUDE_FLAGS="-l $candidate"
      echo "Found circomlib at: $candidate"
      break
    fi
  done
fi

circom "$CIRCUIT" \
  --wasm \
  --r1cs \
  -o "$OUTPUT_DIR" \
  $INCLUDE_FLAGS

WASM="$OUTPUT_DIR/${NAME}_js/${NAME}.wasm"
R1CS="$OUTPUT_DIR/${NAME}.r1cs"

echo ""
echo "=== Compilation complete ==="
if [ -f "$WASM" ]; then
  echo "  WASM: $WASM ($(wc -c < "$WASM") bytes)"
fi
if [ -f "$R1CS" ]; then
  echo "  R1CS: $R1CS ($(wc -c < "$R1CS") bytes)"
fi

# Show constraint count
if command -v snarkjs &> /dev/null && [ -f "$R1CS" ]; then
  echo ""
  npx snarkjs r1cs info "$R1CS"
fi
