#!/usr/bin/env bash
#
# 校验 v<VERSION> tag 与当前 commit 一致。version-tag workflow 负责创建 tag;
# Docker 与 Desktop release 在发布前都只校验这个共同版本锚点,避免产物与 git tag
# 失同步。
#
# 必需 env:
#   VERSION     apps/server/package.json#version(不带 'v' 前缀)
#   GITHUB_SHA  GHA 自动注入,当前 workflow 跑的 commit SHA
# 可选 env:
#   EXPECTED_COMMIT_SHA      期望 tag 指向的 commit;未设时优先用当前 checkout HEAD,
#                            再回退 GITHUB_SHA。tag push 事件下 GITHUB_SHA 可能是
#                            annotated tag object,所以 release workflow 应依赖 HEAD。
#   REQUIRE_EXISTING_TAG     设为 1 时 tag 不存在也视为错误
#   REQUIRE_GITHUB_RELEASE   设为 1 时还要等待 GitHub Release 与必需 assets
#   WAIT_FOR_TAG_SECONDS     等待 tag/release 就绪的总秒数,默认 0
#   REQUIRED_RELEASE_ASSETS  REQUIRE_GITHUB_RELEASE=1 时逐行列出必需 asset 名

set -euo pipefail

: "${VERSION:?VERSION env 必填}"
: "${GITHUB_SHA:?GITHUB_SHA env 必填(GHA 自动注入)}"

expected_sha="${EXPECTED_COMMIT_SHA:-}"
if [ -z "$expected_sha" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	expected_sha=$(git rev-parse HEAD)
fi
expected_sha="${expected_sha:-$GITHUB_SHA}"

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
		echo "::error::tag $tag 不存在,version-tag workflow 尚未成功创建对应 tag"
		exit 1
	fi
	sleep 15
done

if [ "$remote_sha" != "$expected_sha" ]; then
	echo "::error::tag $tag 已存在但指向 $remote_sha(当前 commit $expected_sha)"
	echo "::error::版本号被重用却换了 commit,中止以避免 release 产物与 git tag 失同步"
	exit 1
fi

echo "tag $tag already points at $expected_sha"

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
