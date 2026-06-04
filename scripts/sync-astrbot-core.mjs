import { cp, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceDir = resolve(repoRoot, "astrbot/core");
const parsed = parseArgs({
	args: process.argv.slice(2),
	options: {
		target: { type: "string" },
	},
	allowPositionals: true,
});
const targetDir =
	parsed.values.target ??
	process.env.ASTRBOT_CORE_TARGET ??
	resolvePositionalValue(parsed.positionals, "--target");
if (!targetDir) {
	throw new Error("请传入 --target 或设置 ASTRBOT_CORE_TARGET");
}
await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, {
	recursive: true,
	filter: (path) => !shouldSkip(path),
});
console.log(`synced ${sourceDir} -> ${targetDir}`);

function shouldSkip(path) {
	const rel = relative(sourceDir, path).split("\\").join("/");
	if (!rel) return false;
	const segments = rel.split("/");
	if (segments[0] === ".git" || segments[0] === ".venv" || segments[0] === "__pycache__") {
		return true;
	}
	if (segments[0] === "sidecar" && (segments[1] === "state" || segments[1] === "logs")) {
		return true;
	}
	return false;
}

function resolvePositionalValue(positionals, flag) {
	const flagIndex = positionals.indexOf(flag);
	if (flagIndex >= 0 && positionals[flagIndex + 1]) {
		return positionals[flagIndex + 1];
	}
	const first = positionals[0];
	if (first && !first.startsWith("-")) {
		return first;
	}
	return undefined;
}
