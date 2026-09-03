#!/usr/bin/env bash
# Bootstrap the Conway colony host (Linux / WSL Ubuntu).
# - installs Node 22 via fnm if missing
# - clones (or updates) the p01-solana fork of Conway Automaton
# - builds it
# - prints what to fund
#
# Usage: bash agents/conway/scripts/bootstrap.sh [fork-source] [target-dir]
#   fork-source  git URL or local path of the fork (default: /mnt/c/Users/amirr/automaton)
#   target-dir   where to install (default: ~/automaton)
set -euo pipefail

SRC="${1:-/mnt/c/Users/amirr/automaton}"
DST="${2:-$HOME/automaton}"
BRANCH="${BRANCH:-p01-solana}"

if ! command -v node >/dev/null 2>&1; then
  echo "[bootstrap] installing fnm + Node 22"
  curl -fsSL https://fnm.vercel.app/install | bash >/dev/null
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
  fnm install 22 >/dev/null
  fnm default 22
fi
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env 2>/dev/null || true)"
echo "[bootstrap] node $(node --version)"

if ! command -v git >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y -qq git build-essential python3
fi

if [ -d "$DST/.git" ]; then
  echo "[bootstrap] updating $DST"
  git -C "$DST" fetch -q origin "$BRANCH" && git -C "$DST" checkout -q "$BRANCH" && git -C "$DST" pull -q --ff-only origin "$BRANCH" || true
else
  echo "[bootstrap] cloning $SRC ($BRANCH) → $DST"
  git clone -q -b "$BRANCH" "$SRC" "$DST"
fi

cd "$DST"
npm install --no-audit --no-fund 2>&1 | tail -1
npm run build 2>&1 | tail -1
test -f dist/index.js && test -f dist/economy/index.js && echo "[bootstrap] build OK: $DST/dist"

cat <<EOF

Next:
  1. cp agents/conway/.env.example agents/conway/.env  and fill ANTHROPIC_API_KEY + SOLANA_RPC_URL
  2. edit agents/conway/colony.json  (automatonRepo = $DST, cause, seed, funder)
  3. node agents/conway/scripts/supervisor.mjs once     # boots generation 1, prints the address to fund
  4. send USDC (and ~0.03 SOL for fees) to that address
  5. node agents/conway/scripts/supervisor.mjs start    # keep it running (tmux / systemd)
EOF
