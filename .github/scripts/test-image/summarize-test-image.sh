#!/usr/bin/env bash
#
# 测试镜像推完之后,往 job summary 里写一段可以直接复制的 `docker pull` 命令。
# 由 .github/workflows/test-image.yml 的 `Print pull instructions` 一步调用。本地手动跑:
#
#   GITHUB_STEP_SUMMARY=/tmp/summary.md DOCKERHUB_IMAGE=docker.io/akokk0/bilibili-notify \
#     bash .github/scripts/test-image/summarize-test-image.sh
#
# 必需 env:
#   DOCKERHUB_IMAGE  Docker Hub 镜像 repo(GHA 里是 workflow 级 env,自动进进程环境)
#
# `:test` 是浮动 tag,得跟 test-image.yml 里 build-push 的 `tags:` 保持一致。

set -euo pipefail

: "${DOCKERHUB_IMAGE:?DOCKERHUB_IMAGE env 必填(如 docker.io/akokk0/bilibili-notify)}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY env 必填(GHA 自动提供;本地跑请指向一个临时文件)}"

{
	echo "### 可以拉取测试了 🐾"
	echo ""
	echo '```bash'
	echo "docker pull ${DOCKERHUB_IMAGE}:test"
	echo '```'
} >>"$GITHUB_STEP_SUMMARY"
