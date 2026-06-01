#!/usr/bin/env bash

set -euo pipefail

tmp=$(mktemp -d)
ditto -x -k desktop-artifacts/bilibili-notify-macos-arm64.app.zip "$tmp"
resources_dir=$(find "$tmp" -path '*/Contents/Resources/resources' -type d -print -quit)
if [ -z "$resources_dir" ]; then
	echo "::error::macOS .app resources directory not found in artifact"
	exit 1
fi
for rel in node/bin/node app/apps/server/lib/index.mjs BUILD_INFO.json; do
	if [ ! -e "$resources_dir/$rel" ]; then
		echo "::error::macOS artifact missing resources/$rel"
		exit 1
	fi
done
if [ ! -x "$resources_dir/node/bin/node" ]; then
	echo "::error::macOS artifact Node binary is not executable"
	exit 1
fi
forbidden=$(find "$resources_dir" \( \
	-name 'bn.config.yaml' -o -name 'bn.config.yml' -o -name 'bn.config.json' -o \
	-name 'master.key' -o -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.enc' -o \
	-path '*/app/apps/server/data' -o -path '*/app/apps/server/data/*' -o \
	-path '*/app/apps/server/logs' -o -path '*/app/apps/server/logs/*' -o \
	-path '*/app/node_modules/.pnpm' -o -path '*/app/node_modules/.pnpm/*' \
\) -print -quit)
if [ -n "$forbidden" ]; then
	echo "::error::macOS artifact contains forbidden runtime file: $forbidden"
	exit 1
fi
