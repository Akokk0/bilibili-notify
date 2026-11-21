#!/usr/bin/env bash
# Each version URL names immutable bytes. Complete a partial upload only if its
# surviving asset agrees with the other half, before either channel is published.
set -euo pipefail
tag="v${VERSION:?}"
zip=$(basename "${PAYLOAD:?}")
name=$(basename "${MANIFEST:?}")
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
assets=$(gh release view "$tag" --json assets --jq '.assets[].name')
has_asset() { grep -Fxq -- "$1" <<<"$assets"; }

payload=$PAYLOAD
manifest=$MANIFEST
if has_asset "$zip"; then
	gh release download "$tag" --pattern "$zip" --dir "$tmp"
	payload="$tmp/$zip"
fi
if has_asset "$name"; then
	gh release download "$tag" --pattern "$name" --dir "$tmp"
	manifest="$tmp/$name"
fi

node --input-type=module - "$payload" "$manifest" "$VERSION" <<'NODE'
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [zip, file, version] = process.argv.slice(2);
const bytes = readFileSync(zip);
const manifest = JSON.parse(JSON.parse(readFileSync(file, "utf8")).manifest);
if (manifest.version !== version || manifest.payload.size !== bytes.length ||
    manifest.payload.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new Error("The signed version manifest does not match the payload. Restore the matching release artifact.");
}
appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${manifest.payload.sha256}\nsize=${bytes.length}\n`);
NODE

if ! has_asset "$zip"; then gh release upload "$tag" "$PAYLOAD"; fi
if ! has_asset "$name"; then
	gh release upload "$tag" "$MANIFEST"
else
	cp "$manifest" "$MANIFEST"
fi
