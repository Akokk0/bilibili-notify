#!/usr/bin/env bash
#
# 用私钥 A 把撤回清单签成信封(dist/manifest.sig.json,下一步按渠道各传一份)。
# 由 .github/workflows/revoke-update.yml 的 `Sign the revocation manifest` 一步调用。
# 需要签名私钥,只在 CI 里跑;不要在本地拿真私钥调它。
#
# 必需 env:
#   BN_UPDATE_SIGNING_KEY  secrets.BN_UPDATE_SIGNING_KEY(签名私钥 A;没配就报错退出)
#   VERSION                用户该被送到的版本(steps.plan.outputs.version)
#   PAYLOAD_URL            该版本载荷的下载地址(steps.plan.outputs.payloadUrl)
#   SHA256                 载荷 sha256(steps.plan.outputs.sha256)
#   SIZE                   载荷字节数(steps.plan.outputs.size)
#   RELEASE_URL            该版本的 release 页(steps.plan.outputs.releaseUrl)
#   REVOKED                要撤回的坏版本,逗号分隔(steps.plan.outputs.revoked)
#
# 必须在仓库根目录跑(scripts/ 与 dist/ 都是相对路径)。

set -euo pipefail

: "${VERSION:?VERSION env 必填(用户该被送到的版本)}"
: "${PAYLOAD_URL:?PAYLOAD_URL env 必填(载荷下载地址)}"
: "${SHA256:?SHA256 env 必填(载荷 sha256)}"
: "${SIZE:?SIZE env 必填(载荷字节数)}"
: "${RELEASE_URL:?RELEASE_URL env 必填(release 页地址)}"
: "${REVOKED:?REVOKED env 必填(要撤回的坏版本,逗号分隔)}"

# 私钥单独判:没设和空串都走下面这句人话,不让 set -u 抢先抛 unbound variable。
if [ -z "${BN_UPDATE_SIGNING_KEY:-}" ]; then
	echo "::error::未配置 BN_UPDATE_SIGNING_KEY —— 撤回必须签名,没有私钥就只能离线手跑(见 docs/agents/self-update.md)"
	exit 1
fi
node scripts/sign-update-manifest.mjs \
	--version "$VERSION" \
	--payload-url "$PAYLOAD_URL" \
	--sha256 "$SHA256" \
	--size "$SIZE" \
	--release-url "$RELEASE_URL" \
	--revoked "$REVOKED" \
	--out dist/manifest
