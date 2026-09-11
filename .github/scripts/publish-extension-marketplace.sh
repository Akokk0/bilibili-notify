#!/usr/bin/env bash
#
# 把签好的官方索引挂到**滚动的** `extension-marketplace` release 上,当作拓展市场的固定入口。
# 与本体的 `update-channel` **分开一个 release**:任何一方发坏了都不牵连另一方,两条发布
# 流水线也不用排同一把锁。同域同前缀,主人填的那条加速前缀照样管得住。
#
# 必需 env:
#   FILE      签好的信封文件(内容会被上传成 marketplace.json)
#   GH_TOKEN  secrets.RELEASE_PAT
#   REPO      github.repository

set -euo pipefail

: "${FILE:?FILE env 必填}"
: "${GH_TOKEN:?GH_TOKEN env 必填}"
: "${REPO:?REPO env 必填}"

if [ ! -s "$FILE" ]; then
	echo "::error::索引文件不存在或为空:$FILE"
	exit 1
fi

tag="extension-marketplace"

if ! gh release view "$tag" >/dev/null 2>&1; then
	gh release create "$tag" \
		--title "Extension Marketplace" \
		--notes "Signed index of official extensions. Maintained automatically." \
		--prerelease --latest=false
fi

staged="$(mktemp -d)/marketplace.json"
cp "$FILE" "$staged"
gh release upload "$tag" "$staged" --clobber

echo "published marketplace.json → https://github.com/${REPO}/releases/download/${tag}/marketplace.json"
