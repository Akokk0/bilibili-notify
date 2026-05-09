# syntax=docker/dockerfile:1.7
#
# Standalone bilibili-notify image (Hono server + bundled React dashboard).
#
# Build context MUST be the repo root, not apps/standalone, because the
# pnpm sub-workspace's `link:` deps point at ../../../packages/*. The
# matching CI workflow in .github/workflows/standalone-release.yml sets
#   context: .
#   file: ./apps/standalone/Dockerfile
#
# Manual build from the repo root:
#   docker build -f apps/standalone/Dockerfile -t bilibili-notify-standalone:dev .
# or via compose (apps/standalone/docker-compose.example.yaml).
#
# Plan deviates from the original "distroless runtime" idea — puppeteer-core
# requires a Chromium binary, which distroless does not ship. node:20-bookworm-slim
# + apt chromium is the smallest realistic base.

ARG NODE_VERSION=20

# ---- builder ----------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS builder

# git for any package that fetches via git-https; python3/make/g++ for native
# deps that fall back to building from source. corepack provisions yarn 4 and
# pnpm 10 from the `packageManager` fields in package.json.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /repo

# Copy the entire monorepo. The .dockerignore in the repo root drops
# node_modules / lib / dist / .git so the build context stays small.
COPY . .

# Step 1: install + build platform-neutral packages/* via the root yarn workspace.
# We invoke tsdown directly (instead of `yarn build`) to skip the koishi-only
# vue client build step — tsdown -W still hits every workspace package's
# tsdown.config.ts, including the koishi shells, but never touches the koishi
# console UI which the standalone end does not consume.
RUN yarn install --immutable
RUN yarn tsdown -W

# Step 2: install + build the standalone sub-workspace (pnpm).
# `pnpm -r build` runs both server (tsdown) and web (vite build).
RUN cd apps/standalone && pnpm install --frozen-lockfile
RUN cd apps/standalone && pnpm -r build

# Step 3: drop devDependencies after the build so the final image only ships
# what's needed at runtime. `prune --prod -r` walks the sub-workspace.
RUN cd apps/standalone && pnpm prune --prod || true

# ---- runtime ----------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# chromium  — puppeteer-core (cards preview); ~300 MB after install.
# fonts-noto-cjk + fonts-noto-color-emoji — render Chinese + emoji in screenshots.
# tini — PID 1 signal forwarding so SIGINT/SIGTERM reach Node.
# ca-certificates — HTTPS to bilibili.com / openai-compatible endpoints.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium fonts-noto-cjk fonts-noto-color-emoji ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    BN_HOST=0.0.0.0 \
    BN_PORT=8787 \
    BN_DATA_DIR=/data \
    BN_CHROME_PATH=/usr/bin/chromium \
    BN_WEB_DIST=/app/web-dist

# Preserve relative paths so pnpm `link:` symlinks resolve in the runtime image.
# server/node_modules/@bilibili-notify/internal -> ../../../../../packages/internal
# means /app must contain both packages/* and apps/standalone/server tree.
WORKDIR /app

COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/standalone/package.json ./apps/standalone/package.json
COPY --from=builder /repo/apps/standalone/pnpm-workspace.yaml ./apps/standalone/pnpm-workspace.yaml
COPY --from=builder /repo/apps/standalone/.npmrc ./apps/standalone/.npmrc
COPY --from=builder /repo/apps/standalone/node_modules ./apps/standalone/node_modules
COPY --from=builder /repo/apps/standalone/server/lib ./apps/standalone/server/lib
COPY --from=builder /repo/apps/standalone/server/package.json ./apps/standalone/server/package.json
COPY --from=builder /repo/apps/standalone/server/node_modules ./apps/standalone/server/node_modules
COPY --from=builder /repo/apps/standalone/server/bn.config.example.yaml ./bn.config.example.yaml
COPY --from=builder /repo/apps/standalone/web/dist ./web-dist

WORKDIR /app/apps/standalone/server

# Persistent state lives at /data — mount a host directory or named volume here.
VOLUME ["/data"]

EXPOSE 8787

# tini ensures Node sees SIGTERM / SIGINT and shuts down cleanly (graceful path
# in src/index.ts disposes engines, ws, puppeteer, http server in order).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/index.mjs"]
