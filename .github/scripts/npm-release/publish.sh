#!/usr/bin/env bash
set -euo pipefail

: "${PACKAGE_DIRECTORY:?PACKAGE_DIRECTORY is required}"
: "${NPM_REGISTRY:?NPM_REGISTRY is required}"
: "${TAG:?TAG is required}"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/../shared/npm-release-auth.sh"

RELEASE_AUTH=trusted
if [[ -n "${BOOTSTRAP_TAG:-}" && "$BOOTSTRAP_TAG" == "$TAG" ]]; then
	RELEASE_AUTH=bootstrap-token
fi
configure_npm_release_auth

vp run release:bn-package --directory "$PACKAGE_DIRECTORY" --tag "$TAG" \
	--registry "$NPM_REGISTRY" "$NPM_RELEASE_ACTION"
