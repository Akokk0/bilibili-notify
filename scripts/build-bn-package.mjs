#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleBnPackage } from "./assemble-bn-package.mjs";
import { readArg } from "./cli-args.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(readArg("out", "dist/bn-npm"));
async function run(args, cwd = repoRoot) {
	await new Promise((resolve, reject) => {
		const child = spawn("vp", args, { cwd, stdio: "inherit", env: process.env });
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			code === 0
				? resolve()
				: reject(new Error(`vp ${args.join(" ")} failed (${code ?? signal}).`)),
		);
	});
}

await run(["run", "-F", "@bilibili-notify/bn", "build"]);
await run(["run", "build:bn-runtimes"]);
await mkdir(outDir, { recursive: true });
const staging = await mkdtemp(join(outDir, ".pack-"));
try {
	const directory = join(staging, "package");
	await assembleBnPackage({
		cliDir: join(repoRoot, "tools/bn-cli/lib"),
		runtimesDir: join(repoRoot, "dist/bn-runtimes"),
		outDir: directory,
	});
	const { name, version } = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	const file = `bilibili-notify-bn-${version}.tgz`;
	await run(["pm", "pack", "--out", join(outDir, file), "--json"], directory);
	const bytes = await readFile(join(outDir, file));
	await writeFile(
		join(outDir, "package.json"),
		`${JSON.stringify(
			{
				name,
				version,
				file,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`BN npm package: ${join(outDir, file)}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
