#!/usr/bin/env bash
#
# 给 v<VERSION> tag 创建独立端的 GitHub Release。
#
# **desktop-release 与 update-payload 两条 workflow 都调它,谁先到谁建**,另一个看到
# 已存在就跳过,各自再用 `gh release upload --clobber` 把自己的产物补上去。两条路
# 互不等待 —— 以前 update-payload 干等 desktop 建 release,桌面构建一挂(或者慢过
# 十分钟)载荷和渠道清单就一起发不出去,用户永远「已是最新」。
#
# 两条 workflow 可能同时走到 `gh release create`:一个成功、另一个报「已存在」。
# 所以 create 失败后再 view 一次,存在就算成功 —— 幂等是这个脚本的全部意义。
#
# Docker 镜像由 image-release workflow 推送;release 正文 = apps/CHANGELOG.md 该版本段全文
# (经 scripts/changelog-section.mjs 抽,与更新清单的 notes 同源)+ 独立端产物清单。
# CHANGELOG 里没有这一版就红:tag 必须指向已含 CHANGELOG 的 commit,这是发版的规矩。
#
# 必需 env:
#   VERSION     release version without leading 'v'
#   PRERELEASE  "true"|"false" 决定 --prerelease / --latest 标记
#   GH_TOKEN    secrets.RELEASE_PAT
#   REPO        github.repository(如 Akokk0/bilibili-notify),用于 compare 链接
# 可选 env:
#   CHANGELOG_FILE  默认仓库里的 apps/CHANGELOG.md;测试用它指到夹具

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

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
changelog_file="${CHANGELOG_FILE:-$repo_root/apps/CHANGELOG.md}"
if ! section=$(node "$repo_root/scripts/changelog-section.mjs" --version "$VERSION" --part section --file "$changelog_file"); then
	echo "::error::CHANGELOG 里没有 [$VERSION] 这一段,release 正文没法写 —— 先补 CHANGELOG 再打 tag"
	exit 1
fi

git fetch --tags --quiet
prev_tag=$(git tag --sort=-creatordate --list 'v*' | grep -v "^$tag$" | head -1 || true)

notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT
{
	echo "$section"
	echo
	echo "---"
	echo
	echo "## 桌面应用"
	echo
	echo "- macOS arm64: 下载 DMG 或 .app.zip"
	echo "- Windows x64: 下载 setup.exe 或 portable zip"
	echo
	echo "## 应用内更新"
	echo
	echo "- \`bilibili-notify-payload-${VERSION}.zip\` + \`manifest.sig.json\`:已装独立端的用户在面板里「检查更新」即可,不必手动下载"
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

if gh release create "$tag" "${flags[@]}"; then
	exit 0
fi

# 另一条 workflow 抢先建了 —— 那就是我们要的状态。真失败的话 view 也过不了。
if gh release view "$tag" >/dev/null 2>&1; then
	echo "release $tag was created concurrently, continue"
	exit 0
fi
echo "::error::gh release create $tag failed and the release does not exist"
exit 1
