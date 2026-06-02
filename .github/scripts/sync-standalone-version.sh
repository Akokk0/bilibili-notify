#!/usr/bin/env bash
#
# Patch standalone version metadata from the release source before CI builds.
# Source order matches read-standalone-version.sh:
#   - VERSION env for manual dry-runs / tag helper workflows; or
#   - GITHUB_REF_NAME=v<VERSION> for tag-triggered releases.
#
# This keeps source-controlled package metadata at a development placeholder while
# making Docker images, health/version output, web overview, and Tauri desktop
# bundles match the release tag.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=.github/scripts/standalone-version-lib.sh
source "$script_dir/standalone-version-lib.sh"

raw="${VERSION:-}"
if [ -z "$raw" ] && [[ "${GITHUB_REF_NAME:-}" == v* ]]; then
	raw="${GITHUB_REF_NAME#v}"
fi
raw="${raw#v}"

if [ -z "$raw" ]; then
	echo "::error::standalone version is required: set VERSION or run on a v<VERSION> tag"
	exit 1
fi
if ! is_valid_standalone_version "$raw"; then
	print_invalid_standalone_version_error "$raw"
	exit 1
fi

VERSION="$raw" node <<'NODE'
const fs = require('node:fs')

const version = process.env.VERSION
if (!version) {
	throw new Error('VERSION env is required')
}

function replaceJsonVersion(path) {
	replaceOnce(
		path,
		/(^\s*"version"\s*:\s*")[^"]+(")/m,
		(_, prefix, suffix) => `${prefix}${version}${suffix}`,
		'json version',
	)
}

function replaceOnce(path, pattern, replacement, label) {
	const text = fs.readFileSync(path, 'utf8')
	let count = 0
	const next = text.replace(pattern, (...args) => {
		count += 1
		return typeof replacement === 'function' ? replacement(...args) : replacement
	})
	if (count !== 1) {
		throw new Error(`Expected exactly one ${label} match in ${path}, got ${count}`)
	}
	fs.writeFileSync(path, next)
	console.log(`synced ${path} ${label} -> ${version}`)
}

replaceJsonVersion('apps/server/package.json')
replaceJsonVersion('apps/web/package.json')
replaceJsonVersion('apps/desktop/package.json')
replaceJsonVersion('apps/desktop/src-tauri/tauri.conf.json')

replaceOnce(
	'apps/desktop/src-tauri/Cargo.toml',
	/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
	(_, prefix, suffix) => `${prefix}${version}${suffix}`,
	'[package].version',
)

replaceOnce(
	'apps/desktop/src-tauri/Cargo.lock',
	/(\[\[package\]\]\s+name = "bilibili-notify-desktop"\s+version = ")[^"]+(")/m,
	(_, prefix, suffix) => `${prefix}${version}${suffix}`,
	'bilibili-notify-desktop version',
)
NODE
