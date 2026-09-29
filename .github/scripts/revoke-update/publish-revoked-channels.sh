#!/usr/bin/env bash
#
# 把签好的撤回清单(dist/manifest.sig.json)逐条渠道刷到滚动的 `update-channel` release
# 上。每条渠道怎么上传全在 publish-update-channel.sh 里,这里只负责按渠道清单循环。
# 由 .github/workflows/revoke-update.yml 的 `Publish channel manifests` 一步调用
# (dry-run 不跑)。会写 GitHub release,只在 CI 里跑。
#
# 必需 env:
#   CHANNELS  空格分隔的渠道列表(steps.plan.outputs.channels,如 `stable alpha`)
#   GH_TOKEN  secrets.RELEASE_PAT(原样传给 publish-update-channel.sh)
#   REPO      github.repository(同上)
#
# 必须在仓库根目录跑(dist/manifest.sig.json 是相对路径)。

set -euo pipefail

# 空串是合法输入(那就一条渠道都不刷),所以只拦「没设」。
: "${CHANNELS?CHANNELS env 必填(空格分隔的渠道,如 'stable alpha')}"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# CHANNELS 是空格分隔的多个渠道,靠不加引号的展开切词。
for channel in $CHANNELS; do
	CHANNEL="$channel" FILE=dist/manifest.sig.json \
		bash "$script_dir/../shared/publish-update-channel.sh"
done
