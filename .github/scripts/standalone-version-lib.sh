#!/usr/bin/env bash

# Shared validation for standalone release versions.
# We accept strict SemVer core + optional prerelease, but intentionally reject
# '+build' metadata because Docker tags cannot contain '+'.

standalone_version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$'

is_valid_standalone_version() {
	local version="$1"
	[[ "$version" =~ $standalone_version_pattern ]]
}

print_invalid_standalone_version_error() {
	local version="$1"
	echo "::error::standalone version is not valid / Docker-tag-compatible SemVer: '$version'"
	echo "::error::allowed: X.Y.Z or strict X.Y.Z-prerelease, e.g. 0.1.0-alpha.7; '+build' metadata is not allowed"
	echo "::error::prerelease identifiers cannot be empty, and purely numeric identifiers cannot have leading zeroes"
}
