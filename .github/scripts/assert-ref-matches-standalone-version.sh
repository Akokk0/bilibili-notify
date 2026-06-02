#!/usr/bin/env bash
#
# Tag-triggered release guard: the triggering ref name must match
# apps/server/package.json#version. This prevents an arbitrary v* tag on the same
# commit from publishing the package version's Docker / Desktop artifacts.
#
# 必需 env:
#   GITHUB_REF_NAME  GHA 自动注入,当前触发 ref 的短名(如 v0.1.0-alpha.7)

set -euo pipefail

: "${GITHUB_REF_NAME:?GITHUB_REF_NAME env 必填(GHA 自动注入)}"

version=$(node -p "require('./apps/server/package.json').version")
expected="v$version"
if [ "$GITHUB_REF_NAME" != "$expected" ]; then
	echo "::error::tag ref '$GITHUB_REF_NAME' does not match apps/server package version '$expected'"
	exit 1
fi

echo "tag ref $GITHUB_REF_NAME matches apps/server package version"
