#!/usr/bin/env bash
#
# 把签好的官方索引挂到滚动的 `extension-marketplace` release 上,当作拓展市场的固定入口。
# 与本体的 `update-channel` **分开一个 release**:任何一方发坏了都不牵连另一方,两条发布
# 流水线也不用排同一把锁。同域同前缀,主人填的那条加速前缀照样管得住。
#
# 滚动 release 那套机制见 `publish-rolling-asset.sh`。
#
# 必需 env:
#   FILE      签好的信封文件(内容会被上传成 marketplace.json)
#   GH_TOKEN  secrets.RELEASE_PAT
#   REPO      github.repository

set -euo pipefail

export TAG="extension-marketplace"
export TITLE="Extension Marketplace"
export NOTES="Signed index of official extensions. Maintained automatically."
export ASSET="marketplace.json"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "$script_dir/publish-rolling-asset.sh"
