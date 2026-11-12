import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareEntryVersions } from "./extension-version-order.mjs";

const exec = promisify(execFile);
async function command(bin, args) {
	return exec(bin, args, {
		cwd: fileURLToPath(new URL("../", import.meta.url)),
		timeout: 60_000,
		maxBuffer: 512 * 1024 * 1024,
	});
}

export async function npmRegistryPackage(registry, name) {
	const response = await fetch(new URL(encodeURIComponent(name), registry), {
		signal: AbortSignal.timeout(30_000),
		cache: "no-store",
	});
	if (response.status === 404) return { versions: {}, "dist-tags": {} };
	if (!response.ok) throw new Error(`Registry metadata failed: HTTP ${response.status}.`);
	return response.json();
}

export async function publishNpmCandidate(candidate, channel, registry) {
	const common = ["--registry", registry, "--fetch-retries=0", "--fetch-timeout=30000"];
	const before = await npmRegistryPackage(registry, candidate.name);
	const existing = before.versions?.[candidate.version];
	if (existing && existing.dist?.integrity !== candidate.integrity)
		throw new Error("Published version differs; use a new version.");
	if (!existing) {
		await command("vp", [
			"exec",
			"npm",
			"publish",
			candidate.archive,
			"--tag",
			`bn-release-${candidate.version}`,
			"--access",
			"public",
			"--ignore-scripts",
			...common,
		]);
	}
	const current = await npmRegistryPackage(registry, candidate.name);
	if (current.versions?.[candidate.version]?.dist?.integrity !== candidate.integrity)
		throw new Error(
			"Published version integrity could not be verified; rerun after checking the registry.",
		);
	const channelVersion = current["dist-tags"]?.[channel];
	if (channelVersion && compareEntryVersions(candidate.version, channelVersion) <= 0) return;
	await command("vp", [
		"exec",
		"npm",
		"dist-tag",
		"add",
		`${candidate.name}@${candidate.version}`,
		channel,
		...common,
	]);
}
