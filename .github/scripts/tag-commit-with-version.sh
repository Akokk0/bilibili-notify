#!/usr/bin/env bash
#
# 给当前 commit 打 annotated tag v<VERSION> 并推回远程。跟 docker tag :v<VERSION>
# 同步存在,便于回溯"哪个 commit 出了哪个镜像"。
#
# 幂等 + 一致性守护:
#   - 远程无该 tag → 创建并 push
#   - 远程已有该 tag 且指向**本次 commit**($GITHUB_SHA) → skip(workflow rerun /
#     同 commit 重 trigger 场景)
#   - 远程已有该 tag 但指向**其他 commit** → ::error:: + fail。版本号被重用却换
#     了 commit,继续往下会让 Docker :v<VERSION> 漂移到新 commit 而 git tag 留在
#     旧 commit,破坏"镜像 tag = git tag" 不变量。
#
# 必需 env:
#   VERSION       apps/server/package.json#version(不带 'v' 前缀)
#   GITHUB_TOKEN  RELEASE_PAT,临时鉴权 git push(checkout 用 persist-credentials:
#                 false 不写 git config → 这里 -c http.extraheader 一次性注入)
#   REPO          github.repository(如 Akokk0/bilibili-notify),拼 push URL
#   GITHUB_SHA    GHA 自动注入,当前 workflow 跑的 commit SHA
#
# 安全设计:GITHUB_TOKEN 仅在本 step 的 env scope 内可见,extraheader 通过 `-c`
# 限定到单个 git 命令,不进 .git/config —— 其它 step / merge job 子进程拿不到。

set -euo pipefail

: "${VERSION:?VERSION env 必填}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN env 必填(走 RELEASE_PAT)}"
: "${REPO:?REPO env 必填(github.repository)}"
: "${GITHUB_SHA:?GITHUB_SHA env 必填(GHA 自动注入)}"

tag="v$VERSION"

# ls-remote 拿 tag 指向的**实际 commit** SHA。
#
# 关键陷阱:`git tag -a` 创建的是 **annotated tag**,在 ls-remote 输出里有两行:
#   - `<tag-object-sha>  refs/tags/<tag>`     —— tag 对象自身的 SHA(不是 commit!)
#   - `<commit-sha>      refs/tags/<tag>^{}`  —— peeled ref,指向实际 commit
# Lightweight tag 只有一行直接指 commit。优先取 peeled(annotated 场景),fallback
# 单行(lightweight 场景)。直接 `awk '{print $1}'` 拿第一行的话,annotated tag
# 永远拿到 tag object SHA,跟 `$GITHUB_SHA`(commit)永远对不上 → rerun 必 fail。
remote_lines=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")
remote_sha=$(printf '%s\n' "$remote_lines" | awk '
	/\^\{\}$/ { peeled = $1 }
	$0 !~ /\^\{\}$/ && NF { plain = $1 }
	END { print (peeled ? peeled : plain) }
')

if [ -n "$remote_sha" ]; then
	if [ "$remote_sha" = "$GITHUB_SHA" ]; then
		echo "tag $tag already points at $GITHUB_SHA, skip"
		exit 0
	fi
	echo "::error::tag $tag 已存在但指向 $remote_sha(当前 commit $GITHUB_SHA)"
	echo "::error::版本号被重用却换了 commit,中止以避免 Docker tag 与 git tag 失同步"
	exit 1
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -a "$tag" -m "独立端 $VERSION (image: akokk0/bilibili-notify:$tag)"

# 临时把 Authorization 头注入到这一次 git push,不落 .git/config。
# Basic auth 用 `x-access-token:<token>` —— actions/checkout 默认走的也是这条
# 路径,**同时兼容 classic PAT (ghp_) / fine-grained PAT (github_pat_) /
# GITHUB_TOKEN**。早先版本用 `Bearer <token>` 时 fine-grained PAT 会被 GitHub
# 端拒(401),git 退到交互式 basic auth prompt,CI 无 tty 直接报「could not
# read Username」exit 128。
auth=$(printf '%s' "x-access-token:$GITHUB_TOKEN" | base64 -w 0)
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
	push "https://github.com/$REPO.git" "$tag"
