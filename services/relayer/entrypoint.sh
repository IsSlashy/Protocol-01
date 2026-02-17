#!/bin/sh
set -e

echo "=== Protocol 01 Relayer + Rust Prover ==="

# Start Rust prover in background
echo "Starting Rust Groth16 prover on port ${PROVER_PORT:-3001}..."
p01-prover &
PROVER_PID=$!

# Wait for prover to become ready (up to 30s for zkey loading)
echo "Waiting for prover to load circuit artifacts..."
RETRIES=0
MAX_RETRIES=30
while [ $RETRIES -lt $MAX_RETRIES ]; do
  if curl -sf "http://localhost:${PROVER_PORT:-3001}/health" > /dev/null 2>&1; then
    echo "Rust prover is ready!"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 1
done

if [ $RETRIES -eq $MAX_RETRIES ]; then
  echo "WARNING: Rust prover did not become ready in ${MAX_RETRIES}s. Relayer will use snarkjs fallback."
fi

# Start Node.js relayer (foreground)
echo "Starting Node.js relayer on port ${PORT:-3000}..."
exec node dist/index.js
