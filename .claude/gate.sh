#!/usr/bin/env bash
# 片级门禁：kit 插件的交付门禁回合结束时跑它；全量是 kit:gate 的 run --full，和 CI 的 gate.yml 同一套。
# lint、构建、类型检查照跑全仓（加起来约 20 秒）；测试交给插件的 slice-tests.sh，只跑和改动相关的
# （改动的源码、所属包的入口、扫源码的守卫测试；改到配置就跑全部）。直接手跑、没有插件传路径时跑全部测试。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

vp run check
vp run build
vp run typecheck

if [ -n "${GATE_SLICE_TESTS-}" ]; then exec bash "$GATE_SLICE_TESTS"; fi
exec vp run test
