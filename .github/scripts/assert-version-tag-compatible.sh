#!/usr/bin/env bash
#
# 校验 v<VERSION> tag 与当前 commit 一致。desktop-release 负责创建 tag/release;
# image-release 只推 Docker manifest,但在推 :v<VERSION> / :alpha / :latest 前必须
# 等到同名 git tag 与桌面 GitHub Release 都就绪,避免 Docker tag 与 git tag / release
# 产物失同步。
#
# 必需 env:
#   VERSION     apps/server/package.json#version(不带 'v' 前缀)
#   GITHUB_SHA  GHA 自动注入,当前 workflow 跑的 commit SHA
# 可选 env:
#   REQUIRE_EXISTING_TAG     设为 1 时 tag 不存在也视为错误
#   REQUIRE_GITHUB_RELEASE   设为 1 时还要等待 GitHub Release 与必需 assets
#   WAIT_FOR_TAG_SECONDS     等待 tag/release 就绪的总秒数,默认 0
#   REQUIRED_RELEASE_ASSETS  REQUIRE_GITHUB_RELEASE=1 时逐行列出必需 asset 名

set -euo pipefail

: "${VERSION:?VERSION env 必填}"
: "${GITHUB_SHA:?GITHUB_SHA env 必填(GHA 自动注入)}"

require_existing="${REQUIRE_EXISTING_TAG:-0}"
require_release="${REQUIRE_GITHUB_RELEASE:-0}"
wait_seconds="${WAIT_FOR_TAG_SECONDS:-0}"
case "$wait_seconds" in
"" | *[!0-9]*)
	echo "::error::WAIT_FOR_TAG_SECONDS 必须是非负整数,got '$wait_seconds'"
	exit 1
	;;
esac
if [ "$require_release" = "1" ]; then
	: "${GH_TOKEN:?GH_TOKEN env 必填(用于读取 GitHub Release)}"
fi

tag="v$VERSION"
deadline=$((SECONDS + wait_seconds))

remote_sha=""
while true; do
	remote_sha=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | awk '
		/\^\{\}$/ { peeled = $1 }
		$0 !~ /\^\{\}$/ && NF { plain = $1 }
		END { print (peeled ? peeled : plain) }
	')
	if [ -n "$remote_sha" ]; then
		break
	fi
	if [ "$require_existing" != "1" ]; then
		echo "tag $tag does not exist yet"
		exit 0
	fi
	if [ "$SECONDS" -ge "$deadline" ]; then
		echo "::error::tag $tag 不存在,desktop-release 尚未成功创建对应 tag"
		exit 1
	fi
	sleep 15
done

if [ "$remote_sha" != "$GITHUB_SHA" ]; then
	echo "::error::tag $tag 已存在但指向 $remote_sha(当前 commit $GITHUB_SHA)"
	echo "::error::版本号被重用却换了 commit,中止以避免 Docker tag 与 git tag 失同步"
	exit 1
fi

echo "tag $tag already points at $GITHUB_SHA"

if [ "$require_release" != "1" ]; then
	exit 0
fi

repo_args=()
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
	repo_args=(--repo "$GITHUB_REPOSITORY")
fi

release_assets_ready() {
	local assets required
	if ! assets=$(gh release view "$tag" "${repo_args[@]}" --json assets --jq '.assets[].name' 2>/dev/null); then
		return 1
	fi
	while IFS= read -r required; do
		[ -z "$required" ] && continue
		if ! grep -Fxq -- "$required" <<<"$assets"; then
			return 1
		fi
	done <<<"${REQUIRED_RELEASE_ASSETS:-}"
	return 0
}

while true; do
	if release_assets_ready; then
		echo "release $tag and required desktop assets are ready"
		exit 0
	fi
	if [ "$SECONDS" -ge "$deadline" ]; then
		echo "::error::release $tag 或其必需桌面 assets 尚未就绪"
		gh release view "$tag" "${repo_args[@]}" --json assets --jq '.assets[].name' || true
		exit 1
	fi
	sleep 15
done
