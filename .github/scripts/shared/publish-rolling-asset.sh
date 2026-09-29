#!/usr/bin/env bash
#
# 把一个文件覆盖上传到一个**滚动的** release 上,当作某样东西的固定入口。
#
# 为什么是滚动 tag,而不是 `releases/latest/download/`:后者按定义指向最新的**正式**发布,
# 预发布渠道就永远拿不到自己那份。滚动 tag 每一档都覆盖得到,而且**不需要碰 `api.github.com`**
# —— 代理站不代理 API,API 的回答上也没有我们的签名。同域同前缀还意味着用户填一条加速前缀
# 就同时管住清单和载荷。
#
# release 被标成 prerelease,只是为了别把仓库的「Latest release」badge 抢走。
#
# 调用方(`publish-update-channel.sh` / `publish-extension-marketplace.sh`)各自开**一个**
# release:任何一方发坏了都不牵连另一方,两条发布流水线也不用排同一把锁。它们只填下面这几
# 格,再加自己那点参数校验。
#
# 必需 env:
#   TAG       滚动 release 的 tag
#   TITLE     release 标题(第一次创建时用)
#   NOTES     release 正文(第一次创建时用)
#   ASSET     上传上去之后叫什么名字
#   FILE      要上传的文件
#   GH_TOKEN  secrets.RELEASE_PAT
#   REPO      github.repository

set -euo pipefail

: "${TAG:?TAG env 必填}"
: "${TITLE:?TITLE env 必填}"
: "${NOTES:?NOTES env 必填}"
: "${ASSET:?ASSET env 必填}"
: "${FILE:?FILE env 必填}"
: "${GH_TOKEN:?GH_TOKEN env 必填}"
: "${REPO:?REPO env 必填}"

if [ ! -s "$FILE" ]; then
	echo "::error::要发布成 ${ASSET} 的文件不存在或为空:$FILE"
	exit 1
fi

if ! gh release view "$TAG" >/dev/null 2>&1; then
	gh release create "$TAG" \
		--title "$TITLE" \
		--notes "$NOTES" \
		--prerelease --latest=false
fi

# 上传时的资产名取自**磁盘上的文件名**,所以先摆成目标名字再传。
staged="$(mktemp -d)/${ASSET}"
cp "$FILE" "$staged"
gh release upload "$TAG" "$staged" --clobber

echo "published ${ASSET} → https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
