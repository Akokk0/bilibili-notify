#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
	options: { out: { type: "string", default: "dist/extension-tooling" } },
});
const directory = resolve(values.out);
await mkdir(directory, { recursive: true });
const packages = [];
for (const path of ["packages/extension", "tools/create-extension"]) {
	const { name, version } = JSON.parse(await readFile(join(root, path, "package.json"), "utf8"));
	const file = `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
	await exec("vp", ["pm", "pack", "--out", join(directory, file), "--json"], {
		cwd: join(root, path),
		timeout: 60_000,
	});
	const bytes = await readFile(join(directory, file));
	packages.push({
		name,
		version,
		file,
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	});
}
await writeFile(
	join(directory, "packages.json"),
	`${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
);
console.log(`Tooling npm packages: ${directory}`);
