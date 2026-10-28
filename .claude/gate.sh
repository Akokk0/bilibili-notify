#!/usr/bin/env bash
# 片级门禁：kit 插件的交付门禁回合结束时跑它；全量是 kit:gate 的 run --full，和 CI 的 gate.yml 同一套。
# lint、构建、类型检查照跑全仓（加起来约 20 秒）；测试交给插件的 slice-tests.sh，只跑和改动相关的
# （改动的源码、所属包的入口、扫源码的守卫测试；改到配置就跑全部）。直接手跑、没有插件传路径时跑全部测试。
set -euo pipefail
shopt -s nullglob
cd "$(git rev-parse --show-toplevel)"

vp run check
vp run build
vp run typecheck

[ -n "${GATE_SLICE_TESTS-}" ] || exec vp run test

# 守卫每轮都跑。三类 grep 不到的：经扫描工具读源码的（交工具文件，引用它的测试都跑）、
# scripts/__tests__ 的全仓棘轮、面板和服务端按名字认得出的守卫（直接用 fs/promises 读文件）。
# 限 4 个进程：并发全开时整仓扫描的守卫会撞 5 秒上限，风扇也吵
always=()
for f in scripts/source-scan.mjs apps/web/src/__tests__/walk.ts apps/web/src/__tests__/source-text.ts \
	scripts/__tests__/*.test.* apps/*/src/__tests__/*-{conformance,coverage,boundary,isolation}.test.ts; do
	always+=(--always "$f")
done
exec bash "$GATE_SLICE_TESTS" "${always[@]}" -- --maxWorkers=4
