#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { verifyBnRuntimes } from "./assemble-bn-package.mjs";
import { publishNpmCandidate } from "./npm-publish.mjs";

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "@bilibili-notify/bn";
const digest = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
async function command(bin, args, options = {}) {
	return exec(bin, args, {
		cwd: repoRoot,
		timeout: 60_000,
		maxBuffer: 512 * 1024 * 1024,
		...options,
	});
}

/** 校验实际待发布tgz；tar只输出指定文件，不解包到磁盘或执行包内脚本。 */
async function candidateOf(directory, version, registry) {
	const meta = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	if (
		meta.name !== NAME ||
		meta.version !== version ||
		meta.file !== `bilibili-notify-bn-${version}.tgz`
	)
		throw new Error("Package metadata must match the app tag.");
	const archive = join(directory, meta.file);
	const bytes = await readFile(archive);
	if (
		bytes.length !== meta.size ||
		digest(bytes, "sha256", "hex") !== meta.sha256 ||
		`sha512-${digest(bytes, "sha512", "base64")}` !== meta.integrity
	)
		throw new Error("Package archive integrity mismatch.");
	const { stdout } = await command("vp", [
		"exec",
		"npm",
		"pack",
		archive,
		"--dry-run",
		"--json",
		"--ignore-scripts",
		"--offline",
		"--registry",
		registry,
	]);
	const [packed] = JSON.parse(stdout);
	if (packed.name !== NAME || packed.version !== version || packed.integrity !== meta.integrity)
		throw new Error("Packaged manifest must match the app tag and archive integrity.");
	const files = packed.files.map((entry) => entry.path);
	if (
		new Set(files).size !== files.length ||
		files.some(
			(file) =>
				!/^([a-zA-Z0-9_.-]+\.mjs|README\.md|LICENSE|package\.json|runtime\.json|runtimes\/(web|dev)\.zip)$/.test(
					file,
				),
		)
	)
		throw new Error("Package contains unexpected files.");
	for (const file of [
		"cli.mjs",
		"verify-release.mjs",
		"package.json",
		"runtime.json",
		"runtimes/web.zip",
		"runtimes/dev.zip",
	])
		if (!files.includes(file)) throw new Error(`Package is incomplete: missing ${file}.`);
	const staging = await mkdtemp(join(tmpdir(), "bn-publish-check-"));
	try {
		await mkdir(join(staging, "runtimes"));
		for (const file of ["package.json", "runtime.json", "runtimes/web.zip", "runtimes/dev.zip"]) {
			const { stdout } = await command("tar", ["-xOzf", archive, `package/${file}`], {
				encoding: "buffer",
			});
			await writeFile(join(staging, file), stdout);
		}
		const pkg = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
		if (pkg.private || pkg.name !== NAME || pkg.publishConfig?.registry)
			throw new Error("Package must be public and use the selected registry.");
		await verifyBnRuntimes(staging);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return { ...meta, archive };
}

async function main() {
	const { values } = parseArgs({
		options: {
			directory: { type: "string", default: "dist/bn-npm" },
			tag: { type: "string" },
			registry: { type: "string", default: "https://registry.npmjs.org/" },
			"dry-run": { type: "boolean" },
			publish: { type: "boolean" },
		},
	});
	if (values.publish && values["dry-run"]) throw new Error("Choose --dry-run or --publish.");
	const tag = values.tag ?? process.env.GITHUB_REF_NAME;
	await command("bash", [".github/scripts/shared/assert-ref-matches-app-version.sh"], {
		env: { ...process.env, GITHUB_REF_NAME: tag ?? "" },
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
	const version = tag.slice(1);
	const candidate = await candidateOf(resolve(values.directory), version, registry.href);
	const channel = version.includes("-") ? "alpha" : "latest";
	if (values.publish) await publishNpmCandidate(candidate, channel, registry.href);
	console.log(
		JSON.stringify({
			dryRun: !values.publish,
			name: NAME,
			version,
			channel,
			integrity: candidate.integrity,
		}),
	);
}

main().catch((error) => {
	console.error(`BN npm release: ${error.message}\n${error.stdout ?? ""}${error.stderr ?? ""}`);
	process.exitCode = 1;
});
