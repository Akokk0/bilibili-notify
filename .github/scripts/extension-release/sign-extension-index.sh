#!/usr/bin/env bash
#
# 把这次发的拓展并进官方索引并签名:先由 env 拼出这一条的条目,再与上一步拉下来的当前
# 索引(dist/current.json)合并、重签,写成 dist/marketplace-next.{json,sig.json}。
# 由 .github/workflows/extension-release.yml 的「Merge this entry and sign the index」调用,
# 前一步是 fetch-marketplace-index.sh(产出 dist/current.json)。
#
# dist/current.json **第一次发时不存在**(fetch-marketplace-index.sh 的约定),有才拼
# --current。合并 / 签名的逻辑都在 scripts/marketplace-{entry,index}.mjs 里,这里只接线。
# 合并后的索引本来就是公开发布的东西,打进日志让 dry-run 也能核对。
#
# 必需 env(ID / VERSION / PRERELEASE / REPO / SHA256 / SIZE / NOTES 由 marketplace-entry.mjs
# 从环境里读,这里只负责断言它们在):
#   BN_UPDATE_SIGNING_KEY  secrets.BN_UPDATE_SIGNING_KEY(marketplace-index.mjs 读)
#   ID          拓展 id
#   VERSION     拓展版本
#   PRERELEASE  "true"|"false"
#   REPO        github.repository
#   SHA256      拓展包摘要(pack-extension.sh 的输出)
#   SIZE        拓展包字节数(pack-extension.sh 的输出)
#   NOTES       条目上那句概述

set -euo pipefail

: "${BN_UPDATE_SIGNING_KEY:?BN_UPDATE_SIGNING_KEY env 必填(走 secrets.BN_UPDATE_SIGNING_KEY)}"
: "${ID:?ID env 必填(拓展 id)}"
: "${VERSION:?VERSION env 必填(拓展版本)}"
: "${PRERELEASE:?PRERELEASE env 必填(true|false)}"
: "${REPO:?REPO env 必填(github.repository)}"
: "${SHA256:?SHA256 env 必填(拓展包摘要)}"
: "${SIZE:?SIZE env 必填(拓展包字节数)}"
: "${NOTES:?NOTES env 必填(条目上那句概述)}"

node scripts/marketplace-entry.mjs --out dist/entry.json
current_args=()
if [ -f dist/current.json ]; then current_args=(--current dist/current.json); fi
# `${a[@]+…}`:bash < 4.4(如 macOS 自带的 3.2)在 set -u 下展开空数组会报 unbound variable。
node scripts/marketplace-index.mjs --entry dist/entry.json ${current_args[@]+"${current_args[@]}"} --out dist/marketplace-next
cat dist/marketplace-next.json
