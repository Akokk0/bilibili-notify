#!/usr/bin/env bash

set -euo pipefail

: "${TAURI_BUNDLES:?TAURI_BUNDLES env 必填,例如 dmg,app 或 nsis}"

vp run -F @bilibili-notify/desktop tauri:build -- --bundles "$TAURI_BUNDLES"
