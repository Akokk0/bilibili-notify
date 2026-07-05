# syntax=docker/dockerfile:1.7
#
# bilibili-notify 独立端 runtime base:node-slim + chromium + CJK/emoji 字体 + tini。
#
# 拆独立镜像的动机:这层 ~300MB 且极少变化,但主镜像每次发版重建 apt 层都产生
# 新 digest(apt 索引漂移 + CI 无层缓存),用户被迫每个版本重拉 300MB。冻结成
# base 后 app 镜像 FROM 它 —— 用户对这层「拉一次、之后 Already exists」,每次
# 升级只下 ~15MB 的 app bundle 层。
#
# 构建 / 刷新:.github/workflows/base-image.yml(workflow_dispatch;不可变递增
# tag b1/b2/…,同时推 :latest)。刷新后把 apps/Dockerfile 的 `ARG BN_BASE_IMAGE`
# 默认值 bump 到新 tag,随下次发版生效。Debian 修 chromium CVE 后重建一次即可。
# 本地手动构建:docker build -f apps/base.Dockerfile -t bilibili-notify-base:dev apps
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# chromium  — puppeteer-core (cards preview); ~300 MB after install.
# fonts-noto-cjk + fonts-noto-color-emoji — render Chinese + emoji in screenshots.
# tini — PID 1 signal forwarding so SIGINT/SIGTERM reach Node.
# ca-certificates — HTTPS to bilibili.com / openai-compatible endpoints.
# tzdata — TZ env var resolution(app 镜像默认 TZ=Asia/Shanghai,运行时可覆盖).
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium fonts-noto-cjk fonts-noto-color-emoji ca-certificates tini tzdata \
    && rm -rf /var/lib/apt/lists/*
