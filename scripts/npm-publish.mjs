import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareEntryVersions } from "./extension-version-order.mjs";

const exec = promisify(execFile);
const SCAN_TIMEOUT_MS = 20 * 60_000;
const SCAN_POLL_MS = 30_000;
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
	await advanceNpmChannel(candidate, channel, registry, { waitForScan: !existing });
}

export async function advanceNpmChannel(
	candidate,
	channel,
	registry,
	{ waitForScan = false } = {},
) {
	const deadline = Date.now() + SCAN_TIMEOUT_MS;
	let current = await npmRegistryPackage(registry, candidate.name);
	while (waitForScan && !Object.hasOwn(current.versions ?? {}, candidate.version)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error(
				`npm accepted ${candidate.name}@${candidate.version}, but the version is still not visible. Check the registry before rerunning.`,
			);
		await new Promise((resolve) => setTimeout(resolve, Math.min(SCAN_POLL_MS, remaining)));
		current = await npmRegistryPackage(registry, candidate.name);
	}
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

async function pendingStage(candidate, registry) {
	const list = await registryCommand(registry, "stage", "list", candidate.name, "--json");
	const matches = JSON.parse(list.stdout).filter(
		(entry) => entry.packageName === candidate.name && entry.version === candidate.version,
	);
	if (!matches.length) return;
	const [entry] = matches;
	if (
		matches.length !== 1 ||
		entry.access !== "public" ||
		entry.tag !== `bn-release-${candidate.version}`
	)
		throw new Error(`Conflicting staged release for ${candidate.name}@${candidate.version}.`);
	const url = new URL(`-/stage/${encodeURIComponent(entry.id)}/tarball`, registry);
	const packed = await registryCommand(
		registry,
		"pack",
		url.href,
		"--dry-run",
		"--ignore-scripts",
		"--prefer-online",
		"--json",
	);
	if (JSON.parse(packed.stdout)[0]?.integrity !== candidate.integrity)
		throw new Error(`Staged archive differs for ${candidate.name}@${candidate.version}.`);
	return entry.id;
}

export async function releaseNpmCandidates(packages, registry, stage) {
	const awaiting = new Map();
	for (const candidate of packages) {
		const current = await npmRegistryPackage(registry, candidate.name);
		const existing = current.versions?.[candidate.version];
		if (existing && existing.dist?.integrity !== candidate.integrity)
			throw new Error(`Published ${candidate.name} version differs; use a new version.`);
		if (stage && !existing) awaiting.set(candidate, await pendingStage(candidate, registry));
	}
	if (awaiting.size) {
		for (const [candidate, id] of awaiting) {
			if (id) {
				console.log(`${candidate.name}@${candidate.version} is awaiting npm approval (${id}).`);
				continue;
			}
			const { stdout } = await registryCommand(
				registry,
				"stage",
				"publish",
				candidate.archive,
				"--tag",
				`bn-release-${candidate.version}`,
				"--access",
				"public",
				"--ignore-scripts",
			);
			console.log(stdout.trim());
		}
		return true;
	}
	const finish = stage ? advanceNpmChannel : publishNpmCandidate;
	for (const candidate of packages) await finish(candidate, candidate.channel, registry);
	return false;
}
