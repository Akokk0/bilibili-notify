#!/usr/bin/env bash
#
# Release safety guard: tag-triggered standalone release workflows must publish a
# commit that is reachable from origin/dev. This keeps manually pushed tags from
# releasing arbitrary side commits while still allowing the tag commit to be an
# older dev commit if dev has advanced after tagging.

set -euo pipefail

base_branch="${RELEASE_BASE_BRANCH:-dev}"
remote="${RELEASE_REMOTE:-origin}"
base_ref="refs/remotes/$remote/$base_branch"
fetch_ref="+refs/heads/$base_branch:$base_ref"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "::error::assert-release-ref-on-dev.sh must run inside a git worktree"
	exit 1
fi

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
	git fetch --no-tags --prune --unshallow "$remote" "$fetch_ref"
else
	git fetch --no-tags --prune "$remote" "$fetch_ref"
fi

if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
	echo "::error::cannot resolve $base_ref"
	exit 1
fi

if ! git merge-base --is-ancestor HEAD "$base_ref"; then
	echo "::error::release commit $(git rev-parse --short=12 HEAD) is not reachable from $remote/$base_branch"
	echo "::error::push the release commit to $base_branch before publishing a standalone tag"
	exit 1
fi

echo "release commit $(git rev-parse --short=12 HEAD) is reachable from $remote/$base_branch"
