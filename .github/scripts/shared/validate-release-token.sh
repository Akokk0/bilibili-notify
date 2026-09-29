#!/usr/bin/env bash

set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
	echo "::error::RELEASE_PAT secret is required for desktop release publishing"
	exit 1
fi
