# Conway colony worker for Railway (or any Docker host).
#
# Build context = agents/conway (set Railway "Root Directory" to agents/conway).
# The image clones upstream Conway Automaton at the pinned commit, applies the
# p01 patches from ./patches, builds it, and runs the lineage supervisor.
# Persistent state (wallets, SQLite, lineage) lives on a volume mounted at /data.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ curl \
 && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM_REPO=https://github.com/Conway-Research/automaton.git
ARG UPSTREAM_COMMIT=d8f8168

WORKDIR /opt
RUN git clone --quiet ${UPSTREAM_REPO} automaton \
 && cd automaton && git checkout --quiet ${UPSTREAM_COMMIT}

COPY patches/ /opt/patches/
RUN cd automaton \
 && git -c user.name=colony -c user.email=colony@local am /opt/patches/*.patch \
 && npm install -g pnpm@9 \
 && pnpm install \
 && pnpm build \
 && test -f dist/inference/free-pool.js

WORKDIR /app/agents/conway
COPY . /app/agents/conway/

# Agents and supervisor state live here; mount a Railway volume at /data
# (Railway rejects the Docker VOLUME instruction; the volume is attached to the service).
ENV HOME=/data
ENV COLONY_FILE=/app/agents/conway/colony.railway.json

# Keys and RPC come from Railway variables (GROQ_API_KEY, ..., SOLANA_RPC_URL).
CMD ["node", "/app/agents/conway/scripts/supervisor.mjs", "start"]
