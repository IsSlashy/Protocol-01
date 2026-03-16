# ============================================================================
# P01 Bundle Engine — Production Docker Image
# ============================================================================
#
# Multi-stage build: TypeScript compilation → minimal Node.js runtime.
# Runs as non-root user. Includes socks-proxy-agent for Tor routing.
#
# Build:  docker build -t p01-relay .
# Run:    docker run -p 3099:3099 --env-file .env p01-relay
#
# Size: ~180MB (Node 22 Alpine + deps)
# ============================================================================

# ── Stage 1: Build ──
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable

# Copy dependency manifests
COPY package.json pnpm-lock.yaml* ./

# Install ALL dependencies (including devDependencies for tsc)
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    else \
      npm install; \
    fi

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npx tsc

# ── Stage 2: Runtime ──
FROM node:22-alpine

# tini for proper signal handling (PID 1 zombie reaping)
RUN apk add --no-cache tini

# Non-root user — relay should never run as root
RUN addgroup -S p01 && adduser -S p01 -G p01

WORKDIR /app

# Copy compiled output + production dependencies only
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Install socks-proxy-agent for Tor SOCKS5 routing
RUN npm install --no-save socks-proxy-agent@8 && \
    npm cache clean --force

# Drop privileges
USER p01

EXPOSE 3099

# Health check — verifies the server is responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3099/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
