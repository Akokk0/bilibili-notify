#!/usr/bin/env bash

# Shared validation for app release versions.
# We accept strict SemVer core + optional prerelease, but intentionally reject
# '+build' metadata because Docker tags cannot contain '+'.

app_version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$'

is_valid_app_version() {
	local version="$1"
	[[ "$version" =~ $app_version_pattern ]]
}

print_invalid_app_version_error() {
	local version="$1"
	echo "::error::app version is not valid / Docker-tag-compatible SemVer: '$version'"
	echo "::error::allowed: X.Y.Z or strict X.Y.Z-prerelease, e.g. 0.1.0-alpha.7; '+build' metadata is not allowed"
	echo "::error::prerelease identifiers cannot be empty, and purely numeric identifiers cannot have leading zeroes"
}

# The read step also emits app_version_source as a GitHub Actions output.
# shellcheck disable=SC2034
resolve_app_version() {
	app_version="${VERSION:-}"
	app_version_source=VERSION
	if [[ -z "$app_version" && "${GITHUB_REF_NAME:-}" == v* ]]; then
		app_version="${GITHUB_REF_NAME#v}"
		app_version_source=GITHUB_REF_NAME
	fi
	app_version="${app_version#v}"
	if [[ -z "$app_version" ]]; then
		echo "::error::app version is required: set VERSION or run on a v<VERSION> tag"
		return 1
	fi
	if ! is_valid_app_version "$app_version"; then
		print_invalid_app_version_error "$app_version"
		return 1
	fi
}
