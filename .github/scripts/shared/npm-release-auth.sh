#!/usr/bin/env bash

# 发布作业共用的鉴权；调用者选择模式，临时凭据只供这一进程使用。
configure_npm_release_auth() {
	case "${RELEASE_AUTH:-}" in
		trusted)
			NPM_RELEASE_ACTION=--publish
			;;
		bootstrap-token)
			NPM_RELEASE_ACTION=--stage
			: "${NODE_AUTH_TOKEN:?NPM_TOKEN secret is required for first publication}"
			: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
			_bn_npm_config=$(mktemp "$RUNNER_TEMP/bn-npmrc.XXXXXX")
			trap 'rm -f -- "$_bn_npm_config"' EXIT
			_bn_npm_registry_host=$(vp exec node -e 'process.stdout.write(new URL(process.env.NPM_REGISTRY).host)')
			printf '//%s/:_authToken=${NODE_AUTH_TOKEN}\n' "$_bn_npm_registry_host" > "$_bn_npm_config"
			export NPM_CONFIG_USERCONFIG="$_bn_npm_config"
			unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
			;;
		*)
			echo 'Choose trusted or bootstrap-token authentication.' >&2
			return 1
			;;
	esac
}
