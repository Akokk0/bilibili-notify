#!/usr/bin/env bash

set -euo pipefail

: "${TAURI_BUNDLES:?TAURI_BUNDLES env 必填,例如 dmg,app 或 nsis}"

cd apps/desktop
node scripts/prepare-resources.mjs
node scripts/tauri-build.mjs -- --bundles "$TAURI_BUNDLES"
