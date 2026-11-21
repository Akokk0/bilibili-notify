import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Legacy 12-factor 模型扫描的 bootstrap 配置文件候选(按优先级)。readLegacyFile
 * 读取、resolveConfigPath 定位写回目标,两处共用避免漂移。
 */
export const LEGACY_CONFIG_CANDIDATES = [
	"bn.config.yaml",
	"bn.config.yml",
	"bn.config.json",
] as const;

export function readLegacyFile(cwd: string): Record<string, unknown> {
	for (const candidate of LEGACY_CONFIG_CANDIDATES) {
		const abs = resolvePath(cwd, candidate);
		try {
			return readYamlOrJson(abs);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
	}
	return {};
}

// ---------------------------------------------------------------------------
// File parse (共用)
// ---------------------------------------------------------------------------

export function readYamlOrJson(path: string): Record<string, unknown> {
	const raw = readFileSync(path, "utf8");
	const isJson = path.toLowerCase().endsWith(".json");
	const parsed = isJson ? JSON.parse(raw) : parseYaml(raw);
	return (interpolateEnvDeep(parsed) as Record<string, unknown>) ?? {};
}

/** Replace `${VAR}` in any string leaf with `process.env.VAR`; pass through if undefined. */
function interpolateEnvDeep(node: unknown): unknown {
	if (typeof node === "string") {
		return node.replace(/\$\{([A-Z0-9_]+)\}/gi, (m, name: string) => process.env[name] ?? m);
	}
	if (Array.isArray(node)) return node.map(interpolateEnvDeep);
	if (node && typeof node === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(node)) out[k] = interpolateEnvDeep(v);
		return out;
	}
	return node;
}
