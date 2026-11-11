import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** 发布前核对两份包内载荷；本地装配可保留开发版本，发布钩子仍拒绝它。 */
export async function verifyRelease(directory, { allowDevelopment = false } = {}) {
	const pkg = JSON.parse(await readFile(new URL("package.json", directory), "utf8"));
	const catalog = JSON.parse(await readFile(new URL("runtime.json", directory), "utf8"));
	if ((!allowDevelopment && pkg.version === "0.0.0-dev") || catalog.schemaVersion !== 1)
		throw new Error("Release requires an approved package version and runtime catalog.");
	for (const profile of ["web", "dev"]) {
		const runtime = catalog.runtimes?.[profile];
		if (
			!runtime ||
			runtime.version !== pkg.version ||
			!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(runtime.version) ||
			!/^[a-f0-9]{64}$/.test(runtime.sha256) ||
			!Number.isSafeInteger(runtime.size) ||
			runtime.size <= 0 ||
			runtime.size > 256 * 1024 * 1024 ||
			runtime.file !== `runtimes/${profile}.zip`
		)
			throw new Error(`Release requires a fixed ${profile} runtime descriptor.`);
		const archive = new URL(runtime.file, directory);
		const stat = await lstat(archive);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== runtime.size)
			throw new Error(`Bundled ${profile} runtime size mismatch.`);
		const bytes = await readFile(archive);
		if (createHash("sha256").update(bytes).digest("hex") !== runtime.sha256)
			throw new Error(`Bundled ${profile} runtime SHA256 mismatch.`);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await verifyRelease(new URL("./", import.meta.url));
}
