#!/usr/bin/env bash
#
# Read the app release version from the release source:
#   - VERSION env for manual dry-runs / tag helper workflows; or
#   - GITHUB_REF_NAME=v<VERSION> for tag-triggered releases.
#
# The source tree keeps app package metadata at a development placeholder;
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
# shellcheck source=.github/scripts/shared/app-version-lib.sh
source "$script_dir/app-version-lib.sh"

resolve_app_version
prerelease=false
if [[ "$app_version" == *-* ]]; then
	prerelease=true
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
	exec >>"$GITHUB_OUTPUT"
fi
printf 'value=%s\nprerelease=%s\nsource=%s\n' "$app_version" "$prerelease" "$app_version_source"
