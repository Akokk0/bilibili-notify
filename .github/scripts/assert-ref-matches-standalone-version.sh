#!/usr/bin/env bash
#
# Tag-triggered release guard: the triggering ref must be a standalone release
# tag in the form v<VERSION>. The version itself is the release source; package
# metadata is patched from this tag by sync-standalone-version.sh before builds.
#
# Required env:
#   GITHUB_REF_NAME  GHA short ref name, e.g. v0.1.0-alpha.7

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=.github/scripts/standalone-version-lib.sh
source "$script_dir/standalone-version-lib.sh"

: "${GITHUB_REF_NAME:?GITHUB_REF_NAME env 必填(GHA 自动注入)}"

if [[ "$GITHUB_REF_NAME" != v* ]]; then
	echo "::error::tag ref '$GITHUB_REF_NAME' is not a valid standalone release tag"
	echo "::error::expected vX.Y.Z or vX.Y.Z-prerelease, e.g. v0.1.0-alpha.7"
	exit 1
fi

version="${GITHUB_REF_NAME#v}"
if ! is_valid_standalone_version "$version"; then
	print_invalid_standalone_version_error "$version"
	echo "::error::expected vX.Y.Z or vX.Y.Z-prerelease, e.g. v0.1.0-alpha.7"
	exit 1
fi

echo "tag ref $GITHUB_REF_NAME is a valid standalone release tag"
