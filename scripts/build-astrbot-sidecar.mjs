import { spawn } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceDir = resolve(repoRoot, "astrbot/sidecar/dist");
const targetDir = resolve(repoRoot, "astrbot/core/sidecar/app");

await runCommand("vp", ["run", "-F", "@bilibili-notify/astrbot-sidecar", "build"], repoRoot);
await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true });

async function runCommand(command, args, cwd) {
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", rejectPromise);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise(undefined);
				return;
			}
			rejectPromise(
				new Error(
					`${command} ${args.join(" ")} failed with code ${code ?? "null"} signal ${signal ?? "null"}`,
				),
			);
		});
	});
}
