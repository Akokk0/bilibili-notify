import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { repoRoot } from "../desktop-release-gates.mjs";

const { parse } = createRequire(join(repoRoot, "apps/server/package.json"))("yaml");

it("rerunning a rollback target preserves the published zip and its signed manifest", () => {
	const dir = mkdtempSync(join(tmpdir(), "bn-released-payload-"));
	try {
		const payload = join(dir, "release.zip");
		const archived = join(dir, "published-zip");
		const original = JSON.stringify({
			signature: "fixture",
			manifest: JSON.stringify({
				version: "1.0.0",
				issuedAt: 100,
				payload: { size: 8, sha256: createHash("sha256").update("original").digest("hex") },
			}),
		});
		writeFileSync(archived, "original");
		writeFileSync(payload, "rebuilt sponsors");
		writeFileSync(join(dir, "archived-manifest"), original);
		writeFileSync(join(dir, "manifest.sig.json"), "rebuilt manifest");
		writeFileSync(
			join(dir, "gh"),
			`#!/usr/bin/env bash
set -eu
case "$2" in
view) printf '%s\\n' 'release.zip' 'manifest.sig.json' ;;
download) if [[ "$5" == "manifest.sig.json" ]]; then cp "$CASE_DIR/archived-manifest" "$7/$5"; else cp "$CASE_DIR/published-zip" "$7/$5"; fi ;;
upload) for arg in "$@"; do if [[ "$arg" == "$PAYLOAD" ]]; then cp "$arg" "$CASE_DIR/published-zip"; fi; done ;;
*) exit 1 ;;
esac\n`,
			{ mode: 0o755 },
		);
		const workflow = parse(
			readFileSync(join(repoRoot, ".github/workflows/update-payload.yml"), "utf8"),
		);
		const step = workflow.jobs.publish.steps.find(
			(s) => s.name === "Upload payload + manifest to the version release",
		);
		const script = step.run
			.replaceAll("$" + "{{ steps.payload.outputs.path }}", payload)
			.replaceAll("dist/manifest.sig.json", join(dir, "manifest.sig.json"));
		const result = spawnSync("bash", ["-c", script], {
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				CASE_DIR: dir,
				VERSION: "1.0.0",
				REPO: "fixture/repo",
				GITHUB_OUTPUT: join(dir, "outputs"),
				PAYLOAD: payload,
				MANIFEST: join(dir, "manifest.sig.json"),
			},
		});
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(archived, "utf8")).toBe("original");
		expect(readFileSync(join(dir, "manifest.sig.json"), "utf8")).toBe(original);

		// A first attempt archived this version before a newer recall, then its channel upload failed.
		const steps = workflow.jobs.publish.steps;
		const channelFile = steps.find((s) => s.name === "Publish stable channel manifest").env.FILE;
		mkdirSync(join(dir, "dist"));
		copyFileSync(join(dir, "manifest.sig.json"), join(dir, "dist/manifest.sig.json"));
		const refresh = steps.find((s) => s.name === "Sign channel manifest");
		if (refresh) {
			mkdirSync(join(dir, "scripts"));
			for (const name of ["sign-update-manifest.mjs", "cli-args.mjs"])
				copyFileSync(join(repoRoot, "scripts", name), join(dir, "scripts", name));
			const published = Object.fromEntries(
				readFileSync(join(dir, "outputs"), "utf8")
					.trim()
					.split("\n")
					.map((line) => line.split("=")),
			);
			const output = (name) => {
				const source = /^\$\{\{ steps\.(\w+)\.outputs\.(\w+) \}\}$/.exec(refresh.env[name]);
				expect(source?.[1]).toBe(step.id);
				return published[source[2]];
			};
			const signed = spawnSync("bash", [join(repoRoot, refresh.run.replace(/^bash /, ""))], {
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					BN_UPDATE_SIGNING_KEY: generateKeyPairSync("ed25519").privateKey.export({
						format: "pem",
						type: "pkcs8",
					}),
					VERSION: "1.0.0",
					REPO: "fixture/repo",
					NOTES: "repair",
					SHA256: output("SHA256"),
					SIZE: output("SIZE"),
					GITHUB_OUTPUT: join(dir, "sign-output"),
				},
			});
			expect(signed.status, signed.stderr).toBe(0);
		}
		const candidate = JSON.parse(JSON.parse(readFileSync(join(dir, channelFile), "utf8")).manifest);
		expect(candidate.issuedAt).toBeGreaterThan(200);
		expect(candidate.payload).toMatchObject(JSON.parse(JSON.parse(original).manifest).payload);
		expect(readFileSync(join(dir, "archived-manifest"), "utf8")).toBe(original);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function workflow(name) {
	return parse(readFileSync(join(repoRoot, ".github/workflows", name), "utf8"));
}

function secretName(expression) {
	const match = /^\$\{\{ secrets\.(\w+) \}\}$/.exec(expression);
	expect(match).not.toBeNull();
	return match[1];
}

it("replaying the frozen alpha.4 job cannot replace a newer published channel", () => {
	const dir = mkdtempSync(join(tmpdir(), "bn-legacy-release-"));
	try {
		mkdirSync(join(dir, "scripts"));
		for (const name of ["sign-update-manifest.mjs", "cli-args.mjs"]) {
			copyFileSync(join(repoRoot, "scripts", name), join(dir, "scripts", name));
		}
		mkdirSync(join(dir, "dist"));
		const caller = workflow("npm-release.yml").jobs.update.secrets;
		const signing = workflow("update-payload.yml").jobs.publish.steps.find((s) => s.id === "sign");
		const activeName = secretName(caller[secretName(signing.env.BN_UPDATE_SIGNING_KEY)]);
		const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
		const available = { [activeName]: key };
		const output = join(dir, "outputs");
		const channel = join(dir, "alpha.json");
		const sign = (version, signingKey) => {
			writeFileSync(output, "");
			const result = spawnSync(
				"bash",
				[join(repoRoot, ".github/scripts/update-payload/sign-payload-manifest.sh")],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						BN_UPDATE_SIGNING_KEY: signingKey ?? "",
						GITHUB_OUTPUT: output,
						VERSION: version,
						REPO: "fixture/repo",
						SHA256: "a".repeat(64),
						SIZE: "8",
						NOTES: "fixture",
					},
				},
			);
			expect(result.status, result.stderr).toBe(0);
			return readFileSync(output, "utf8").trim() === "signed=true";
		};
		expect(sign("1.0.0-alpha.5", available[activeName])).toBe(true);
		copyFileSync(join(dir, "dist/manifest.sig.json"), channel);
		// Frozen alpha.4 reads this exact repository secret and unconditionally replaces the
		// channel after signing. It never consults a newer tag's comparison script.
		if (sign("1.0.0-alpha.4", available.BN_UPDATE_SIGNING_KEY)) {
			copyFileSync(join(dir, "dist/manifest.sig.json"), channel);
		}
		const published = JSON.parse(readFileSync(channel, "utf8"));
		expect(JSON.parse(published.manifest).version).toBe("1.0.0-alpha.5");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("the migration dry run rejects a manifest signed by another valid Ed25519 key", () => {
	const dir = mkdtempSync(join(tmpdir(), "bn-signing-cutover-"));
	try {
		const key = generateKeyPairSync("ed25519");
		const doc = JSON.stringify({ version: "1.0.0" });
		const file = join(dir, "manifest.sig.json");
		writeFileSync(
			file,
			JSON.stringify({
				manifest: doc,
				signature: sign(null, Buffer.from(doc), key.privateKey).toString("base64"),
			}),
		);
		const steps = workflow("update-payload.yml").jobs.publish.steps;
		const check = steps.find((step) => step.name === "Verify release signature");
		const runCheck = (script) => spawnSync("node", [script, file], { encoding: "utf8" });
		const realScript = check && join(repoRoot, check.run.split(" ")[1]);
		expect(realScript ? runCheck(realScript).status : 0).toBe(1);
		expect(check.if).toBe("steps.sign.outputs.signed == 'true'");
		expect(runCheck(realScript).stderr).toContain("public key");
		const keys = join(dir, "apps/server/src/update");
		mkdirSync(keys, { recursive: true });
		mkdirSync(join(dir, "scripts"));
		const localScript = join(dir, check.run.split(" ")[1]);
		copyFileSync(realScript, localScript);
		const publicKey = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
		writeFileSync(
			join(keys, "trusted-keys.ts"),
			`export const TRUSTED_UPDATE_KEYS = [${JSON.stringify(publicKey)}];`,
		);
		expect(runCheck(localScript).status).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("app releases, extension releases and revocations stop while old tag jobs can still sign", () => {
	const caller = workflow("npm-release.yml").jobs.update;
	const update = workflow("update-payload.yml").jobs.publish.steps;
	const revoke = workflow("revoke-update.yml").jobs.revoke.steps;
	const extension = workflow("extension-release.yml").jobs.publish.steps;
	const oldSecretCheck = "secrets.BN_UPDATE_SIGNING_KEY != ''";
	for (const steps of [update, revoke, extension]) {
		const guard = steps.find((step) => step.name === "Check legacy signer retirement");
		const signing = steps.find((step) => step.env?.BN_UPDATE_SIGNING_KEY);
		expect(guard).toBeDefined();
		expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(signing));
		if (steps === extension) {
			expect(guard.if).toBeUndefined();
			const upload = steps.findIndex((step) => step.run?.includes("create-extension-release.sh"));
			expect(steps.indexOf(guard)).toBeLessThan(upload);
		}
		const legacy = guard.env.LEGACY_SIGNER_CONFIGURED;
		expect(steps === update ? caller.secrets[secretName(legacy)] : legacy).toContain(
			oldSecretCheck,
		);
		for (const [present, expected] of [
			["true", 1],
			["false", 0],
		]) {
			const result = spawnSync("bash", ["-c", guard.run], {
				cwd: repoRoot,
				env: { LEGACY_SIGNER_CONFIGURED: present },
			});
			expect(result.status).toBe(expected);
		}
	}
	const signers = extension.filter((step) => step.env?.BN_UPDATE_SIGNING_KEY);
	expect(signers).toHaveLength(2);
	const current = secretName(
		caller.secrets[secretName(update.find((step) => step.id === "sign").env.BN_UPDATE_SIGNING_KEY)],
	);
	for (const step of [...signers, revoke.find((step) => step.env?.BN_UPDATE_SIGNING_KEY)]) {
		expect(secretName(step.env.BN_UPDATE_SIGNING_KEY)).toBe(current);
	}
});

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

it("replaying the forward-fix tag keeps its signed revocation list", () => {
	const current = envelope("1.1.1", ["1.1.0"]);
	expect(publish(current, envelope("1.1.1"))).toEqual({ status: 0, uploaded: false });
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
