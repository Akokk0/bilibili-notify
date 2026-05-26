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

# SemVer 校验 + Docker tag 兼容性:
#   - 拒 malformed version 污染 $GITHUB_OUTPUT(换行 / 控制字符破坏 GHA output 格式)
#   - 拒 SemVer 的 `+build` metadata —— 该 version 会被拼成 docker tag `v<version>`,
#     Docker tag 规则不允许 `+`(仅 [a-zA-Z0-9_.-])。允许 `+build` 会让 git tag 推
#     成功后 manifest 阶段才失败,留下 git tag 在但 Docker manifest 没推的 partial
#     release 状态,跟 tag-first 设计冲突。本项目实际也不用 +build。
#   - 允许 X.Y.Z 与 X.Y.Z-prerelease(prerelease identifier 仅 [0-9A-Za-z.-])
#   - $ 锚定行末防尾随空白 / 换行
if [[ ! "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
	echo "::error::apps/server/package.json#version 不是有效 SemVer 或含 Docker tag 不兼容字符:'$v'"
	echo "::error::允许 X.Y.Z 或 X.Y.Z-prerelease(如 0.1.0-alpha.0);不允许 +build metadata"
	exit 1
fi

echo "value=$v" >>"$GITHUB_OUTPUT"
if [[ "$v" == *-* ]]; then
	echo "prerelease=true" >>"$GITHUB_OUTPUT"
else
	echo "prerelease=false" >>"$GITHUB_OUTPUT"
fi
