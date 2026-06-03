import { spawn } from "node:child_process";

const rawArgs = process.argv.slice(2);
const passthroughArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const hasBundleOverride = passthroughArgs.some(
	(arg) => arg === "--bundles" || arg === "-b" || arg.startsWith("--bundles="),
);
const skipsBundle = passthroughArgs.includes("--no-bundle");
const asksForHelp = passthroughArgs.includes("--help") || passthroughArgs.includes("-h");

const args = ["tauri", "build"];

if (!asksForHelp && !passthroughArgs.includes("--ci")) {
	args.push("--ci");
}

if (process.platform === "win32" && !hasBundleOverride && !skipsBundle && !asksForHelp) {
	args.push("--bundles", "nsis");
}

args.push(...passthroughArgs);

const command = process.platform === "win32" ? "vpx.exe" : "vpx";
const child = spawn(command, args, { stdio: "inherit" });

child.on("error", (err) => {
	console.error(`[desktop] failed to start ${command}: ${err.message}`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	if (signal) {
		console.error(`[desktop] tauri build terminated by ${signal}`);
		process.exit(1);
	}
	process.exit(code ?? 1);
});
