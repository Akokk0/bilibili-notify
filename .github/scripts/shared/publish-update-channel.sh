#!/usr/bin/env bash
#
# 把签好的清单挂到滚动的 `update-channel` release 上,当作各渠道的固定入口。
# 滚动 release 那套机制(为什么不是 `releases/latest`、为什么标 prerelease)见
# `publish-rolling-asset.sh`;这里只管**这条渠道**自己的那点事。
#
# 必需 env:
#   CHANNEL   stable | alpha
#   FILE      签好的信封文件(内容会被上传成 <CHANNEL>.json)
#   GH_TOKEN  secrets.RELEASE_PAT
#   REPO      github.repository

set -euo pipefail

: "${CHANNEL:?CHANNEL env 必填(stable|alpha)}"

case "$CHANNEL" in
stable | alpha) ;;
*)
	echo "::error::CHANNEL 必须是 'stable' 或 'alpha',got '$CHANNEL'"
	exit 1
	;;
esac

export TAG="update-channel"
export TITLE="Update Channel"
export NOTES="Manifests for in-app updates. Maintained automatically."
export ASSET="${CHANNEL}.json"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case "${CHANNEL_ACTION:-release}" in
release)
	tmp=$(mktemp -d)
	trap 'rm -rf -- "$tmp"' EXIT
	if asset_id=$(gh api "repos/$REPO/releases/tags/$TAG" --jq ".assets[] | select(.name == \"$ASSET\") | .id" 2>"$tmp/error"); then
		if [ -n "$asset_id" ]; then
			gh api -H 'Accept: application/octet-stream' "repos/$REPO/releases/assets/$asset_id" >"$tmp/current"
			decision=$(node "$script_dir/../../../scripts/compare-update-channel.mjs" "$tmp/current" "$FILE")
			if [ "$decision" = skip ]; then
				echo "Kept the current $CHANNEL channel manifest."
				exit 0
			fi
		fi
	elif ! grep -q '(HTTP 404)' "$tmp/error"; then
		cat "$tmp/error" >&2
		exit 1
	fi
	;;
revoke) ;;
*)
	echo "::error::Unknown channel action" >&2
	exit 1
	;;
esac
bash "$script_dir/publish-rolling-asset.sh"
