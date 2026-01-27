# ZK Prover Relayer Service
# Generates ZK proofs for mobile clients
#
# Build from repo root:
#   docker build -f services/relayer/Dockerfile -t p01-relayer .

FROM node:20-slim

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
COPY circuits/build/transfer_js/transfer.wasm ./circuits/transfer.wasm
COPY circuits/build/transfer_final.zkey ./circuits/transfer_final.zkey
COPY circuits/build/verification_key.json ./circuits/verification_key.json

# Build TypeScript
RUN pnpm build

# Environment variables
ENV PORT=3000
ENV WASM_PATH=/app/circuits/transfer.wasm
ENV ZKEY_PATH=/app/circuits/transfer_final.zkey
ENV VERIFICATION_KEY_PATH=/app/circuits/verification_key.json
ENV SOLANA_RPC_URL=https://api.devnet.solana.com

EXPOSE 3000

CMD ["node", "dist/index.js"]
