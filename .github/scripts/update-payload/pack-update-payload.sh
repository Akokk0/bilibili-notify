#!/usr/bin/env bash
#
# 把 `vp run build:update-payload` 装配好的产物打成升级载荷 zip,并把 path / sha256 / size
# 写成 step output —— 签清单与上传 release 都从这三个值读。
# 由 .github/workflows/update-payload.yml 的「Pack payload zip」调用。
#
# 资产名 `bilibili-notify-payload-<VERSION>.zip` 由 scripts/release-urls.mjs 的
# payloadAssetName() 声明;这里拼的、sign-payload-manifest.sh 里清单指向的下载链接、
# create-standalone-github-release.sh 念给用户的文件名必须是同一个名字,
# release-urls.test.mjs 会拿这几个文件去对。
#
# 必需 env:
#   VERSION        独立端版本(不带 v)
#   GITHUB_OUTPUT  GHA 自带;本地跑请指向一个文件,或直接用 /dev/stdout 看
#
# Outputs(GITHUB_OUTPUT):path=<zip 路径> sha256=<摘要> size=<字节数>
#
# 本地(仓库根,先 vp run build:update-payload):
#   VERSION=0.0.0-dev GITHUB_OUTPUT=/dev/stdout bash .github/scripts/update-payload/pack-update-payload.sh

set -euo pipefail

: "${VERSION:?VERSION env 必填(独立端版本,不带 v)}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(GHA 自带;本地跑请指向一个文件)}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

out="dist/bilibili-notify-payload-${VERSION}.zip"
node scripts/build-update-payload.mjs --out "$out" >"$work/payload.json"
{
	echo "path=$out"
	echo "sha256=$(node -p "require('$work/payload.json').sha256")"
	echo "size=$(node -p "require('$work/payload.json').size")"
} >>"$GITHUB_OUTPUT"
