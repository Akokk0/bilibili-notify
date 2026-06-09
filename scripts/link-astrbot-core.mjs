import { cp, mkdir, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertSafeTarget, clearTargetPreservingRuntime, exists } from "./astrbot-core-target.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const parsed = parseArgs({
	args: normalizeRunScriptArgs(process.argv.slice(2)),
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
const targetExists = await exists(targetDir);
if (targetExists && !parsed.values.force) {
	throw new Error(`目标已存在: ${targetDir}。如需覆盖，请加 --force。`);
}
if (parsed.values.symlink) {
	// Symlink mode points the target at the source tree, so there is no
	// target-side runtime to preserve. Still guard against wiping a non-plugin
	// directory the user pointed us at by mistake.
	if (targetExists) {
		await assertSafeTarget(targetDir);
		await clearTargetPreservingRuntime(targetDir);
		// A symlink cannot share its inode with surviving runtime dirs, so the
		// target path itself must be free before we create the link.
		if (await exists(targetDir)) {
			throw new Error(
				`无法以 symlink 模式覆盖 ${targetDir}: 目标内仍保留运行态数据` +
					`（sidecar/state · cache · logs）。请改用默认 copy 模式，或先手动备份并清空运行态。`,
			);
		}
	}
	await symlink(sourceDir, targetDir, process.platform === "win32" ? "junction" : "dir");
	console.log(`linked ${targetDir} -> ${sourceDir}`);
} else {
	if (targetExists) {
		await assertSafeTarget(targetDir);
		await clearTargetPreservingRuntime(targetDir);
	}
	await cp(sourceDir, targetDir, { recursive: true, filter: shouldCopy });
	console.log(`copied ${sourceDir} -> ${targetDir}`);
}

function normalizeRunScriptArgs(args) {
	return args[0] === "--" ? args.slice(1) : args;
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
