#!/usr/bin/env bash
#
# Read the standalone release version from the release source:
#   - VERSION env for manual dry-runs / tag helper workflows; or
#   - GITHUB_REF_NAME=v<VERSION> for tag-triggered releases.
#
# The source tree keeps standalone package metadata at a development placeholder;
# release workflows patch metadata from this version before building.
#
# Optional env:
#   VERSION          explicit version, with or without leading 'v'
#   GITHUB_REF_NAME  GHA ref name, expected to be v<VERSION> on tag releases
#   GITHUB_OUTPUT    when present, write step outputs
#
# Outputs:
#   value=<version>           normalized SemVer without leading 'v'
#   prerelease=true|false     version contains '-' => prerelease

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=.github/scripts/standalone-version-lib.sh
source "$script_dir/standalone-version-lib.sh"

raw="${VERSION:-}"
source="VERSION"
if [ -z "$raw" ]; then
	ref="${GITHUB_REF_NAME:-}"
	if [[ "$ref" == v* ]]; then
		raw="${ref#v}"
		source="GITHUB_REF_NAME"
	fi
fi

# Accept either VERSION=1.2.3 or VERSION=v1.2.3 for manual convenience.
raw="${raw#v}"

if [ -z "$raw" ]; then
	echo "::error::standalone version is required: set VERSION or run on a v<VERSION> tag"
	exit 1
fi

if ! is_valid_standalone_version "$raw"; then
	print_invalid_standalone_version_error "$raw"
	exit 1
fi

prerelease=false
if [[ "$raw" == *-* ]]; then
	prerelease=true
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
	{
		echo "value=$raw"
		echo "prerelease=$prerelease"
		echo "source=$source"
	} >>"$GITHUB_OUTPUT"
else
	echo "value=$raw"
	echo "prerelease=$prerelease"
	echo "source=$source"
fi
