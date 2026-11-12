#!/usr/bin/env bash
set -euo pipefail

# 仓外安装测试会从空工程离线解析依赖。主仓的冻结安装已有包文件，
# 但未必有无锁解析所需的 registry 元数据。用真实模板先联网安装一次。
work=$(mktemp -d "${TMPDIR:-/tmp}/bn-package-test-cache.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT

(cd packages/extension && vp pm pack --out "$work/sdk.tgz")
(cd tools/create-extension && vp pm pack --out "$work/creator.tgz")
vp exec node tools/create-extension/lib/create.mjs "$work/project" \
  --id fixture.cache --repository fixture/cache --no-git \
  --sdk "file:$work/sdk.tgz" --tools "file:$work/creator.tgz"
