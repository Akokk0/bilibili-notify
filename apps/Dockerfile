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
# requires a Chromium binary, which distroless does not ship.

ARG NODE_VERSION=24

# runtime 底座:预装 chromium + CJK/emoji 字体 + tini 的自建 base(见
# apps/base.Dockerfile)。这 ~300MB 冻结在 base 里,digest 只随 base 显式重建
# (base-image.yml,不可变 tag b1/b2/…)而变 —— 用户拉一次、之后每次升级只下
# app bundle 小层。刷新 base 后在这里 bump 默认 tag。
# ⚠️ 时序:新 tag 必须先经 base-image.yml 推上 registry,本镜像才构建得动。
ARG BN_BASE_IMAGE=docker.io/akokk0/bilibili-notify-base:b1

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

# Single pnpm workspace covers packages/*, koishi/*, apps/*. Install once.
#
# `.dockerignore` 排除 .git,而 root prepare 脚本调 `lefthook install`,
# 该命令要求在 git 工作区里跑 → 这里临时 init 一个空仓让它写完 hooks
# 即可(builder 用完即弃,不会带进 runtime)。
RUN git init -q . && pnpm install --frozen-lockfile

# 只构建镜像真正消费的三块(旧版 `pnpm -r` 全 workspace 扫一遍,koishi/* 的产物
# 从未进过 runtime 镜像,纯浪费 CI 时间):
#   1. packages/*  —— server bundle 的内联输入(vp pack 经各包 exports 解析 lib/)。
#   2. apps/web    —— dashboard 静态资源。
#   3. apps/server build:bundle + 装配 —— 自包含单文件 bundle(全部依赖内联),
#      assemble-server-bundle.mjs 把运行时按路径读取的资产(jieba wasm / jsdom
#      xhr worker / 词云 static)+ bn.config.example.yaml + package.json 搬进 dist/。
# --stream:GHA buildx 默认 batched 输出,多包 build 静默累积时卡死一个包就整体
# 看不出在哪,--stream 让各包输出实时刷出。
# script 里的 `vp` 从根 devDependency(vite-plus)的 node_modules/.bin 解析,
# builder 无需全局 vp。
RUN pnpm -r --filter './packages/*' --stream run build
RUN pnpm --filter '@bilibili-notify/web' run build
RUN pnpm --filter '@bilibili-notify/server' run build:bundle \
    && node scripts/assemble-server-bundle.mjs

# ---- runtime ----------------------------------------------------------------

# chromium / 字体 / tini / ca-certificates / tzdata 全部来自 base(apps/base.Dockerfile),
# 这里不再跑 apt —— 主镜像每次发版重建 apt 层会产生新 digest,用户被迫重拉 300MB;
# base 化后该层跨版本稳定。
FROM ${BN_BASE_IMAGE} AS runtime

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

# server 是自包含单文件 bundle(全部 JS 依赖内联,scripts/assemble-server-bundle.mjs
# 已把 wasm / worker / static 资产与 package.json 装配进 dist/),镜像里**没有
# node_modules**。旧版整搬 hoisted workspace store(804MB,含构建工具与别端依赖),
# bundle 后 app 载荷 ~15MB —— 用户每次升级只重拉这一小层。
# WORKDIR=/app:resolveAppVersion 读 process.cwd()/package.json(见
# src/routes/health.ts),装配好的 package.json 就在 bundle 旁边。
WORKDIR /app
COPY --from=builder /repo/apps/server/dist ./
# web dashboard 静态资源独立成层(BN_WEB_DIST=/app/web-dist,绝对路径)。
COPY --from=builder /repo/apps/web/dist ./web-dist

# Persistent volumes — /data 是 state(订阅 / 历史 / 日志 / 凭据 等),/config 是
# bootstrap yaml(B 模型 first-boot seed 在这写)。两个 root 级 mount point 平级。
VOLUME ["/data", "/config"]

EXPOSE 8787

# tini ensures Node sees SIGTERM / SIGINT and shuts down cleanly (graceful path
# in src/index.ts disposes engines, ws, puppeteer, http server in order).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.mjs"]
