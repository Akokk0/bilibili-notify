#!/usr/bin/env bash

set -euo pipefail

: "${ARCH:?ARCH env 必填}"
: "${DIGEST:?DIGEST env 必填}"

digest_dir="${DIGESTS_DIR:-/tmp/digests}"
mkdir -p "$digest_dir"
echo "$DIGEST" > "$digest_dir/$ARCH"
