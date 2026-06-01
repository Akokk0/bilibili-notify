#!/usr/bin/env bash

set -euo pipefail

: "${ARCH:?ARCH env 必填}"
: "${DIGEST:?DIGEST env 必填}"

mkdir -p /tmp/digests
echo "$DIGEST" > "/tmp/digests/$ARCH"
