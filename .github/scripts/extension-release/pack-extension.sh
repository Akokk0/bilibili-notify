#!/usr/bin/env bash
#
# 把已构建好的拓展打成拓展包(zip),并把 path / sha256 / size 写成 step output ——
# 后面上传 release 与并进官方索引都从这三个值读。
# 由 .github/workflows/extension-release.yml 的「Pack the extension package」调用。
#
# 资产名不在这儿拼:它由 scripts/release-urls.mjs 说了算(打包、索引里那条下载链接、
# 上传 release 三处必须是同一个名字),所以 `--out` 不传,路径也从 pack-extension.mjs
# 的输出里读,不自己算。
#
# 必需 env:
#   ID             拓展 id(如 bridge);extensions/<id>/dist 得已经构建好
#   GITHUB_OUTPUT  GHA 自带;本地跑请指向一个文件,或直接用 /dev/stdout 看
#
# Outputs(GITHUB_OUTPUT):path=<zip 路径> sha256=<摘要> size=<字节数>
#
# 本地(仓库根,先 vp run -F @bilibili-notify/extension-<id> build):
#   ID=bridge GITHUB_OUTPUT=/dev/stdout bash .github/scripts/extension-release/pack-extension.sh

set -euo pipefail

: "${ID:?ID env 必填(拓展 id,如 bridge)}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(GHA 自带;本地跑请指向一个文件)}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

node scripts/pack-extension.mjs --id "$ID" >"$work/pkg.json"
cat "$work/pkg.json"
{
	echo "path=$(node -p "require('$work/pkg.json').path")"
	echo "sha256=$(node -p "require('$work/pkg.json').sha256")"
	echo "size=$(node -p "require('$work/pkg.json').size")"
} >>"$GITHUB_OUTPUT"
