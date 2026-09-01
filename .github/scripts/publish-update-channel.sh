#!/usr/bin/env bash
#
# 把签好的清单挂到**滚动的** `update-channel` release 上,当作各渠道的固定入口。
#
# 为什么是一个滚动 tag,而不是 `releases/latest/download/`:后者按定义指向最新的
# **正式**发布,预发布渠道就永远拿不到自己那份清单。滚动 tag 两个渠道都覆盖得到,
# 而且**不需要碰 `api.github.com`** —— 代理站不代理 API,API 的回答上也没有我们的
# 签名。同域同前缀还意味着用户填一条加速前缀就同时管住清单和载荷。
#
# 它被标成 prerelease,只是为了别把仓库的「Latest release」badge 抢走。
#
# 必需 env:
#   CHANNEL   stable | alpha
#   FILE      签好的信封文件(内容会被上传成 <CHANNEL>.json)
#   GH_TOKEN  secrets.RELEASE_PAT
#   REPO      github.repository

set -euo pipefail

: "${CHANNEL:?CHANNEL env 必填(stable|alpha)}"
: "${FILE:?FILE env 必填}"
: "${GH_TOKEN:?GH_TOKEN env 必填}"
: "${REPO:?REPO env 必填}"

case "$CHANNEL" in
stable | alpha) ;;
*)
	echo "::error::CHANNEL 必须是 'stable' 或 'alpha',got '$CHANNEL'"
	exit 1
	;;
esac

if [ ! -s "$FILE" ]; then
	echo "::error::清单文件不存在或为空:$FILE"
	exit 1
fi

tag="update-channel"

if ! gh release view "$tag" >/dev/null 2>&1; then
	gh release create "$tag" \
		--title "Update Channel" \
		--notes "Manifests for in-app updates. Maintained automatically." \
		--prerelease --latest=false
fi

# 上传时的资产名取自**磁盘上的文件名**,所以先摆成目标名字再传。
staged="$(mktemp -d)/${CHANNEL}.json"
cp "$FILE" "$staged"
gh release upload "$tag" "$staged" --clobber

echo "published ${CHANNEL}.json → https://github.com/${REPO}/releases/download/${tag}/${CHANNEL}.json"
