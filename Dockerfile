# Multi-stage build for barazo-api
# Build context: monorepo root (docker build -f barazo-api/Dockerfile .)

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /workspace

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

# Copy workspace root config (including .npmrc for inject-workspace-packages)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Copy all workspace package.json files (needed for pnpm install)
COPY barazo-lexicons/package.json ./barazo-lexicons/
COPY barazo-api/package.json ./barazo-api/
COPY barazo-web/package.json ./barazo-web/
COPY barazo-plugins/packages/plugin-signatures/package.json ./barazo-plugins/packages/plugin-signatures/

# Install all dependencies (including devDeps for tsc build)
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: Build
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

# Copy installed dependencies
COPY --from=deps /workspace/ ./

# Copy lexicons source (workspace dependency)
COPY barazo-lexicons/ ./barazo-lexicons/

# Copy plugin-signatures source (workspace dependency via link:)
COPY barazo-plugins/packages/plugin-signatures/ ./barazo-plugins/packages/plugin-signatures/

# Copy API source
COPY barazo-api/ ./barazo-api/

# Build workspace dependencies first, then API
RUN pnpm --filter @singi-labs/lexicons build && \
    pnpm --filter @barazo/plugin-signatures build && \
    pnpm --filter barazo-api build

# Create standalone production deployment with resolved dependencies.
# pnpm deploy copies workspace + prod deps (requires inject-workspace-packages=true in .npmrc).
RUN pnpm --filter barazo-api deploy /app/deploy --prod

# ---------------------------------------------------------------------------
# Stage 3: Production runner
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 barazo

# Copy production deployment (node_modules + package.json)
COPY --from=builder /app/deploy/ ./

# Copy compiled output
COPY --from=builder /workspace/barazo-api/dist/ ./dist/

# Copy Drizzle migration files (applied on startup)
COPY --from=builder /workspace/barazo-api/drizzle/ ./drizzle/

# Create plugins directory for runtime plugin loading
RUN mkdir -p /app/plugins && chown barazo:nodejs /app/plugins

USER barazo

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "dist/server.js"]
