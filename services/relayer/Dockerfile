# ZK Prover Relayer Service
# Multi-stage build: Rust native prover + Node.js relayer
#
# Build from repo root:
#   docker build -f services/relayer/Dockerfile -t p01-relayer .

# =============================================================================
# Stage 1: Build Rust native Groth16 prover
# =============================================================================
FROM rust:1.84-slim-bookworm AS rust-builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy prover source
COPY services/prover/Cargo.toml services/prover/Cargo.lock* ./
COPY services/prover/src/ ./src/

# Build release binary (optimized: LTO + single codegen unit)
RUN cargo build --release

# =============================================================================
# Stage 2: Node.js relayer + Rust prover binary
# =============================================================================
FROM node:20-slim

# Install runtime dependencies for the Rust binary
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy relayer package files
COPY services/relayer/package.json services/relayer/pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy relayer source code
COPY services/relayer/src/ ./src/
COPY services/relayer/tsconfig.json ./

# Copy circuit files from repo root
# Transfer circuit (existing)
COPY circuits/build/transfer_js/transfer.wasm ./circuits/transfer.wasm
COPY circuits/build/transfer_final.zkey ./circuits/transfer_final.zkey
COPY circuits/build/verification_key.json ./circuits/verification_key.json
COPY circuits/build/transfer.r1cs ./circuits/transfer.r1cs
# Confidential balance circuit (zkSPL)
COPY circuits/build/confidential_balance_js/confidential_balance.wasm ./circuits/confidential_balance.wasm
COPY circuits/build/confidential_balance_final.zkey ./circuits/confidential_balance_final.zkey
COPY circuits/build/confidential_balance.r1cs ./circuits/confidential_balance.r1cs
# Confidential balance verification key (zkSPL)
COPY circuits/build/confidential_balance_vk.json ./circuits/confidential_balance_vk.json
# Balance proof circuit (zkSPL)
COPY circuits/build/balance_proof_js/balance_proof.wasm ./circuits/balance_proof.wasm
COPY circuits/build/balance_proof_final.zkey ./circuits/balance_proof_final.zkey
COPY circuits/build/balance_proof.r1cs ./circuits/balance_proof.r1cs
# Balance proof verification key (zkSPL)
COPY circuits/build/balance_proof_vk.json ./circuits/balance_proof_vk.json

# Build TypeScript
RUN pnpm build

# Copy Rust prover binary from builder stage
COPY --from=rust-builder /build/target/release/p01-prover /usr/local/bin/p01-prover

# Copy entrypoint script
COPY services/relayer/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Environment variables
ENV PORT=3000
ENV PROVER_PORT=3001
ENV WASM_PATH=/app/circuits/transfer.wasm
ENV ZKEY_PATH=/app/circuits/transfer_final.zkey
ENV VERIFICATION_KEY_PATH=/app/circuits/verification_key.json
# Rust prover circuit paths (CIRCUITS_DIR provides base, per-circuit env overrides)
ENV CIRCUITS_DIR=/app/circuits
ENV CIRCUIT_WASM_PATH=/app/circuits/transfer.wasm
ENV CIRCUIT_R1CS_PATH=/app/circuits/transfer.r1cs
ENV CIRCUIT_ZKEY_PATH=/app/circuits/transfer_final.zkey
ENV ZKSPL_WASM_PATH=/app/circuits/confidential_balance.wasm
ENV ZKSPL_R1CS_PATH=/app/circuits/confidential_balance.r1cs
ENV ZKSPL_ZKEY_PATH=/app/circuits/confidential_balance_final.zkey
ENV BALANCE_PROOF_WASM_PATH=/app/circuits/balance_proof.wasm
ENV BALANCE_PROOF_R1CS_PATH=/app/circuits/balance_proof.r1cs
ENV BALANCE_PROOF_ZKEY_PATH=/app/circuits/balance_proof_final.zkey
ENV ZKSPL_VK_PATH=/app/circuits/confidential_balance_vk.json
ENV BALANCE_PROOF_VK_PATH=/app/circuits/balance_proof_vk.json
ENV RUST_PROVER_URL=http://localhost:3001
ENV SOLANA_RPC_URL=https://api.devnet.solana.com

EXPOSE 3000

CMD ["/app/entrypoint.sh"]
