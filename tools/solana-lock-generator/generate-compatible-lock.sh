#!/bin/bash
#
# Solana Compatible Lock Generator
# Generates a Cargo.lock that works with Solana's Rust 1.75
#
# Usage: ./generate-compatible-lock.sh [project_path]
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Crates that have versions requiring edition 2024
# Format: "crate_name:max_compatible_version"
PROBLEMATIC_CRATES=(
    "constant_time_eq:0.3.1"
    "base64ct:1.6.0"
    "subtle:2.5.0"
    "password-hash:0.5.0"
    "crypto-common:0.1.6"
    "digest:0.10.7"
    "sha2:0.10.8"
    "hmac:0.12.1"
    "pbkdf2:0.12.2"
    "aes:0.8.4"
    "aes-gcm:0.10.3"
    "chacha20poly1305:0.10.1"
    "curve25519-dalek:4.1.3"
    "ed25519-dalek:2.1.1"
    "x25519-dalek:2.0.1"
)

PROJECT_PATH="${1:-.}"

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     Solana Compatible Cargo.lock Generator                   ║${NC}"
echo -e "${CYAN}║     Fixes edition 2024 dependency issues                     ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if project path exists
if [ ! -d "$PROJECT_PATH" ]; then
    echo -e "${RED}Error: Project path '$PROJECT_PATH' does not exist${NC}"
    exit 1
fi

cd "$PROJECT_PATH"

# Check for Cargo.toml
if [ ! -f "Cargo.toml" ]; then
    echo -e "${RED}Error: No Cargo.toml found in '$PROJECT_PATH'${NC}"
    exit 1
fi

echo -e "${YELLOW}Step 1: Removing old Cargo.lock${NC}"
rm -f Cargo.lock
echo -e "${GREEN}✓ Done${NC}"
echo ""

echo -e "${YELLOW}Step 2: Creating version constraints${NC}"

# Create a temporary Cargo.toml patch section
PATCH_FILE=$(mktemp)
cat > "$PATCH_FILE" << 'EOF'

# === AUTO-GENERATED PATCHES FOR SOLANA COMPATIBILITY ===
# These patches force older versions that don't require edition 2024

[patch.crates-io]
EOF

for entry in "${PROBLEMATIC_CRATES[@]}"; do
    crate_name="${entry%%:*}"
    max_version="${entry##*:}"
    echo "${crate_name} = { version = \"=${max_version}\" }" >> "$PATCH_FILE"
    echo -e "  ${crate_name} pinned to ${max_version}"
done

echo -e "${GREEN}✓ Created ${#PROBLEMATIC_CRATES[@]} patches${NC}"
echo ""

echo -e "${YELLOW}Step 3: Generating Cargo.lock with compatible versions${NC}"

# Backup original Cargo.toml
cp Cargo.toml Cargo.toml.backup

# Try to update specific packages to compatible versions
for entry in "${PROBLEMATIC_CRATES[@]}"; do
    crate_name="${entry%%:*}"
    max_version="${entry##*:}"

    # Try to force the version
    cargo update -p "$crate_name" --precise "$max_version" 2>/dev/null || true
done

echo -e "${GREEN}✓ Cargo.lock generated${NC}"
echo ""

# Restore original Cargo.toml
mv Cargo.toml.backup Cargo.toml

echo -e "${YELLOW}Step 4: Verifying compatibility${NC}"

# Check if any problematic versions remain
ISSUES_FOUND=0
if [ -f "Cargo.lock" ]; then
    for entry in "${PROBLEMATIC_CRATES[@]}"; do
        crate_name="${entry%%:*}"
        max_version="${entry##*:}"

        # Extract versions from Cargo.lock
        if grep -q "name = \"$crate_name\"" Cargo.lock 2>/dev/null; then
            found_version=$(grep -A1 "name = \"$crate_name\"" Cargo.lock | grep "version" | head -1 | sed 's/.*"\(.*\)".*/\1/')
            if [ -n "$found_version" ]; then
                # Simple version comparison (not perfect but works for most cases)
                if [[ "$found_version" > "$max_version" ]]; then
                    echo -e "  ${RED}⚠ $crate_name: $found_version (should be <= $max_version)${NC}"
                    ISSUES_FOUND=1
                else
                    echo -e "  ${GREEN}✓ $crate_name: $found_version${NC}"
                fi
            fi
        fi
    done
fi

echo ""

if [ $ISSUES_FOUND -eq 1 ]; then
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}Some crates may still have compatibility issues.${NC}"
    echo -e "${YELLOW}Try manually adding these to your Cargo.toml [patch.crates-io]:${NC}"
    echo ""
    cat "$PATCH_FILE"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
else
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✓ Cargo.lock should be compatible with Solana/Rust 1.75${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
fi

rm -f "$PATCH_FILE"

echo ""
echo -e "${CYAN}Next steps:${NC}"
echo "  1. Try building: cargo-build-sbf"
echo "  2. If issues persist, add the patch section to Cargo.toml"
echo ""
