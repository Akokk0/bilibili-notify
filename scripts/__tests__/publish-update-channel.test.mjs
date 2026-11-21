import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { repoRoot } from "../desktop-release-gates.mjs";

const envelope = (version, revoked) =>
	JSON.stringify({ manifest: JSON.stringify({ version, revoked }), signature: "fixture" });

function publish(current, candidate, mode = "release", lookup = "ok") {
	const dir = mkdtempSync(join(tmpdir(), "bn-channel-"));
	try {
		writeFileSync(join(dir, "current"), JSON.stringify(current));
		writeFileSync(join(dir, "next"), candidate);
		writeFileSync(join(dir, "calls"), "");
		writeFileSync(
			join(dir, "gh"),
			`#!/usr/bin/env bash
set -eu
echo "$*" >> "$CASE_DIR/calls"
case "$1" in
api)
	case "$*" in
		*releases/tags/*)
			case "$LOOKUP" in
				error) echo "gh: service unavailable (HTTP 503)" >&2; exit 1 ;;
				absent) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
				empty) exit 0 ;;
			esac
			echo 7 ;;
		*releases/assets/*) node -p 'JSON.parse(require("node:fs").readFileSync(process.env.CASE_DIR+"/current","utf8"))' ;;
		*) exit 2 ;;
	esac ;;
release) exit 0 ;;
*) exit 3 ;;
esac
`,
			{ mode: 0o755 },
		);
		const result = spawnSync(
			"bash",
			[join(repoRoot, ".github/scripts/shared/publish-update-channel.sh")],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH}`,
					CASE_DIR: dir,
					LOOKUP: lookup,
					REPO: "owner/tools",
					CHANNEL: "alpha",
					FILE: join(dir, "next"),
					GH_TOKEN: "fixture",
					CHANNEL_ACTION: mode,
					TMPDIR: dir,
				},
			},
		);
		return {
			status: result.status,
			uploaded: readFileSync(join(dir, "calls"), "utf8").includes("release upload"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

it.each([
	["1.0.0-alpha.10", "1.0.0-alpha.9", false],
	["1.0.0-alpha.9", "1.0.0-alpha.10", true],
	["1.0.0", "1.0.0-alpha.11", false],
	["1.0.0-alpha.10", "1.0.0", true],
])("publishing %s then %s preserves channel version order", (current, next, uploaded) => {
	expect(publish(envelope(current), envelope(next))).toEqual({ status: 0, uploaded });
});

it("keeps a recalled target off the channel and allows explicit revocation", () => {
	const recall = envelope("1.0.0", ["1.1.0"]);
	expect(publish(recall, envelope("1.1.0"))).toEqual({ status: 0, uploaded: false });
	expect(publish(recall, envelope("1.0.0"))).toEqual({ status: 0, uploaded: false });
	expect(publish(envelope("1.1.0"), recall, "revoke")).toEqual({ status: 0, uploaded: true });
});

it("only treats a missing release or asset as a new channel", () => {
	for (const lookup of ["absent", "empty"]) {
		expect(publish("", envelope("1.0.0"), "release", lookup)).toEqual({
			status: 0,
			uploaded: true,
		});
	}
	for (const [current, lookup] of [
		["", "error"],
		["{", "ok"],
	]) {
		const result = publish(current, envelope("1.0.0"), "release", lookup);
		expect(result.status).not.toBe(0);
		expect(result.uploaded).toBe(false);
	}
});
