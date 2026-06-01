#!/usr/bin/env bash

set -euo pipefail

: "${TAURI_BUNDLES:?TAURI_BUNDLES env 必填,例如 dmg,app 或 nsis}"

vp run -F @bilibili-notify/desktop prepare-resources
cd apps/desktop
# 不经 package script 转发 --bundles: `tauri build -- ...` 会把参数传给 cargo。
vpx tauri build --bundles "$TAURI_BUNDLES"
