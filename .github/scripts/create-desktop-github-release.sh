#!/usr/bin/env bash
#
# 给 v<VERSION> tag 创建桌面端 GitHub Release。已有 release 跳过,后续 upload step
# 仍可用 --clobber 补/覆盖 artifacts。Docker 镜像由 image-release workflow 推送,
# release notes 这里只列本 workflow 已经产出的桌面产物。
#
# 必需 env:
#   VERSION     release version without leading 'v'
#   PRERELEASE  "true"|"false" 决定 --prerelease / --latest 标记
#   GH_TOKEN    secrets.RELEASE_PAT
#   REPO        github.repository(如 Akokk0/bilibili-notify),用于 compare 链接

set -euo pipefail

: "${VERSION:?VERSION env 必填}"
: "${PRERELEASE:?PRERELEASE env 必填(true|false)}"
: "${GH_TOKEN:?GH_TOKEN env 必填(走 RELEASE_PAT)}"
: "${REPO:?REPO env 必填(github.repository)}"

case "$PRERELEASE" in
true | false) ;;
*)
	echo "::error::PRERELEASE 必须是 'true' 或 'false',got '$PRERELEASE'"
	exit 1
	;;
esac
if [[ "$VERSION" == *-* && "$PRERELEASE" != "true" ]]; then
	echo "::error::VERSION '$VERSION' 含 prerelease 标识但 PRERELEASE='$PRERELEASE'"
	exit 1
fi
if [[ "$VERSION" != *-* && "$PRERELEASE" != "false" ]]; then
	echo "::error::VERSION '$VERSION' 是稳定版但 PRERELEASE='$PRERELEASE'"
	exit 1
fi

tag="v$VERSION"

if gh release view "$tag" >/dev/null 2>&1; then
	echo "release $tag already exists, skip create"
	exit 0
fi

git fetch --tags --quiet
prev_tag=$(git tag --sort=-creatordate --list 'v*' | grep -v "^$tag$" | head -1 || true)

notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT
{
	echo "## 桌面应用"
	echo
	echo "- macOS arm64: 下载 DMG 或 .app.zip"
	echo "- Windows x64: 下载 setup.exe 或 portable zip"
	if [ -n "$prev_tag" ]; then
		echo
		echo "## 完整改动"
		echo
		echo "[\`$prev_tag...$tag\`](https://github.com/$REPO/compare/$prev_tag...$tag)"
	fi
} >"$notes_file"

flags=(--title "$tag" --notes-file "$notes_file")
if [ "$PRERELEASE" = "true" ]; then
	flags+=(--prerelease --latest=false)
else
	flags+=(--latest)
fi

gh release create "$tag" "${flags[@]}"
