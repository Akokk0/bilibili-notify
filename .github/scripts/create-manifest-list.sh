#!/usr/bin/env bash
#
# 拼 multi-arch manifest list 推 Docker Hub。从 /tmp/digests/* 收 build matrix
# 各 arch 的 push-by-digest 输出,组合成一个 manifest list 带上 metadata-action
# 算出的全部 tag 集合(:v* / :alpha 或 :latest / :<short-sha>)。
#
# 必需 env:
#   IMAGE   镜像 repo(如 docker.io/akokk0/bilibili-notify)
#   TAGS    换行分隔的 tag 列表(直接传 docker/metadata-action 的 steps.meta.outputs.tags)
#
# 必需文件:
#   /tmp/digests/<arch>  build matrix 各 arch 写入的 digest(单行 sha256:...)

set -euo pipefail

: "${IMAGE:?IMAGE env 必填}"
: "${TAGS:?TAGS env 必填(metadata-action 输出的 tag 列表)}"

digests=()
for f in /tmp/digests/*; do
	digests+=("${IMAGE}@$(cat "$f")")
done

echo "digests:"
printf '  %s\n' "${digests[@]}"

tag_flags=()
while IFS= read -r tag; do
	[ -z "$tag" ] && continue
	tag_flags+=(-t "$tag")
done <<<"$TAGS"

echo "tags:"
printf '  %s\n' "${tag_flags[@]}"

docker buildx imagetools create "${tag_flags[@]}" "${digests[@]}"
