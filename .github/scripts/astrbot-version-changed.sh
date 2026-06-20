#!/usr/bin/env bash
# 判断 astrbot/core/metadata.yaml 的 version 是否变化,写 changed / version 到 GITHUB_OUTPUT。
# push:比对 HEAD 与 HEAD~1 的 version;dispatch:强制 changed=true(走 dry-run 预演)。

set -euo pipefail

FILE="astrbot/core/metadata.yaml"

read_ver() {
	# 取首个 `version:` 行的值(形如 v0.1.0-alpha.1),去引号与空白。
	grep -E '^version:' 2>/dev/null | head -1 | sed -E 's/^version:[[:space:]]*//; s/["'\'']//g' | tr -d '[:space:]'
}

NEW="$(read_ver <"$FILE")"
echo "version=$NEW" >>"$GITHUB_OUTPUT"

if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
	echo "changed=true" >>"$GITHUB_OUTPUT"
	echo "::notice::dispatch 预演,version=$NEW"
	exit 0
fi

OLD="$(git show HEAD~1:"$FILE" 2>/dev/null | read_ver || true)"
if [ "$NEW" != "$OLD" ]; then
	echo "changed=true" >>"$GITHUB_OUTPUT"
	echo "::notice::astrbot version ${OLD:-（无）} → ${NEW},发布"
else
	echo "changed=false" >>"$GITHUB_OUTPUT"
	echo "::notice::astrbot version 未变(${NEW}),跳过发布"
fi
