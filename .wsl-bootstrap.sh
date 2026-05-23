#!/bin/bash
# WSL bootstrap for Solana SBF build — Protocol 01 Dublin handoff
# Source from /mnt/c/Users/amirr/Protocol-01/.wsl-bootstrap.sh via wsl bash
set -euxo pipefail

echo "=== [1/4] install apt deps ==="
DEBIAN_FRONTEND=noninteractive apt-get install -yq \
  build-essential curl pkg-config libudev-dev libssl-dev git ca-certificates

echo "=== [2/4] install rustup + stable toolchain (minimal) ==="
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | bash -s -- -y --default-toolchain stable --profile minimal

source "$HOME/.cargo/env"
rustc --version
cargo --version

echo "=== [3/4] install Anza CLI v2.2.14 ==="
sh -c "$(curl -sSfL https://release.anza.xyz/v2.2.14/install)"

# Append solana bin to PATH for future shells.
ANZA_BIN="$HOME/.local/share/solana/install/active_release/bin"
if ! grep -q 'solana/install/active_release/bin' "$HOME/.bashrc"; then
  echo "export PATH=\"$ANZA_BIN:\$PATH\"" >> "$HOME/.bashrc"
fi

echo "=== [4/4] verify ==="
"$ANZA_BIN/solana" --version
"$ANZA_BIN/cargo-build-sbf" --version
echo "ALL_GREEN"
