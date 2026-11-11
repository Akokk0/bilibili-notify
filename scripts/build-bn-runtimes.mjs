#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUpdatePayload } from "./build-update-payload.mjs";
import { readArg } from "./cli-args.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, readArg("out", "dist/bn-runtimes"));

async function run(args) {
	await new Promise((resolve, reject) => {
		const child = spawn("vp", args, { cwd: repoRoot, stdio: "inherit", env: process.env });
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			code === 0
				? resolve()
				: reject(new Error(`vp ${args.join(" ")} failed (${code ?? signal}).`)),
		);
	});
}

// 两种用途分别输出，普通发行目录仍由原生产隔离门把关。
await run(["run", "build:update-payload"]);
await run(["run", "-F", "@bilibili-notify/server", "build:dev-runtime"]);
await run(["run", "-F", "@bilibili-notify/web", "build:dev-runtime"]);
await new Promise((resolvePromise, reject) => {
	const child = spawn(
		process.execPath,
		[join(repoRoot, "scripts/assemble-server-bundle.mjs"), "--server-dist", "apps/server/dist-dev"],
		{ cwd: repoRoot, stdio: "inherit" },
	);
	child.once("error", reject);
	child.once("exit", (code) =>
		code === 0 ? resolvePromise() : reject(new Error("Development runtime assembly failed.")),
	);
});

await mkdir(join(outDir, "runtimes"), { recursive: true });
const runtimes = {};
for (const profile of ["web", "dev"]) {
	const suffix = profile === "dev" ? "dist-dev" : "dist";
	const serverDist = join(repoRoot, "apps/server", suffix);
	const { version } = JSON.parse(await readFile(join(serverDist, "package.json"), "utf8"));
	const packed = await buildUpdatePayload({
		serverDist,
		webDist: join(repoRoot, "apps/web", suffix),
		outFile: join(outDir, "runtimes", `${profile}.zip`),
		runtimeProfile: profile,
	});
	runtimes[profile] = {
		version,
		file: `runtimes/${profile}.zip`,
		size: packed.size,
		sha256: packed.sha256,
	};
}
await writeFile(
	join(outDir, "runtime.json"),
	`${JSON.stringify({ schemaVersion: 1, runtimes }, null, 2)}\n`,
);
console.log(`BN runtime catalog: ${join(outDir, "runtime.json")}`);
