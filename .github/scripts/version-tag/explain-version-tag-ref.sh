#!/usr/bin/env bash
#
# version-tag 只能在 dev 上跑 —— 在别的 ref 上被触发时,说清楚为什么并让 job 失败。
# 由 .github/workflows/version-tag.yml 的 `Explain allowed ref` 一步调用
# (该 job 只在 github.ref != refs/heads/dev 时才会跑到这里)。本地手动跑:
#
#   GITHUB_REF=refs/heads/main bash .github/scripts/version-tag/explain-version-tag-ref.sh
#
# 必需 env:
#   GITHUB_REF  触发这次运行的 ref(GHA 自动提供)

set -euo pipefail

: "${GITHUB_REF:?GITHUB_REF env 必填(GHA 自动提供;本地跑请手动指定)}"

echo "::error::version-tag can only run on dev; got $GITHUB_REF"
echo "::error::switch the workflow ref to dev before creating or dry-running a app tag"
exit 1
