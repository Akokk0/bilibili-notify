#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { npmRegistryPackage, publishNpmCandidate } from "./npm-publish.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const SDK = "@bilibili-notify/extension";
const CREATOR = "create-bn-ext";
async function main() {
	const { values } = parseArgs({
		options: {
			directory: { type: "string", default: "dist/extension-tooling" },
			registry: { type: "string", default: "https://registry.npmjs.org/" },
			"dry-run": { type: "boolean" },
			publish: { type: "boolean" },
			package: { type: "string", default: "both" },
		},
	});
	const registry = new URL(values.registry);
	if (
		registry.username ||
		registry.password ||
		registry.search ||
		registry.hash ||
		(registry.protocol !== "https:" &&
			!(
				registry.protocol === "http:" &&
				["127.0.0.1", "localhost", "[::1]"].includes(registry.hostname)
			))
	)
		throw new Error("Registry must use HTTPS or loopback HTTP without credentials.");
	if (!registry.pathname.endsWith("/")) registry.pathname += "/";
	values.registry = registry.href;
	const directory = resolve(values.directory);
	if (values.publish && values["dry-run"]) throw new Error("Choose --dry-run or --publish.");
	const metadata = JSON.parse(await readFile(join(directory, "packages.json"), "utf8"));
	if (
		metadata.schemaVersion !== 1 ||
		!Array.isArray(metadata.packages) ||
		metadata.packages.length !== 2 ||
		[SDK, CREATOR].some(
			(name) => metadata.packages.filter((entry) => entry.name === name).length !== 1,
		)
	)
		throw new Error("Invalid tooling package catalog.");
	const names = new Map([
		["both", [SDK, CREATOR]],
		["sdk", [SDK]],
		["creator", [CREATOR]],
	]).get(values.package);
	if (!names) throw new Error("Choose both, sdk or creator.");
	const packages = [];
	for (const name of names) {
		const candidate = metadata.packages.find((entry) => entry.name === name);
		if (candidate.version === "0.0.0-dev") throw new Error("A release version is required.");
		await exec("bash", [join(root, ".github/scripts/shared/assert-ref-matches-app-version.sh")], {
			env: { ...process.env, GITHUB_REF_NAME: `v${candidate.version}` },
		});
		if (
			candidate.file !== `${name.replace(/^@/, "").replaceAll("/", "-")}-${candidate.version}.tgz`
		)
			throw new Error("Invalid tooling package catalog filename.");
		const bytes = await readFile(join(directory, candidate.file));
		if (
			bytes.length !== candidate.size ||
			createHash("sha256").update(bytes).digest("hex") !== candidate.sha256
		)
			throw new Error("Package archive integrity mismatch.");
		const { stdout } = await exec("vp", [
			"exec",
			"npm",
			"pack",
			join(directory, candidate.file),
			"--dry-run",
			"--json",
			"--ignore-scripts",
			"--offline",
		]);
		const [packed] = JSON.parse(stdout);
		if (
			packed.name !== candidate.name ||
			packed.version !== candidate.version ||
			packed.integrity !== candidate.integrity
		)
			throw new Error("Packaged manifest does not match metadata.");
		const { stdout: json } = await exec("tar", [
			"-xOzf",
			join(directory, candidate.file),
			"package/package.json",
		]);
		const manifest = JSON.parse(json);
		if (
			manifest.private ||
			manifest.scripts ||
			manifest.publishConfig?.registry ||
			Object.entries(manifest.dependencies ?? {}).some(
				([key, version]) =>
					key === "@bilibili-notify/internal" || /^(workspace:|catalog:|file:|link:)/.test(version),
			)
		)
			throw new Error("Package must be public and self-contained.");
		const required =
			name === SDK
				? [
						"index.mjs",
						"index.d.mts",
						"build.mjs",
						"build.d.mts",
						"AGENT_GUIDE.md",
						"DEVELOPMENT.md",
						"skills/bn-extension-development/SKILL.md",
					]
				: [
						"create.mjs",
						"cli.mjs",
						"versions.json",
						"templates/project/README.md.tmpl",
						"templates/project/.github/workflows/release.yml.tmpl",
					];
		if (required.some((path) => !packed.files.some((entry) => entry.path === path)))
			throw new Error("Public package is incomplete.");
		packages.push({
			...candidate,
			archive: join(directory, candidate.file),
			name: candidate.name,
			version: candidate.version,
			channel: candidate.version.includes("-") ? "alpha" : "latest",
		});
	}
	const creator = packages.find((entry) => entry.name === CREATOR);
	if (creator) {
		const { stdout } = await exec("tar", ["-xOzf", creator.archive, "package/versions.json"]);
		const versions = JSON.parse(stdout);
		if (
			versions.tools !== creator.version ||
			versions.sdk !== metadata.packages.find((entry) => entry.name === SDK)?.version
		)
			throw new Error("Creator defaults do not match package versions.");
		if (values.publish && !packages.some((entry) => entry.name === SDK)) {
			const sdk = await npmRegistryPackage(values.registry, SDK);
			if (!sdk.versions?.[versions.sdk])
				throw new Error(`Default SDK ${versions.sdk} is not published.`);
		}
	}
	if (values.publish) {
		for (const candidate of packages) {
			const current = await npmRegistryPackage(values.registry, candidate.name);
			const existing = current.versions?.[candidate.version];
			if (existing && existing.dist?.integrity !== candidate.integrity)
				throw new Error(`Published ${candidate.name} version differs; use a new version.`);
		}
		for (const candidate of packages)
			await publishNpmCandidate(candidate, candidate.channel, values.registry);
	}
	console.log(
		JSON.stringify({
			dryRun: !values.publish,
			packages: packages.map(({ name, version, channel }) => ({ name, version, channel })),
		}),
	);
}
main().catch((error) => {
	console.error(
		`Tooling npm release: ${error.message}\n${error.stdout ?? ""}${error.stderr ?? ""}`,
	);
	process.exitCode = 1;
});
