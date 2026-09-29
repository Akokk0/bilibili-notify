#!/usr/bin/env bash
#
# 把这次撤回的参数写进 job summary,dry-run 时用来在真发之前看一眼解析结果对不对。
# 由 .github/workflows/revoke-update.yml 的 `Summary` 一步调用。本地手动跑:
#
#   GITHUB_STEP_SUMMARY=/tmp/summary.md REVOKED=0.9.1 VERSION=0.9.0 \
#     CHANNELS='stable alpha' DRY_RUN=true bash .github/scripts/revoke-update/summarize-revocation.sh
#
# 必需 env:
#   REVOKED  撤回的坏版本(steps.plan.outputs.revoked)
#   VERSION  用户会被送到的版本(steps.plan.outputs.version)
#   CHANNELS 刷了哪些渠道(steps.plan.outputs.channels)
#   DRY_RUN  inputs.dry_run
#
# 这一步排在发布之后,纯展示:四个值只拦「没设」、不拦「空串」,别让汇总一步把已经发出去
# 的撤回标成红。

set -euo pipefail

: "${REVOKED?REVOKED env 必填(撤回的坏版本)}"
: "${VERSION?VERSION env 必填(用户会被送到的版本)}"
: "${CHANNELS?CHANNELS env 必填(刷了哪些渠道)}"
: "${DRY_RUN?DRY_RUN env 必填(true|false)}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY env 必填(GHA 自动提供;本地跑请指向一个临时文件)}"

{
	echo "### 撤回"
	echo ""
	echo "- 撤回:\`$REVOKED\`"
	echo "- 用户会被送到:\`$VERSION\`"
	echo "- 渠道:\`$CHANNELS\`"
	echo "- dry-run:\`$DRY_RUN\`"
} >>"$GITHUB_STEP_SUMMARY"
