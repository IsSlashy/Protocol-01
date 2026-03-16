#!/bin/sh
set -e

# ============================================================================
# P01 Privacy Relay — Entrypoint (Railway / single-container mode)
# ============================================================================
# Starts Tor SOCKS5 proxy in background, waits for it, then launches relay.
# Tor runs as the 'tor' user, relay runs as 'p01' (non-root).
# ============================================================================

# Start Tor as the tor user (background)
su-exec tor tor -f /etc/tor/torrc &
TOR_PID=$!

# Wait for Tor SOCKS proxy to be ready (max 60s)
echo "[P01] Starting Tor SOCKS5 proxy..."
READY=0
for i in $(seq 1 60); do
  if nc -z 127.0.0.1 9050 2>/dev/null; then
    echo "[P01] Tor SOCKS5 ready (${i}s)"
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" = "0" ]; then
  echo "[P01] WARNING: Tor not ready after 60s — relay starts without Tor"
  echo "[P01] RPC calls will go directly to upstream (reduced privacy)"
else
  export TOR_SOCKS_PROXY=socks5h://127.0.0.1:9050
fi

# Trap shutdown signals — kill Tor when relay exits
cleanup() {
  echo "[P01] Shutting down..."
  kill $TOR_PID 2>/dev/null || true
  wait $TOR_PID 2>/dev/null || true
}
trap cleanup INT TERM

# Start relay as p01 user
echo "[P01] Starting Bundle Engine..."
exec su-exec p01 node dist/server.js
