#!/usr/bin/env bash
#
# 拉**当前**的官方索引:滚动 release `extension-marketplace` 上那份签名信封,取出本体写成
# <DIR>/current.json,给 `scripts/marketplace-index.mjs --current` 用。
#
# ⚠️ 只有「这个 release 还不存在」才算第一次发。别的失败(5xx、限流、token 权限掉了、
# 网络抖)一律**当场红**:把它们当成「还没有索引」会并出一份只含这一条的索引 —— 连
# `revoked` 撤回名单一起清零 —— 再签名覆盖上去。一次网络抖动就能把整个市场抹掉,而整条
# 流水线全绿,没人会知道。
#
# 必需 env:
#   GH_TOKEN  gh 的 token
# 可选 env:
#   TAG       索引住的那个滚动 release,默认 extension-marketplace
#   DIR       工作目录,默认 dist
#
# 产出:<DIR>/current.json —— **第一次发时不生成**,调用方按「这个文件在不在」决定要不要
# 拼 --current。

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN env 必填}"
tag="${TAG:-extension-marketplace}"
dir="${DIR:-dist}"

mkdir -p "$dir"
# 上一步留下的残渣会被后面那句 `[ -f current.json ]` 当成「拉到了」。
rm -f "$dir/current.json" "$dir/marketplace.json"

view_err="$(mktemp)"
if gh release view "$tag" >/dev/null 2>"$view_err"; then
	# release 在,那资产就必须拿得到 —— 这儿再失败是真失败,不许吞。
	gh release download "$tag" --pattern marketplace.json --dir "$dir" --clobber
	node -e '
		const fs = require("fs");
		const dir = process.argv[1];
		const envelope = JSON.parse(fs.readFileSync(`${dir}/marketplace.json`, "utf8"));
		if (typeof envelope.manifest !== "string")
			throw new Error("marketplace.json 不是签名信封({ manifest, signature })");
		fs.writeFileSync(`${dir}/current.json`, envelope.manifest);
	' "$dir"
	echo "current index: $(node -p "JSON.parse(require('fs').readFileSync('$dir/current.json','utf8')).extensions.length") entries"
	exit 0
fi

if grep -qiE 'release not found|HTTP 404' "$view_err"; then
	echo "no marketplace index yet — starting a fresh one"
	exit 0
fi

echo "::error::拿不到当前的官方索引,而且不是「还没有」—— 这一趟不许当第一次发,否则会把整份索引连 revoked 名单一起覆盖掉"
cat "$view_err" >&2
exit 1
