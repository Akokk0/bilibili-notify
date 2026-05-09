# syntax=docker/dockerfile:1.7
#
# bilibili-notify image (Hono server + bundled React dashboard).
#
# Build context MUST be the repo root, not apps/, because the pnpm
# sub-workspace's `link:` deps point at ../../packages/*. The matching
# CI workflow in .github/workflows/image-release.yml sets
#   context: .
#   file: ./apps/Dockerfile
#
# Manual build from the repo root:
#   docker build -f apps/Dockerfile -t bilibili-notify:dev .
# or via compose (apps/docker-compose.example.yaml).
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
# console UI which the dashboard does not consume.
RUN yarn install --immutable
RUN yarn tsdown -W

# Step 2: install + build the apps/ pnpm sub-workspace.
# `pnpm -r build` runs both server (tsdown) and web (vite build).
RUN cd apps && pnpm install --frozen-lockfile
RUN cd apps && pnpm -r build

# Step 3: drop devDependencies after the build so the final image only ships
# what's needed at runtime.
RUN cd apps && pnpm prune --prod || true

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
# apps/server/node_modules/@bilibili-notify/internal -> ../../../../packages/internal
# means /app must contain both packages/* and apps/server tree.
WORKDIR /app

COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/package.json ./apps/package.json
COPY --from=builder /repo/apps/pnpm-workspace.yaml ./apps/pnpm-workspace.yaml
COPY --from=builder /repo/apps/.npmrc ./apps/.npmrc
COPY --from=builder /repo/apps/node_modules ./apps/node_modules
COPY --from=builder /repo/apps/server/lib ./apps/server/lib
COPY --from=builder /repo/apps/server/package.json ./apps/server/package.json
COPY --from=builder /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /repo/apps/server/bn.config.example.yaml ./bn.config.example.yaml
COPY --from=builder /repo/apps/web/dist ./web-dist

WORKDIR /app/apps/server

# Persistent state lives at /data — mount a host directory or named volume here.
VOLUME ["/data"]

EXPOSE 8787

# tini ensures Node sees SIGTERM / SIGINT and shuts down cleanly (graceful path
# in src/index.ts disposes engines, ws, puppeteer, http server in order).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/index.mjs"]
