#!/usr/bin/env bash
#
# 给 v<VERSION> tag 创建对应 GitHub Release。Release 必须挂在已存在的 tag 上,
# 所以这步必须跑在 tag-commit-with-version.sh 之后。已有 release 跳过(workflow
# rerun / 同 version 重 trigger 场景)。
#
# Release notes 包含两条 docker pull 命令(:v<VERSION> 不可变 tag + 滚动渠道
# :alpha/:latest),以及到上一个 v* tag 的 GitHub compare 链接。
#
# 必需 env:
#   VERSION     apps/server/package.json#version
#   PRERELEASE  "true"|"false" 决定 --prerelease / --latest 标记
#   GH_TOKEN    secrets.RELEASE_PAT(默认 GITHUB_TOKEN 受 workflow ref restriction)
#   REPO        github.repository(如 Akokk0/bilibili-notify),用于 compare 链接

set -euo pipefail

: "${VERSION:?VERSION env 必填}"
: "${PRERELEASE:?PRERELEASE env 必填(true|false)}"
: "${GH_TOKEN:?GH_TOKEN env 必填(走 RELEASE_PAT)}"
: "${REPO:?REPO env 必填(github.repository)}"

tag="v$VERSION"

if gh release view "$tag" >/dev/null 2>&1; then
	echo "release $tag already exists, skip"
	exit 0
fi

# 上一个 v* tag —— release notes 里给 GitHub compare 链接。本地默认没拉 tags 先 fetch。
git fetch --tags --quiet
prev_tag=$(git tag --sort=-creatordate --list 'v*' | grep -v "^$tag$" | head -1 || true)

if [ "$PRERELEASE" = "true" ]; then
	channel="alpha"
else
	channel="latest"
fi

notes_file=$(mktemp)
{
	echo "## Docker 镜像"
	echo
	echo "不可变 tag:"
	echo
	echo '```bash'
	echo "docker pull akokk0/bilibili-notify:$tag"
	echo '```'
	echo
	echo "滚动 \`:$channel\` 渠道:"
	echo
	echo '```bash'
	echo "docker pull akokk0/bilibili-notify:$channel"
	echo '```'
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
