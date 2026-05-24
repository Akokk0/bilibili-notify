#!/usr/bin/env bash
#
# 读独立端版本号(apps/server/package.json#version)写到 $GITHUB_OUTPUT 供后续
# step 引用。版本号是手动维护的唯一事实源 —— 含 prerelease 标识(有 `-`,
# 如 0.1.0-alpha.0)→ alpha 渠道,否则正式渠道。
#
# 必需 env:
#   GITHUB_OUTPUT  GHA 自动注入,本脚本只在 CI 环境跑
#
# 输出:
#   value=<version>           apps/server/package.json#version 原值
#   prerelease=true|false     按是否含 '-' 判定

set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(只在 GHA 内跑)}"

v=$(node -p "require('./apps/server/package.json').version")
echo "value=$v" >>"$GITHUB_OUTPUT"
if [[ "$v" == *-* ]]; then
	echo "prerelease=true" >>"$GITHUB_OUTPUT"
else
	echo "prerelease=false" >>"$GITHUB_OUTPUT"
fi
