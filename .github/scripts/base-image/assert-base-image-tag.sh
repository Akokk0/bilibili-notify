#!/usr/bin/env bash
#
# chromium base 镜像的 tag 格式守卫:必须形如 b1 / b2(不可变递增编号)。
# 由 .github/workflows/base-image.yml 的 `Validate tag format` 一步调用,也支持
# 本地手动跑:
#
#   TAG=b3 bash .github/scripts/base-image/assert-base-image-tag.sh
#
# 必需 env:
#   TAG  workflow_dispatch 填的 base tag(inputs.tag)
#
# 只拦「没设」、不拦「空串」:空串要走到下面的格式判断,报出同一句「得到: 」。

set -euo pipefail

: "${TAG?TAG env 必填(base 镜像 tag,如 b1)}"

if ! printf '%s' "$TAG" | grep -Eq '^b[0-9]+$'; then
	echo "::error::tag 必须形如 b1 / b2(不可变递增),得到: $TAG"
	exit 1
fi
