#!/usr/bin/env bash
#
# 把撤回的参数解析成一组具体值:调 scripts/revocation.mjs 校验参数、并从**真的那份已发布的
# 包**上算 sha256 / size(联网取载荷),完整 JSON 落在 /tmp/revoke.json,再逐字段写进
# $GITHUB_OUTPUT 给后面的签名 / 发布 / 汇总步骤用。
# 由 .github/workflows/revoke-update.yml 的 `Resolve revocation`(id: plan)一步调用。
#
# 输出(GITHUB_OUTPUT):
#   version / revoked / channels / payloadUrl / releaseUrl / sha256 / size
#
# 必需 env:
#   REPO    github.repository
#   TARGET  用户该在的版本(inputs.target)
#   REVOKED 要撤回的坏版本,逗号分隔(inputs.revoked)
#   CHANNEL both | stable | alpha(inputs.channel)
#
# TARGET / REVOKED / CHANNEL 只拦「没设」、不拦「空串」:参数的规矩全在 revocation.mjs 里
# (scripts/__tests__/revocation.test.mjs 钉着),空串让它按自己的话报错。
# 必须在仓库根目录跑(脚本里的 scripts/revocation.mjs 是相对路径)。

set -euo pipefail

: "${REPO:?REPO env 必填(github.repository)}"
: "${TARGET?TARGET env 必填(用户该在的版本)}"
: "${REVOKED?REVOKED env 必填(要撤回的坏版本,逗号分隔)}"
: "${CHANNEL?CHANNEL env 必填(both|stable|alpha)}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(GHA 自动提供;本地跑请指向一个临时文件)}"

node scripts/revocation.mjs \
	--repo "$REPO" \
	--target "$TARGET" \
	--revoked "$REVOKED" \
	--channel "$CHANNEL" >/tmp/revoke.json
cat /tmp/revoke.json
for k in version revoked channels payloadUrl releaseUrl sha256 size; do
	echo "$k=$(node -p "require('/tmp/revoke.json').$k")" >>"$GITHUB_OUTPUT"
done
