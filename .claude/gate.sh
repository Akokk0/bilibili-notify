#!/usr/bin/env bash
# kit 提供 GATE_SLICE_TESTS 时只跑相关测试。vp run gate 显式选择全量。
set -euo pipefail
shopt -s nullglob
cd "$(git rev-parse --show-toplevel)"

full=false
if [[ ${1-} == --full ]]; then
	full=true
	shift
fi
base=
if [[ $# == 2 && $1 == --base && -n $2 ]]; then
	base=$2
elif [[ $# != 0 ]]; then
	echo 'Usage: vp run gate [--base <verified-commit>]' >&2
	exit 2
fi

unset BN_MIGRATION_TIMING BN_DESKTOP_LIFECYCLE
vp run check
BN_RUNTIME_PROFILE=production NODE_ENV=production vp run build
vp run typecheck:after-build
export BN_GATE_WEB_DIST="$PWD/apps/web/dist"

if [[ $full == false && -n ${GATE_SLICE_TESTS-} ]]; then
	# 每轮带上扫源码的守卫，四个进程以内避免扫描超时。
	always=()
	for f in scripts/source-scan.mjs apps/web/src/__tests__/walk.ts apps/web/src/__tests__/source-text.ts \
		scripts/__tests__/*.test.* apps/*/src/__tests__/*-{conformance,coverage,boundary,isolation}.test.ts; do
		always+=(--always "$f")
	done
	exec bash "$GATE_SLICE_TESTS" "${always[@]}" -- --maxWorkers=4
fi

desktop=(apps/desktop scripts/__tests__/desktop-sidecar-lifecycle.test.mjs scripts/desktop-layout.mjs .github/workflows/rust-check.yml .node-version)
cache=node_modules/.cache/bn-gate
platform=$(uname -s)
receipt="$cache/desktop-$platform-$(uname -m)"
if [[ -z $base && -s $receipt ]]; then
	IFS= read -r base < "$receipt"
fi
# Git diff 同时覆盖已提交、已暂存及工作区内容，未跟踪的桌面文件也需要验证。
desktop_matches() {
	local commit untracked
	[[ -n $1 ]] &&
		commit=$(git rev-parse --verify --quiet --end-of-options "$1^{commit}") &&
		git diff --quiet --no-ext-diff "$commit" -- "${desktop[@]}" &&
		untracked=$(git ls-files --others --exclude-standard -- "${desktop[@]}") &&
		[[ -z $untracked ]]
}

head=$(git rev-parse HEAD)
if desktop_matches "$base"; then
	echo "Desktop inputs match verified baseline $base. Skipping native checks."
else
	vp run check:desktop
	if [[ $platform == Darwin ]]; then export BN_DESKTOP_LIFECYCLE=1; fi
fi
vp run test
vp run test:panel-locale

# 测过未提交的桌面输入时不能把 HEAD 记成已验证。失败也不能推进基线。
if desktop_matches "$head"; then
	mkdir -p "$cache"
	tmp=$(mktemp "$receipt.XXXXXXXX")
	printf '%s\n' "$head" > "$tmp"
	mv -f "$tmp" "$receipt"
fi
