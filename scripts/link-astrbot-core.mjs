import { cp, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const parsed = parseArgs({
	args: process.argv.slice(2),
	options: {
		"astrbot-root": { type: "string" },
		force: { type: "boolean", default: false },
		source: { type: "string" },
		symlink: { type: "boolean", default: false },
	},
	allowPositionals: true,
});
const astrbotRoot =
	parsed.values["astrbot-root"] ??
	process.env.ASTRBOT_ROOT ??
	resolvePositionalValue(parsed.positionals, "--astrbot-root");
if (!astrbotRoot) {
	throw new Error("请传入 --astrbot-root 或设置 ASTRBOT_ROOT");
}
const sourceDir = resolve(parsed.values.source ?? resolve(repoRoot, "astrbot/core"));
const targetDir = resolve(astrbotRoot, "data/plugins/astrbot_plugin_bilibili_notify");
await mkdir(dirname(targetDir), { recursive: true });
if (await exists(targetDir)) {
	if (!parsed.values.force) {
		throw new Error(`目标已存在: ${targetDir}。如需覆盖，请加 --force。`);
	}
	await rm(targetDir, { recursive: true, force: true });
}
if (parsed.values.symlink) {
	await symlink(sourceDir, targetDir, process.platform === "win32" ? "junction" : "dir");
	console.log(`linked ${targetDir} -> ${sourceDir}`);
} else {
	await cp(sourceDir, targetDir, { recursive: true, filter: shouldCopy });
	console.log(`copied ${sourceDir} -> ${targetDir}`);
}

function shouldCopy(path) {
	const rel = relative(sourceDir, path).split("\\").join("/");
	if (!rel) return true;
	const segments = rel.split("/");
	if (
		segments[0] === ".git" ||
		segments[0] === ".pytest_cache" ||
		segments[0] === ".ruff_cache" ||
		segments[0] === ".venv" ||
		segments[0] === "__pycache__"
	) {
		return false;
	}
	if (
		segments[0] === "sidecar" &&
		(segments[1] === "cache" || segments[1] === "state" || segments[1] === "logs")
	) {
		return false;
	}
	return true;
}

async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
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
