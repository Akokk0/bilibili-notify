#!/usr/bin/env bash
# A historical tag can still sign and upload when its original repository secret is visible.
set -euo pipefail

if [[ ${LEGACY_SIGNER_CONFIGURED:?missing legacy signer status} != false ]]; then
	echo "::error::旧标签仍可使用 BN_UPDATE_SIGNING_KEY。请按 docs/agents/self-update.md 完成签名密钥迁移后重试。"
	exit 1
fi
