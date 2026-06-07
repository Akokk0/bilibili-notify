import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const targetIndex = resolve(repoRoot, "astrbot/core/pages/dashboard/index.html");

await runCommand("vp", ["run", "-F", "@bilibili-notify/astrbot-page", "build"], repoRoot);
await access(targetIndex);
console.log(`built AstrBot dashboard page -> ${targetIndex}`);

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
