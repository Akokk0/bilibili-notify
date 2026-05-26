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
# requires a Chromium binary, which distroless does not ship. node:24-bookworm-slim
# + apt chromium is the smallest realistic base.

ARG NODE_VERSION=24

# ---- builder ----------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS builder

# git for any package that fetches via git-https; python3/make/g++ for native
# deps that fall back to building from source.
#
# Toolchain note — the repo standardises on vp (vite-plus); CI bootstraps it
# via voidzero-dev/setup-vp. This Docker builder is a DELIBERATE, documented
# exception: it uses corepack-provisioned pnpm (from package.json#packageManager,
# currently pnpm@11.3.0), NOT vp. Why: corepack ships free in the node base
# image (zero extra layer, offline), vp has no Docker-side bootstrap action
# like setup-vp, and corepack vs vp resolve the SAME pinned pnpm so build
# artifacts are byte-identical. Mirrors the corepack carve-out in
# .github/workflows/publish.yml. Do NOT "fix" this to vp without first
# re-evaluating the bootstrap cost.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /repo

# Copy the entire monorepo. The .dockerignore in the repo root drops
# node_modules / lib / dist / .git so the build context stays small.
COPY . .

# Single pnpm workspace covers packages/*, koishi/*, apps/*. Install once;
# pnpm -r builds in topological order so packages/* land before koishi
# shells and apps/server, which depend on them via workspace:* protocol.
# We skip the koishi-console vue client build (`build:client`) — the
# dashboard image does not consume the koishi UI.
#
# `.dockerignore` 排除 .git,而 root prepare 脚本调 `lefthook install`,
# 该命令要求在 git 工作区里跑 → 这里临时 init 一个空仓让它写完 hooks
# 即可(builder 用完即弃,不会带进 runtime)。
RUN git init -q . && pnpm install --frozen-lockfile

# 把 packages/* 的 package.json#version 推到「本次发布的目标版本」。版本号由
# changeset 控制,只在 `changeset version` 时才 bump —— dev 分支上 changeset 尚未
# 消费,package.json 还停在上次发布的旧版本。builder 阶段用完即弃:这里跑普通
# `changeset version` 消费 pending changeset、把版本写成目标值(pre 模式下为
# x.y.z-alpha.N),所有 mutation 只活在被丢弃的 builder layer,真实仓库不受影响。
# /api/health 的「各模块版本」据此显示。无 pending changeset 时为 no-op;
# .changeset/ 状态损坏时 fail-fast,不产出版本号错误的镜像。
#
# changeset version 改了大量 packages/* package.json#version,workspace deps
# (workspace:^ 协议)随之"看上去版本不匹配"。后续 `pnpm -r run build` 启动时
# pnpm 会**隐式**触发一次 install + 重 link;这个隐式 install 在 17+ 包多变
# 状态下能弄坏 `node_modules/.bin/` 的二进制 symlink(尤其 vp shim),后续 vp
# pack 命令调起即 hang。这里显式跑一次 `pnpm install --no-frozen-lockfile` 把
# install 锁定在 build 之前,行为可见可控;build 内部就无需再隐式 sync。
RUN pnpm exec changeset version
RUN pnpm install --no-frozen-lockfile

# 拆两阶段 + --stream:GHA buildx 默认 batched 输出,17+ 包 build 静默累积时
# 卡死一个包就整体看不出在哪。--stream 让各包输出实时刷出;先 packages/* 再
# koishi/* + apps/* 是因为 koishi/* 与 apps/* 都依赖 packages/*(workspace:*
# protocol),按拓扑序分两轮更利于定位"哪个包卡了"。
RUN pnpm -r --filter './packages/*' --stream run build
RUN pnpm -r --filter './koishi/*' --filter './apps/*' --stream run build

# Drop devDependencies so the final image only ships runtime deps.
# pnpm 11 的 prune 不支持 -r;workspace 模式下逐包 prune 反而容易破坏
# link 关系。runtime 阶段 selective COPY 只搬 lib/dist + 必需的 node_modules,
# devDep 不会进最终镜像 —— 这里直接跳过 prune,简单可靠。

# ---- runtime ----------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# chromium  — puppeteer-core (cards preview); ~300 MB after install.
# fonts-noto-cjk + fonts-noto-color-emoji — render Chinese + emoji in screenshots.
# tini — PID 1 signal forwarding so SIGINT/SIGTERM reach Node.
# ca-certificates — HTTPS to bilibili.com / openai-compatible endpoints.
# tzdata — TZ env var resolution (default Asia/Shanghai;运行时可 -e TZ= 覆盖).
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium fonts-noto-cjk fonts-noto-color-emoji ca-certificates tini tzdata \
    && rm -rf /var/lib/apt/lists/*

# BN_CONFIG 是 B 模型开关:loader 检测到此 env 就走"first-boot seed env 进 yaml,
# 之后 yaml 是真相,env 被忽略"逻辑(见 src/config/loader.ts)。配置目录跟 state
# 目录都是 root 级 VOLUME,在镜像外彼此平级(用户挂 ./data:/data + ./config:/config),
# yaml 自动出现在 host 端 ./config/bn.config.yaml,可直接 vim。其他 BN_* 是 first-boot
# 的种子源,首次启动后用户编辑 yaml 才生效。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    BN_CONFIG=/config/bn.config.yaml \
    BN_HOST=0.0.0.0 \
    BN_PORT=8787 \
    BN_DATA_DIR=/data \
    BN_CHROME_PATH=/usr/bin/chromium \
    BN_WEB_DIST=/app/web-dist

# Preserve relative paths so pnpm `workspace:*` symlinks resolve in the
# runtime image. With node-linker=hoisted, most third-party deps land in
# /repo/node_modules; workspace deps live as symlinks under each consumer's
# node_modules. We mirror that whole shape under /app.
WORKDIR /app

# 小文件合并(全是文件,multi-source COPY 到 ./ 时各自落到对应名);大目录单独
# 成层,利于 buildx layer cache 增量复用 + push 时只 push 变动层。
#
# 注意:multi-source COPY **目录** 时,复制的是目录的**内容**(不保留源目录名作为
# 子目录),所以 lib 不能跟 server/package.json 一起合 — 必须单独 COPY 才保留
# /app/apps/server/lib/ 这一层(CMD `node lib/index.mjs` 依赖这个路径)。
COPY --from=builder \
     /repo/package.json \
     /repo/pnpm-workspace.yaml \
     /repo/apps/server/bn.config.example.yaml \
     ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/server/lib ./apps/server/lib
# apps/server/package.json —— 既供 node 解析 workspace 包,也供运行时
# resolveAppVersion 读取独立端版本号(见 src/routes/health.ts)。
COPY --from=builder /repo/apps/server/package.json ./apps/server/package.json
COPY --from=builder /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /repo/apps/web/dist ./web-dist

WORKDIR /app/apps/server

# Persistent volumes — /data 是 state(订阅 / 历史 / 日志 / 凭据 等),/config 是
# bootstrap yaml(B 模型 first-boot seed 在这写)。两个 root 级 mount point 平级。
VOLUME ["/data", "/config"]

EXPOSE 8787

# tini ensures Node sees SIGTERM / SIGINT and shuts down cleanly (graceful path
# in src/index.ts disposes engines, ws, puppeteer, http server in order).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/index.mjs"]
