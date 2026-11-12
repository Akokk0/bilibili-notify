#!/usr/bin/env bash
set -euo pipefail

: "${PACKAGE_DIRECTORY:?PACKAGE_DIRECTORY is required}"
: "${NPM_REGISTRY:?NPM_REGISTRY is required}"
: "${RELEASE_PACKAGE:?RELEASE_PACKAGE is required}"

case "${RELEASE_AUTH:-}" in
  trusted)
    action=--publish
    ;;
  bootstrap-token)
    action=--stage
    : "${NODE_AUTH_TOKEN:?NPM_TOKEN secret is required for first publication}"
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    config=$(mktemp "$RUNNER_TEMP/bn-npmrc.XXXXXX")
    trap 'rm -f -- "$config"' EXIT
    registry_host=$(node -e 'process.stdout.write(new URL(process.env.NPM_REGISTRY).host)')
    printf '//%s/:_authToken=${NODE_AUTH_TOKEN}\n' "$registry_host" > "$config"
    export NPM_CONFIG_USERCONFIG="$config"
    unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
    ;;
  *)
    echo 'Choose trusted or bootstrap-token authentication.' >&2
    exit 1
    ;;
esac

vp run release:extension-tooling --directory "$PACKAGE_DIRECTORY" --package "$RELEASE_PACKAGE" --registry "$NPM_REGISTRY" "$action"
