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

# 布局**只声明一次**,在 apps/desktop/layout.json —— 生产端、外壳、两个闸都读它。
# 这里不再手抄一份路径清单:手抄的那份一旦落后于外壳,macOS 这条闸只查文件存在,
# 照样绿,而用户拿到的是一个起不来的包。
layout_file="apps/desktop/layout.json"
node_bin=$(jq -er '.nodeBinary.macos' "$layout_file")
# 不用 mapfile:那是 bash 4 的内建,而 macOS 上的 /bin/bash 至今是 3.2。
required_rel=()
while IFS= read -r rel; do
	required_rel+=("$rel")
done < <(jq -er '.requiredUnderResources[]' "$layout_file")
# 禁止出现的目录(运行时数据 / 日志 / node_modules)同样来自声明:生产端扫的就是这一份。
forbidden_rel=()
while IFS= read -r rel; do
	forbidden_rel+=("$rel")
done < <(jq -er '.forbiddenUnderResources[]' "$layout_file")

assert_resources_dir() {
	local resources_dir="$1"
	local label="$2"
	for rel in "$node_bin" "${required_rel[@]}"; do
		if [ ! -e "$resources_dir/$rel" ]; then
			echo "::error::$label missing resources/$rel"
			exit 1
		fi
	done
	if [ ! -x "$resources_dir/$node_bin" ]; then
		echo "::error::$label Node binary is not executable"
		exit 1
	fi
	local forbidden_paths=()
	local rel
	for rel in "${forbidden_rel[@]}"; do
		forbidden_paths+=(-o -path "*/$rel" -o -path "*/$rel/*")
	done
	local forbidden
	forbidden=$(find "$resources_dir" \( \
		-name 'bn.config.yaml' -o -name 'bn.config.yml' -o -name 'bn.config.json' -o \
		-name 'master.key' -o -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.enc' \
		"${forbidden_paths[@]}" \
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
