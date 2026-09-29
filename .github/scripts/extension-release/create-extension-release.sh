#!/usr/bin/env bash
#
# 建拓展的**不可变** release(tag = extension/<id>@<version>)并把拓展包传上去。
# 由 .github/workflows/extension-release.yml 的「Create the extension release and upload
# the package」调用。
#
# 同名 release 已存在就是重跑:不再建,资产 --clobber 覆盖成同样的字节(打包是可复现的)。
# 预发布版本(版本号带 `-`)的 release 标 --prerelease;不论哪种都不抢「Latest release」。
#
# tag 的形状(前缀、`@` 分隔)与 scripts/release-urls.mjs 的 extensionTag() 是同一份声明,
# release-urls.test.mjs 会拿这个文件去对。
#
# 必需 env:
#   GH_TOKEN      secrets.RELEASE_PAT
#   ID            拓展 id
#   VERSION       拓展版本
#   PRERELEASE    "true"|"false"(assert-extension-tag.sh 的输出)
#   NOTES         release 正文(从拓展 CHANGELOG 抽的概述)
#   PACKAGE_PATH  要上传的拓展包(pack-extension.sh 输出的 path)

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN env 必填(走 RELEASE_PAT)}"
: "${ID:?ID env 必填(拓展 id)}"
: "${VERSION:?VERSION env 必填(拓展版本)}"
: "${PRERELEASE:?PRERELEASE env 必填(true|false)}"
: "${NOTES:?NOTES env 必填(release 正文)}"
: "${PACKAGE_PATH:?PACKAGE_PATH env 必填(要上传的拓展包路径)}"

tag="extension/${ID}@${VERSION}"
if ! gh release view "$tag" >/dev/null 2>&1; then
	extra=()
	if [ "$PRERELEASE" = "true" ]; then extra+=(--prerelease); fi
	gh release create "$tag" --title "$tag" --notes "$NOTES" --latest=false "${extra[@]}"
fi
gh release upload "$tag" "$PACKAGE_PATH" --clobber
