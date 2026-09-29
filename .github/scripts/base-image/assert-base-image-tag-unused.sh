#!/usr/bin/env bash
#
# 不可变 tag 不允许覆盖 —— Docker Hub 上已存在同名 base tag 时直接失败,换下一个编号。
# 由 .github/workflows/base-image.yml 的 `Refuse overwriting an existing immutable tag`
# 一步调用(dry-run 不跑)。会访问 Docker Hub;imagetools inspect 对公共仓库无需登录,
# 镜像 / tag 不存在时非零退出。本地手动跑:
#
#   DOCKERHUB_IMAGE=docker.io/akokk0/bilibili-notify-base TAG=b3 \
#     bash .github/scripts/base-image/assert-base-image-tag-unused.sh
#
# 必需 env:
#   TAG              要推的 base tag(inputs.tag)
#   DOCKERHUB_IMAGE  Docker Hub 上的 base 镜像 repo(GHA 里是 workflow 级 env,自动进进程环境)

set -euo pipefail

: "${TAG:?TAG env 必填(base 镜像 tag,如 b1)}"
: "${DOCKERHUB_IMAGE:?DOCKERHUB_IMAGE env 必填(如 docker.io/akokk0/bilibili-notify-base)}"

if docker buildx imagetools inspect "${DOCKERHUB_IMAGE}:${TAG}" >/dev/null 2>&1; then
	echo "::error::${DOCKERHUB_IMAGE}:${TAG} 已存在,不可变 tag 不允许覆盖"
	exit 1
fi
