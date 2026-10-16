#!/usr/bin/env bash
#
# 把签好的官方索引挂到滚动的 `extensions` release 上,当作拓展市场的固定入口。
# 与本体的 `update-channel` **分开一个 release**:任何一方发坏了都不牵连另一方,两条发布
# 流水线也不用排同一把锁。同域同前缀,主人填的那条加速前缀照样管得住。
#
# 旧的 `extension-marketplace` release 是 0.12 读的、已冻结,这里不再写它:放宽后的索引
# (同 id 同档按契约版本各留一条)0.12 的校验会整份拒收。客户端读哪个 release 由
# `apps/server/src/update/trusted-keys.ts` 的 `EXTENSION_MARKETPLACE_URL` 定,名字要一致。
#
# 滚动 release 那套机制见 `publish-rolling-asset.sh`。
#
# 必需 env:
#   FILE      签好的信封文件(内容会被上传成 marketplace.json)
#   GH_TOKEN  secrets.RELEASE_PAT
#   REPO      github.repository

set -euo pipefail

export TAG="extensions"
export TITLE="Extensions"
export NOTES="Signed index of official extensions, read by current builds of Bilibili-Notify. Maintained automatically; do not edit. Version 0.12 reads the frozen extension-marketplace release instead."
export ASSET="marketplace.json"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "$script_dir/../shared/publish-rolling-asset.sh"
