#!/usr/bin/env bash
set -euo pipefail

: "${PACKAGE_DIRECTORY:?PACKAGE_DIRECTORY is required}"
: "${NPM_REGISTRY:?NPM_REGISTRY is required}"
: "${RELEASE_PACKAGE:?RELEASE_PACKAGE is required}"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/../shared/npm-release-auth.sh"
configure_npm_release_auth

vp run release:extension-tooling --directory "$PACKAGE_DIRECTORY" --package "$RELEASE_PACKAGE" --registry "$NPM_REGISTRY" "$NPM_RELEASE_ACTION"
