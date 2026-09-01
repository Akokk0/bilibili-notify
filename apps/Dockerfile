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
#   docker build -f apps/Dockerfile -t bilibili-notify:dev .            # full(内置 chromium)
#   docker build -f apps/Dockerfile --target runtime-slim \
#       -t bilibili-notify:dev-slim .                                   # slim(无 chromium)
# or via compose (apps/docker-compose.example.yaml).
#
# 两个发布 target:
#   runtime      —— 默认(文件最后一个 stage)。chromium 内置,开箱即用。
#   runtime-slim —— 无 chromium/字体,体积小得多;卡片渲染需配 BN_CHROME_ENDPOINT
#                   指向远程浏览器(browserless 伴随容器等),不配则退化为文字推送。
#
# Plan deviates from the original "distroless runtime" idea — puppeteer-core
# requires a Chromium binary, which distroless does not ship.

ARG NODE_VERSION=24

# builder 工具链镜像 —— 版本与 root devDependency 的 vite-plus 同步升级(联动
# 清单见 pnpm-workspace.yaml 顶部大注释)。官方只发 ghcr.io(amd64+arm64);CI 在
# GHA 上拉 ghcr 走 GitHub 内网、很快。国内本地构建嫌慢时用 --build-arg 整体换成
# 任意镜像加速源,风格同下方 BN_BASE_IMAGE。
ARG VP_BUILDER_IMAGE=ghcr.io/voidzero-dev/vite-plus:0.3.0

# runtime 底座:预装 chromium + CJK/emoji 字体 + tini 的自建 base(见
# apps/base.Dockerfile)。这 ~300MB 冻结在 base 里,digest 只随 base 显式重建
# (base-image.yml,不可变 tag b1/b2/…)而变 —— 用户拉一次、之后每次升级只下
# app bundle 小层。刷新 base 后在这里 bump 默认 tag。
# ⚠️ 时序:新 tag 必须先经 base-image.yml 推上 registry,本镜像才构建得动。
ARG BN_BASE_IMAGE=docker.io/akokk0/bilibili-notify-base:b1

# ---- builder ----------------------------------------------------------------

# Toolchain note — the repo standardises on vp (vite-plus), and since the
# official toolchain image (ghcr.io/voidzero-dev/vite-plus) exists this builder
# uses it too: the historical corepack carve-out (vp had no Docker-side
# bootstrap) is gone. The image ships the vp CLI + git + build-essential on
# debian-slim, runs as the non-root `vp` user with WORKDIR /app, and vp
# provisions Node.js per `.node-version` (24.15.0 — MORE deterministic than the
# rolling node:${NODE_VERSION} tag this stage used to build on) and the exact
# pnpm pinned in package.json#packageManager.
FROM ${VP_BUILDER_IMAGE} AS builder

# Copy the entire monorepo. The .dockerignore in the repo root drops
# node_modules / lib / dist / .git so the build context stays small.
# --chown: the image runs as the non-root `vp` user; a root-owned tree would
# make the install step unable to write node_modules.
COPY --chown=vp:vp . .

# Single pnpm workspace covers packages/*, koishi/*, apps/*. Install once.
# `vp pm` forwards to the pinned pnpm verbatim; `vp pm ci` = clean
# frozen-lockfile install for CI environments.
#
# `.dockerignore` 排除 .git,而 root prepare 脚本调 `lefthook install`,
# 该命令要求在 git 工作区里跑 → 这里临时 init 一个空仓让它写完 hooks
# 即可(builder 用完即弃,不会带进 runtime)。
RUN git init -q . && vp pm ci

# 只构建镜像真正消费的三块(旧版 `pnpm -r` 全 workspace 扫一遍,koishi/* 的产物
# 从未进过 runtime 镜像,纯浪费 CI 时间):
#   1. packages/* + apps/contract —— server/web 的内联输入(vp pack 经各包 exports
#      解析 lib/)。contract 是独立端专属的 wire 契约包,放在 apps/ 而非 packages/,
#      故必须显式点名 —— 漏了它 web / server 的构建会 TS2307 解析不到 @bilibili-notify/contract。
#   2. apps/web    —— dashboard 静态资源。
#   3. apps/server build:bundle + 装配 —— 自包含单文件 bundle(全部依赖内联),
#      assemble-server-bundle.mjs 把运行时按路径读取的资产(jieba wasm / jsdom
#      xhr worker / 词云 static)+ bn.config.example.yaml + package.json 搬进 dist/。
# 旧 pnpm 版命令带 --stream(GHA buildx 的 batched 输出下看清卡在哪个包);
# vp run 本身就是实时流式 + 拓扑序输出,诉求内置满足,无需对应 flag。
# 注意 vp pm 只覆盖精选的 pnpm 子命令(没有 run),跑 script 必须走 vp run。
# node 走 vp 的 shim(按 .node-version 供给)。
RUN vp run -F './packages/*' -F '@bilibili-notify/contract' build
RUN vp run -F '@bilibili-notify/web' build
RUN vp run -F '@bilibili-notify/server' build:bundle \
    && node scripts/assemble-server-bundle.mjs

# ---- runtime-slim -----------------------------------------------------------

# 无 chromium 的精简变体(发布 tag 带 -slim 后缀)。直接基于 node:slim + 一层小 apt
# (tini/tzdata/ca-certificates,~5MB —— 不值得为它单独维护一个 slim base 镜像;
# full 变体避开 per-release apt 层是因为那层带 chromium+字体有 ~300MB)。
# 卡片渲染由 BN_CHROME_ENDPOINT 指向的远程浏览器承担;未配置则文字推送照常工作。
# ⚠️ 此 stage 必须排在 runtime 之前 —— 默认 build target = 文件最后一个 stage,
# 不带 --target 的 docker build 应继续得到 full 镜像。
FROM node:${NODE_VERSION}-bookworm-slim AS runtime-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        tini tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 与 runtime 的 ENV 相比:无 BN_CHROME_PATH(镜像内没有浏览器)。
# NODE_OPTIONS 堆上限:V8 默认按宿主机内存推导 old-space 上限(动辄数 GB),
# 没内存压力就不勤 GC,RSS 长期浮高。压一个上限逼 GC 勤快回收(Buffer/WASM 等
# 堆外内存不受此限)。用户可在 compose 的 environment 里设同名变量覆盖。
#
# 384 → 512(2026-08-08):有用户订阅十几个 UP、其中不乏大主播,堆撞到 384 的
# 天花板后 `FATAL ERROR: Reached heap limit` 自杀。**这是抬余量,不是修好了**
# —— 撞墙的根因(稳态就需要这么多 / 慢泄漏)尚未定位,内存自检日志
# (server/src/runtime/memory-probe.ts)就是为了把那条曲线记进日志归档。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    NODE_OPTIONS=--max-old-space-size=512 \
    BN_CONFIG=/config/bn.config.yaml \
    BN_HOST=0.0.0.0 \
    BN_PORT=8787 \
    BN_DATA_DIR=/data

# WORKDIR=/app + web-dist 是 index.mjs 的同级目录:dashboard 静态资源按载荷入口
# 就近解析(src/config/web-dist.ts),不再靠 BN_WEB_DIST 指路。
WORKDIR /app
COPY --from=builder /app/apps/server/dist ./
COPY --from=builder /app/apps/web/dist ./web-dist

VOLUME ["/data", "/config"]

EXPOSE 8787

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "boot.mjs"]

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
# NODE_OPTIONS 堆上限:理由与 512 的来历同 runtime-slim 那段(本文件上方),
# 差别只在 chromium 是独立进程、同样不受此限。compose environment 可覆盖。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    NODE_OPTIONS=--max-old-space-size=512 \
    BN_CONFIG=/config/bn.config.yaml \
    BN_HOST=0.0.0.0 \
    BN_PORT=8787 \
    BN_DATA_DIR=/data \
    BN_CHROME_PATH=/usr/bin/chromium

# server 是自包含单文件 bundle(全部 JS 依赖内联,scripts/assemble-server-bundle.mjs
# 已把 wasm / worker / static 资产与 package.json 装配进 dist/),镜像里**没有
# node_modules**。旧版整搬 hoisted workspace store(804MB,含构建工具与别端依赖),
# bundle 后 app 载荷 ~15MB —— 用户每次升级只重拉这一小层。
# 装配好的 package.json 与 bundle 平级:resolveAppVersion 从 index.mjs 往上找最近的
# 那一份(见 src/routes/health.ts),报的是**载荷自己**的版本,与 cwd 无关。
WORKDIR /app
COPY --from=builder /app/apps/server/dist ./
# web dashboard 静态资源独立成层,且必须是 index.mjs 的**同级**目录 —— 服务端按
# 载荷入口就近解析它(src/config/web-dist.ts),这样在线升级时前后端一起换,不会
# 出现「新服务端配旧前端」。
COPY --from=builder /app/apps/web/dist ./web-dist

# Persistent volumes — /data 是 state(订阅 / 历史 / 日志 / 凭据 等),/config 是
# bootstrap yaml(B 模型 first-boot seed 在这写)。两个 root 级 mount point 平级。
VOLUME ["/data", "/config"]

EXPOSE 8787

# tini ensures Node sees SIGTERM / SIGINT and shuts down cleanly (graceful path
# in src/index.ts disposes engines, ws, puppeteer, http server in order).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "boot.mjs"]
