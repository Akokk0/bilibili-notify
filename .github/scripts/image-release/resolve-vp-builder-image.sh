#!/usr/bin/env bash
#
# 从根 package.json 读 vite-plus 的精确版本,拼出 Docker builder 镜像的 ref
# (ghcr.io/voidzero-dev/vite-plus:<version>),经 GITHUB_OUTPUT 的 `image` 传给后面的
# build-push,作为 Dockerfile 的 VP_BUILDER_IMAGE build-arg。版本不是精确的
# major.minor.patch(写成了范围)时拼出来的 tag 根本不存在,所以直接报错。
# 由 .github/actions/build-push-image-digest/action.yml 的 `Resolve Vite+ builder image`
# (id: vp)一步调用。本地手动跑(必须在仓库根目录,package.json 是相对路径):
#
#   GITHUB_OUTPUT=/tmp/out.txt bash .github/scripts/image-release/resolve-vp-builder-image.sh
#
# 输出(GITHUB_OUTPUT):
#   image=ghcr.io/voidzero-dev/vite-plus:<version>

set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(GHA 自动提供;本地跑请指向一个临时文件)}"

version=$(node -p "require('./package.json').devDependencies['vite-plus']")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "::error::root vite-plus must be an exact version to name the builder image, got '$version'"
	exit 1
fi
echo "image=ghcr.io/voidzero-dev/vite-plus:$version" >>"$GITHUB_OUTPUT"
