#!/usr/bin/env bash
# Publishes the Round 3 wave of @protocol-01 packages to npm.
#
# Usage:
#   bash scripts/publish-wave.sh             publish missing packages
#   bash scripts/publish-wave.sh --dry-run   show what would happen, no publish
#
# Prerequisites:
#   - npm login as slashy_fx (or a publisher with @protocol-01 scope access)
#   - 2FA enabled; npm will prompt for a fresh OTP per package
#   - pnpm + node 22+ available
#
# Notes:
#   - privacy-sdk is intentionally excluded from this wave. Bump it manually
#     after reviewing any contractual surface change.
#   - Order matters: rpc-config and privacy-toolkit publish first because
#     downstream SDKs depend on them.

set -euo pipefail

DRY_RUN=false
case "${1:-}" in
  --dry-run|-n) DRY_RUN=true ;;
esac

# Wave definition: package_name:expected_version
PACKAGES=(
  "rpc-config:0.1.1"
  "privacy-toolkit:1.0.2"
  "stark-prover:0.1.0"
  "zk-sdk:1.0.0"
  "zkspl-sdk:0.1.2"
  "specter-sdk:0.2.0"
  "p01-js:0.3.0"
  "react-native-zk:2.0.0"
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Color helpers (no external deps)
red()    { printf '\033[31m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
bold()   { printf '\033[1m%s\033[0m'  "$*"; }

# -------------------------------------------------------------------------
# Step 1: Pre-flight — verify versions, skip what is already on npm.
# -------------------------------------------------------------------------
echo
echo "$(bold "Pre-flight: checking ${#PACKAGES[@]} packages")"
echo

TO_PUBLISH=()
for entry in "${PACKAGES[@]}"; do
  name="${entry%:*}"
  expected="${entry#*:}"
  pkg_path="packages/$name"

  if [[ ! -f "$pkg_path/package.json" ]]; then
    echo "  $(red "MISSING") @protocol-01/$name — $pkg_path/package.json not found"
    continue
  fi

  actual=$(node -p "require('./$pkg_path/package.json').version" 2>/dev/null || echo "unknown")
  if [[ "$actual" != "$expected" ]]; then
    echo "  $(yellow "SKIP")    @protocol-01/$name — local=$actual, expected=$expected (bump or amend wave)"
    continue
  fi

  remote=$(npm view "@protocol-01/$name" version 2>/dev/null || echo "")
  if [[ "$remote" == "$expected" ]]; then
    echo "  $(green "DONE")    @protocol-01/$name@$expected — already on npm"
    continue
  fi

  remote_label="${remote:-none}"
  echo "  $(bold "QUEUED")  @protocol-01/$name — local=$expected, remote=$remote_label"
  TO_PUBLISH+=("$entry")
done

echo

if [[ ${#TO_PUBLISH[@]} -eq 0 ]]; then
  echo "$(green "Nothing to publish.") The wave is already complete."
  exit 0
fi

if $DRY_RUN; then
  echo "$(yellow "Dry run") — exiting before build/publish."
  exit 0
fi

# -------------------------------------------------------------------------
# Step 2: Build the packages we are about to publish.
# -------------------------------------------------------------------------
echo "$(bold "Building ${#TO_PUBLISH[@]} package(s)...")"
echo
for entry in "${TO_PUBLISH[@]}"; do
  name="${entry%:*}"
  echo "  building @protocol-01/$name"
  pnpm --filter "@protocol-01/$name" build
done
echo
echo "$(green "Build complete.")"
echo

# -------------------------------------------------------------------------
# Step 3: Confirm + publish.
# -------------------------------------------------------------------------
echo "$(bold "About to publish:")"
for entry in "${TO_PUBLISH[@]}"; do
  echo "  @protocol-01/${entry%:*}@${entry#*:}"
done
echo
echo "  npm will prompt for a fresh OTP for every package (slashy_fx 2FA)."
echo "  Press $(bold "Enter") to continue or $(bold "Ctrl-C") to abort."
read -r _

for entry in "${TO_PUBLISH[@]}"; do
  name="${entry%:*}"
  expected="${entry#*:}"
  echo
  echo "$(bold "==> Publishing @protocol-01/$name@$expected")"
  ( cd "packages/$name" && npm publish --access public )
  echo "$(green "==> Published @protocol-01/$name@$expected")"
done

echo
echo "$(green "Wave complete.") Verify with:"
for entry in "${TO_PUBLISH[@]}"; do
  echo "  npm view @protocol-01/${entry%:*} version"
done
