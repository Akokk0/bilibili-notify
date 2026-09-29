#!/usr/bin/env bash
#
# 给升级载荷签一份清单(dist/manifest.json + dist/manifest.sig.json),清单里指向 v<VERSION>
# release 上的载荷下载链接与 release 页。
# 由 .github/workflows/update-payload.yml 的「Sign manifest」调用。
#
# 私钥没配 = 整条跳过:打一条 warning、写 signed=false、**exit 0**,后面依赖签名的步骤
# 靠 `steps.sign.outputs.signed == 'true'` 跳过。载荷资产名与下载链接的拼法是
# release-urls.mjs 那份声明的 shell 版(release-urls.test.mjs 会对),载荷的名字与
# pack-update-payload.sh 里是同一个。
#
# 必需 env:
#   BN_UPDATE_SIGNING_KEY  secrets.BN_UPDATE_SIGNING_KEY —— **必须传入,但可以是空串**
#                          (空 = 没配,走跳过);只判空,绝不打印
#   VERSION        独立端版本(不带 v)
#   REPO           github.repository
#   SHA256         载荷摘要(pack-update-payload.sh 的输出)
#   SIZE           载荷字节数(pack-update-payload.sh 的输出)
#   NOTES          清单上那句概述(read-release-summary.sh 的输出)
#   GITHUB_OUTPUT  GHA 自带
#
# Outputs(GITHUB_OUTPUT):signed=true|false

set -euo pipefail

: "${BN_UPDATE_SIGNING_KEY?BN_UPDATE_SIGNING_KEY env 必须传入(空串 = 没配)}"
: "${VERSION:?VERSION env 必填(独立端版本,不带 v)}"
: "${REPO:?REPO env 必填(github.repository)}"
: "${SHA256:?SHA256 env 必填(载荷摘要)}"
: "${SIZE:?SIZE env 必填(载荷字节数)}"
: "${NOTES:?NOTES env 必填(清单上那句概述)}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(GHA 自带)}"

if [ -z "$BN_UPDATE_SIGNING_KEY" ]; then
	echo "::warning::未配置 BN_UPDATE_SIGNING_KEY,跳过清单签名 —— 本次发版不会有应用内更新。生成方法见 docs/agents/self-update.md"
	echo "signed=false" >>"$GITHUB_OUTPUT"
	exit 0
fi
node scripts/sign-update-manifest.mjs \
	--version "$VERSION" \
	--payload-url "https://github.com/${REPO}/releases/download/v${VERSION}/bilibili-notify-payload-${VERSION}.zip" \
	--sha256 "$SHA256" \
	--size "$SIZE" \
	--release-url "https://github.com/${REPO}/releases/tag/v${VERSION}" \
	--notes "$NOTES" \
	--out dist/manifest
# 清单本来就是公开发布的东西,打进日志让 dry-run 也能核对 notes 进没进去。
cat dist/manifest.json
echo "signed=true" >>"$GITHUB_OUTPUT"
