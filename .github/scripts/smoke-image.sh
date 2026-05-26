#!/usr/bin/env bash
#
# Docker 镜像 smoke 测试 —— 起容器 + 探 /api/health + 校验 dashboard 静态资源。
# 由 .github/workflows/image-release.yml 的 build matrix(amd64)调用,也支持
# 本地手动跑:
#
#   IMAGE_REF=bilibili-notify:dev bash .github/scripts/smoke-image.sh
#
# 必需 env:
#   IMAGE_REF  镜像 ref(GHA 传 <IMAGE>@<digest>,本地可以 <name>:<tag>)
#
# 行为:
#   - docker pull(本地已 build 时命中本地)
#   - docker run -d 容器名 bn-smoke 暴露 :8787
#   - 30 次 × 2s poll /api/health 直到 status:"ok"(~60s 上限)
#   - 校验 health.version === apps/server/package.json#version
#   - 校验 GET / 返回 text/html 且 body 含 `<div id="root">`(dashboard index)
#   - 任意检查失败 → ::error:: GHA annotation + docker logs + exit 1
#   - EXIT trap 永远清容器,workflow 不需要单独 Stop step

set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF env 必填,例如 docker.io/akokk0/bilibili-notify@sha256:...}"

# 容器名加 PID + 时间戳防本地 / 自托管 runner 撞已有 bn-smoke 容器(GHA hosted
# runner 是临时的不会撞,但本地手动跑可能跟其它进程冲突)。
readonly CONTAINER="bn-smoke-$$-$(date +%s)"
# 主机端口允许 env override,默认 8787(GHA hosted runner 干净环境直接用)。
readonly PORT="${SMOKE_PORT:-8787}"
readonly HEALTH_TRIES=30
readonly HEALTH_INTERVAL=2

cleanup() {
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker pull "$IMAGE_REF"
docker run -d --name "$CONTAINER" -p "${PORT}:8787" \
	-e BN_DATA_DIR=/tmp/bn -e BN_ALLOW_NO_AUTH=1 \
	"$IMAGE_REF"

# /api/health 启动后才能访问 —— 等就绪。
ready=
for _ in $(seq 1 "$HEALTH_TRIES"); do
	if curl -fsS "http://localhost:${PORT}/api/health" 2>/dev/null \
		| jq -e '.status=="ok"' >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep "$HEALTH_INTERVAL"
done
if [ -z "$ready" ]; then
	echo "::error::/api/health never returned status:ok within ~$((HEALTH_TRIES * HEALTH_INTERVAL))s"
	docker logs "$CONTAINER" || true
	exit 1
fi

# version 一致性:镜像里 /api/health 报的版本必须等于 repo 当前的 apps/server
# version(防 stale image / 错配场景)。
expected=$(node -p "require('./apps/server/package.json').version")
actual=$(curl -fsS "http://localhost:${PORT}/api/health" | jq -r '.version')
echo "GET /api/health -> version: $actual"
if [ "$actual" != "$expected" ]; then
	echo "::error::/api/health version '$actual' != apps/server/package.json '$expected'"
	docker logs "$CONTAINER" || true
	exit 1
fi

# Dashboard 静态资源:GET / 应回 text/html 且含 React root 容器节点。
root_html=$(mktemp)
ct=$(curl -fsS -o "$root_html" -w '%{content_type}' "http://localhost:${PORT}/")
echo "GET / -> content-type: $ct"
case "$ct" in
text/html*) ;;
*)
	echo "::error::GET / expected text/html (dashboard), got '$ct'"
	head -c 400 "$root_html" || true
	docker logs "$CONTAINER" || true
	exit 1
	;;
esac

if ! grep -q '<div id="root">' "$root_html"; then
	echo "::error::GET / body is not the dashboard index.html"
	head -c 400 "$root_html"
	exit 1
fi

echo "✓ Smoke checks passed for $IMAGE_REF"
