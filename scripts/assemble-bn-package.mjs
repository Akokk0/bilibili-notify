#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { verifyRelease } from "../tools/bn-cli/scripts/verify-release.mjs";
import { readArg } from "./cli-args.mjs";

/** 装配和发行复用同一套载荷版本、用途与完整性校验。 */
export async function verifyBnRuntimes(directory, options) {
	await verifyRelease(pathToFileURL(`${directory}/`), options);
	const catalog = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
	for (const profile of ["web", "dev"]) {
		const files = unzipSync(await readFile(join(directory, catalog.runtimes[profile].file)));
		for (const file of [
			"index.mjs",
			"boot.mjs",
			"package.json",
			"bn-runtime.json",
			"web-dist/index.html",
		])
			if (!files[file])
				throw new Error(`Bundled ${profile} runtime is incomplete: missing ${file}.`);
		const marker = JSON.parse(Buffer.from(files["bn-runtime.json"] ?? []).toString("utf8"));
		const pkg = JSON.parse(Buffer.from(files["package.json"] ?? []).toString("utf8"));
		if (
			marker.schemaVersion !== 1 ||
			marker.profile !== profile ||
			marker.version !== catalog.runtimes[profile].version ||
			pkg.version !== marker.version
		)
			throw new Error(`Bundled ${profile} runtime profile or version mismatch.`);
	}
}

/** 编译壳与同版本双宿主装成独立npm目录；发布钩子另行拒绝开发版本。 */
export async function assembleBnPackage({ cliDir, runtimesDir, outDir }) {
	const catalog = JSON.parse(await readFile(join(runtimesDir, "runtime.json"), "utf8"));
	await mkdir(dirname(outDir), { recursive: true });
	const staging = await mkdtemp(join(dirname(outDir), ".bn-package-"));
	try {
		for (const entry of await readdir(cliDir)) {
			if (entry.endsWith(".mjs") || ["package.json", "README.md", "LICENSE"].includes(entry))
				await cp(join(cliDir, entry), join(staging, entry));
		}
		await mkdir(join(staging, "runtimes"));
		for (const profile of ["web", "dev"]) {
			const descriptor = catalog.runtimes?.[profile];
			if (descriptor?.file !== `runtimes/${profile}.zip`)
				throw new Error(`Missing bundled ${profile} runtime descriptor.`);
			await cp(join(runtimesDir, descriptor.file), join(staging, descriptor.file));
		}
		await writeFile(join(staging, "runtime.json"), `${JSON.stringify(catalog, null, 2)}\n`);
		await verifyBnRuntimes(staging, { allowDevelopment: true });
		await rename(staging, outDir);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await assembleBnPackage({
		cliDir: resolve(readArg("cli", "tools/bn-cli/lib")),
		runtimesDir: resolve(readArg("runtimes", "dist/bn-runtimes")),
		outDir: resolve(readArg("out", "dist/bn-npm/package")),
	});
}
