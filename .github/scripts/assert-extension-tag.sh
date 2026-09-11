#!/usr/bin/env bash
#
# 拓展发布的 tag 守卫:ref 必须是 `ext/<id>@<version>`,而且 <version> 得与
# extensions/<id>/extension.json 里写的一致 —— 拓展是独立发布物,清单里的版本就该是真的,
# 不像本体那样按 tag 临时改元数据。手动 dry-run 时从 EXT_ID / EXT_VERSION env 来。
#
# Outputs(GITHUB_OUTPUT):id=<id> version=<version> prerelease=true|false

set -euo pipefail

id="${EXT_ID:-}"
version="${EXT_VERSION:-}"
if [ -z "$id" ] || [ -z "$version" ]; then
	ref="${GITHUB_REF_NAME:?GITHUB_REF_NAME 或 EXT_ID+EXT_VERSION 必填}"
	if [[ "$ref" != ext/*@* ]]; then
		echo "::error::tag '$ref' 不是拓展发布 tag,要的形状是 ext/<id>@<version>"
		exit 1
	fi
	rest="${ref#ext/}"
	id="${rest%%@*}"
	version="${rest#*@}"
fi

# 官方索引里的 id 不带命名空间(没有点的 id 保留给官方源)。
if ! [[ "$id" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
	echo "::error::拓展 id '$id' 不合规:小写字母数字连字符,且不带命名空间"
	exit 1
fi
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
	echo "::error::版本 '$version' 不是 semver"
	exit 1
fi

manifest="extensions/$id/extension.json"
if [ ! -f "$manifest" ]; then
	echo "::error::$manifest 不存在 —— 仓里没有叫 $id 的拓展"
	exit 1
fi
declared=$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).version")
if [ "$declared" != "$version" ]; then
	echo "::error::tag 说 $version,$manifest 里写的是 $declared —— 先把清单的版本改对再打 tag"
	exit 1
fi

prerelease=false
if [[ "$version" == *-* ]]; then prerelease=true; fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
	{
		echo "id=$id"
		echo "version=$version"
		echo "prerelease=$prerelease"
	} >>"$GITHUB_OUTPUT"
fi
echo "extension $id@$version (prerelease=$prerelease)"
