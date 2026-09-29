#!/usr/bin/env bash

set -euo pipefail

mkdir -p desktop-artifacts
cp apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg desktop-artifacts/bilibili-notify-macos-arm64.dmg
app_path=$(find apps/desktop/src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -type d -print -quit)
if [ -z "$app_path" ]; then
	echo "::error::macOS .app bundle not found"
	exit 1
fi
ditto -c -k --sequesterRsrc --keepParent "$app_path" desktop-artifacts/bilibili-notify-macos-arm64.app.zip
