#!/usr/bin/env bash

set -euo pipefail

cleanup_paths=()
mounted_dmg=""
cleanup() {
	if [ -n "$mounted_dmg" ]; then
		hdiutil detach "$mounted_dmg" -quiet || true
	fi
	for path in "${cleanup_paths[@]}"; do
		rm -rf "$path"
	done
}
trap cleanup EXIT

assert_resources_dir() {
	local resources_dir="$1"
	local label="$2"
	for rel in node/bin/node app/apps/server/lib/index.mjs BUILD_INFO.json; do
		if [ ! -e "$resources_dir/$rel" ]; then
			echo "::error::$label missing resources/$rel"
			exit 1
		fi
	done
	if [ ! -x "$resources_dir/node/bin/node" ]; then
		echo "::error::$label Node binary is not executable"
		exit 1
	fi
	local forbidden
	forbidden=$(find "$resources_dir" \( \
		-name 'bn.config.yaml' -o -name 'bn.config.yml' -o -name 'bn.config.json' -o \
		-name 'master.key' -o -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.enc' -o \
		-path '*/app/apps/server/data' -o -path '*/app/apps/server/data/*' -o \
		-path '*/app/apps/server/logs' -o -path '*/app/apps/server/logs/*' -o \
		-path '*/app/node_modules/.pnpm' -o -path '*/app/node_modules/.pnpm/*' \
	\) -print -quit)
	if [ -n "$forbidden" ]; then
		echo "::error::$label contains forbidden runtime file: $forbidden"
		exit 1
	fi
}

find_resources_dir() {
	local root="$1"
	find "$root" -path '*/Contents/Resources/resources' -type d -print -quit
}

app_tmp=$(mktemp -d)
cleanup_paths+=("$app_tmp")
ditto -x -k desktop-artifacts/bilibili-notify-macos-arm64.app.zip "$app_tmp"
app_resources_dir=$(find_resources_dir "$app_tmp")
if [ -z "$app_resources_dir" ]; then
	echo "::error::macOS .app resources directory not found in artifact"
	exit 1
fi
assert_resources_dir "$app_resources_dir" "macOS .app artifact"

if [ ! -f desktop-artifacts/bilibili-notify-macos-arm64.dmg ]; then
	echo "::error::macOS DMG artifact missing"
	exit 1
fi
hdiutil verify desktop-artifacts/bilibili-notify-macos-arm64.dmg -quiet
mount_dir=$(mktemp -d)
cleanup_paths+=("$mount_dir")
hdiutil attach desktop-artifacts/bilibili-notify-macos-arm64.dmg \
	-mountpoint "$mount_dir" \
	-nobrowse \
	-readonly \
	-quiet
mounted_dmg="$mount_dir"
dmg_app=$(find "$mount_dir" -maxdepth 2 -name '*.app' -print -quit)
if [ -z "$dmg_app" ]; then
	echo "::error::macOS DMG does not contain an .app bundle"
	exit 1
fi
