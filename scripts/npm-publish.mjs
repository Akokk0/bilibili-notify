import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareEntryVersions } from "./extension-version-order.mjs";

const exec = promisify(execFile);
export async function registryCommand(registry, ...args) {
	return exec(
		"vp",
		["exec", "npm", ...args, "--registry", registry, "--fetch-retries=0", "--fetch-timeout=30000"],
		{
			cwd: fileURLToPath(new URL("../", import.meta.url)),
			timeout: 60_000,
			maxBuffer: 512 * 1024 * 1024,
		},
	);
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
	const before = await npmRegistryPackage(registry, candidate.name);
	const existing = before.versions?.[candidate.version];
	if (existing && existing.dist?.integrity !== candidate.integrity)
		throw new Error("Published version differs; use a new version.");
	if (!existing) {
		await registryCommand(
			registry,
			"publish",
			candidate.archive,
			"--tag",
			`bn-release-${candidate.version}`,
			"--access",
			"public",
			"--ignore-scripts",
		);
	}
	await advanceNpmChannel(candidate, channel, registry);
}

export async function advanceNpmChannel(candidate, channel, registry) {
	const current = await npmRegistryPackage(registry, candidate.name);
	if (current.versions?.[candidate.version]?.dist?.integrity !== candidate.integrity)
		throw new Error(
			"Published version integrity could not be verified; rerun after checking the registry.",
		);
	const channelVersion = current["dist-tags"]?.[channel];
	if (channelVersion && compareEntryVersions(candidate.version, channelVersion) <= 0) return;
	await registryCommand(
		registry,
		"dist-tag",
		"add",
		`${candidate.name}@${candidate.version}`,
		channel,
	);
}
