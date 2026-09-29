#!/usr/bin/env bash
#
# 从 CHANGELOG 该版本段抽「概述」那一句,写成 step output `value` —— 进更新清单 / 市场索引
# 条目的 notes(右下角通知卡念的就是它)。抽法与规矩全在 scripts/changelog-section.mjs:
# 找不到该段 / 概述为空 / 超长它都退 1,这里随之红。所以要放在构建之前调,别等构建跑完。
#
# 两条 workflow 调用,逻辑完全相同,只差读哪份 CHANGELOG,所以是同一个脚本:
#   - update-payload.yml 的「Read release summary from CHANGELOG」
#     (不传 CHANGELOG_FILE → 读 apps/CHANGELOG.md)
#   - extension-release.yml 的「Read release summary from the extension CHANGELOG」
#     (CHANGELOG_FILE=extensions/<id>/CHANGELOG.md)
#
# 必需 env:
#   VERSION        要抽的版本号(不带 v)
#   GITHUB_OUTPUT  GHA 自带;本地跑请指向一个文件,或直接用 /dev/stdout 看
# 可选 env:
#   CHANGELOG_FILE  不传就用 changelog-section.mjs 自己的默认(apps/CHANGELOG.md)
#
# Outputs(GITHUB_OUTPUT):value=<概述,单行>
#
# 本地(仓库根):
#   VERSION=0.9.1 GITHUB_OUTPUT=/dev/stdout bash .github/scripts/shared/read-release-summary.sh

set -euo pipefail

: "${VERSION:?VERSION env 必填(要抽概述的版本号,不带 v)}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(GHA 自带;本地跑请指向一个文件)}"

args=(--version "$VERSION" --part summary)
if [ -n "${CHANGELOG_FILE:-}" ]; then
	args+=(--file "$CHANGELOG_FILE")
fi

summary=$(node scripts/changelog-section.mjs "${args[@]}")
echo "summary: $summary"
echo "value=$summary" >>"$GITHUB_OUTPUT"
