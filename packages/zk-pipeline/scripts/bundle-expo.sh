#!/bin/bash
# bundle-expo.sh — Bundle circuit assets for an Expo app
#
# Usage: ./bundle-expo.sh <circuit_name> <expo_assets_dir>
#
# Copies the WASM and zkey files to your Expo app's assets directory
# with names that Metro can bundle.

set -euo pipefail

NAME="${1:?Usage: $0 <circuit_name> <expo_assets_dir>}"
ASSETS_DIR="${2:?Usage: $0 <circuit_name> <expo_assets_dir>}"

WASM="build/${NAME}_js/${NAME}.wasm"
ZKEY="keys/${NAME}_final.zkey"

if [ ! -f "$WASM" ]; then echo "Error: WASM not found: $WASM"; exit 1; fi
if [ ! -f "$ZKEY" ]; then echo "Error: zkey not found: $ZKEY"; exit 1; fi

mkdir -p "$ASSETS_DIR"

cp "$WASM" "$ASSETS_DIR/${NAME}.wasm"
cp "$ZKEY" "$ASSETS_DIR/${NAME}_final.zkey"

echo "=== Bundled circuit assets ==="
echo "  WASM: $ASSETS_DIR/${NAME}.wasm ($(du -h "$WASM" | cut -f1))"
echo "  zkey: $ASSETS_DIR/${NAME}_final.zkey ($(du -h "$ZKEY" | cut -f1))"
echo ""
echo "In your React Native code:"
echo "  const wasmAsset = require('./${NAME}.wasm');"
echo "  const zkeyAsset = require('./${NAME}_final.zkey');"
echo ""
echo "Make sure .wasm and .zkey are in metro.config.js assetExts:"
echo "  resolver: { assetExts: [...defaults.assetExts, 'wasm', 'zkey'] }"
