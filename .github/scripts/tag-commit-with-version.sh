#!/usr/bin/env bash
#
# 给当前 commit 打 annotated tag v<VERSION> 并推回远程。跟 docker tag :v<VERSION>
# 同步存在,便于回溯"哪个 commit 出了哪个镜像"。
#
# 远程已有该 tag(workflow rerun / 同 version 重 trigger 场景)→ 跳过,不
# force-update(老 tag 与镜像 :v<VERSION> 都已不可变,无需覆盖)。
#
# 必需 env:
#   VERSION  apps/server/package.json#version(不带 'v' 前缀)
#
# 前置:checkout 必须用 secrets.RELEASE_PAT(默认 GITHUB_TOKEN 没 workflows: write
# scope,push 含 workflow 改动的 ref 会被 GitHub 拒)。

set -euo pipefail

: "${VERSION:?VERSION env 必填}"

tag="v$VERSION"

# actions/checkout 默认不 fetch tags;直接探远程避开本地 ref 假阴。
if git ls-remote --tags --exit-code origin "refs/tags/$tag" >/dev/null 2>&1; then
	echo "tag $tag already exists on remote, skip"
	exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -a "$tag" -m "独立端 $VERSION (image: akokk0/bilibili-notify:$tag)"
git push origin "$tag"
