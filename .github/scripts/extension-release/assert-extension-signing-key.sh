#!/usr/bin/env bash
#
# 探一下官方索引的签名私钥配没配,把结果写成 step output `present`。**缺了不失败** ——
# 只打一条 warning、后面依赖签名的步骤靠 `steps.key.outputs.present == 'true'` 整条跳过
# (与 update-payload 里清单签名的处理同一个思路:与其让每次发版都红着,不如把这件事
# 显式摆在 run summary 上)。名字带 assert 是沿用 workflow 里那一步的叫法。
# 由 .github/workflows/extension-release.yml 的「Assert signing key」调用。
#
# 必需 env:
#   GITHUB_OUTPUT          GHA 自带;本地跑请指向一个文件,或直接用 /dev/stdout 看
# 可选 env:
#   BN_UPDATE_SIGNING_KEY  secrets.BN_UPDATE_SIGNING_KEY。没传与空串都算「没配」(所以这里
#                          不做必填断言 —— 这正是本脚本要处理的情形)。只判空,绝不打印。
#
# Outputs(GITHUB_OUTPUT):present=true|false
#
# 本地(假值即可,不要拿真私钥):
#   BN_UPDATE_SIGNING_KEY= GITHUB_OUTPUT=/dev/stdout bash .github/scripts/extension-release/assert-extension-signing-key.sh

set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT env 必填(GHA 自带;本地跑请指向一个文件)}"

if [ -z "${BN_UPDATE_SIGNING_KEY:-}" ]; then
	echo "::warning::未配置 BN_UPDATE_SIGNING_KEY,跳过索引签名 —— 这次发的拓展不会出现在市场里。生成方法见 docs/agents/self-update.md"
	echo "present=false" >>"$GITHUB_OUTPUT"
else
	echo "present=true" >>"$GITHUB_OUTPUT"
fi
