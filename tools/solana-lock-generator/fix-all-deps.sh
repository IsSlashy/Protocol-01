#!/bin/bash
#
# Fix all edition 2024 dependencies for Solana compatibility
#

set -e

cd "/mnt/p/Specter Protocol"

echo "Downgrading all problematic dependencies..."

# List of crates to downgrade with their compatible versions
declare -A DOWNGRADES=(
    ["blake3"]="1.5.0"
    ["base64ct"]="1.6.0"
    ["constant_time_eq"]="0.3.1"
    ["wit-bindgen"]="0.24.0"
    ["wit-component"]="0.24.0"
    ["wasm-encoder"]="0.41.0"
    ["wasmparser"]="0.121.0"
    ["wit-parser"]="0.24.0"
    ["borsh"]="1.5.0"
    ["borsh-derive"]="1.5.0"
    ["yoke"]="0.7.4"
    ["zerofrom"]="0.1.4"
    ["zerovec"]="0.10.4"
)

for crate in "${!DOWNGRADES[@]}"; do
    version="${DOWNGRADES[$crate]}"
    echo "  Downgrading $crate to $version..."
    cargo update -p "$crate" --precise "$version" 2>/dev/null || echo "    (skipped - not in tree)"
done

echo ""
echo "Done! Try building now."
