import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { type BootstrapConfig, BootstrapConfigSchema } from "./schema.js";

export interface LoadBootstrapConfigOptions {
	/** Process argv (without the leading `node` and script). Defaults to `process.argv.slice(2)`. */
	argv?: readonly string[];
	/** Process env. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Working dir for resolving the bn.config.{yaml,json} file. Defaults to `process.cwd()`. */
	cwd?: string;
}

/**
 * Bootstrap config load order (per plan §4.2):
 *   defaults < BN_CONFIG file | ./bn.config.{yaml,json} < ENV (BN_*) < CLI args
 * Each later layer overrides earlier ones. The result is parsed by `BootstrapConfigSchema`,
 * which also fills in defaults for any missing keys.
 *
 * `BN_CONFIG`, when set, is treated as an absolute (or cwd-relative) path to a
 * single config file. The file extension picks the parser (.json → JSON,
 * everything else → YAML). When unset, the loader falls back to scanning `cwd`
 * for `bn.config.{yaml,yml,json}` in that order. Pointing `BN_CONFIG` at a
 * missing file is a hard error — silent fallback would mask typos.
 */
export function loadBootstrapConfig(opts: LoadBootstrapConfigOptions = {}): BootstrapConfig {
	const argv = opts.argv ?? process.argv.slice(2);
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();

	const fromFile = readConfigFile(cwd, env.BN_CONFIG);
	const fromEnv = readEnv(env);
	const fromCli = readCli(argv);

	const merged = deepMerge(deepMerge(fromFile, fromEnv), fromCli);
	return BootstrapConfigSchema.parse(merged);
}

// ---------------------------------------------------------------------------
// File layer
// ---------------------------------------------------------------------------

function readConfigFile(cwd: string, explicitPath: string | undefined): Record<string, unknown> {
	if (explicitPath) {
		const abs = resolvePath(cwd, explicitPath);
		const raw = readFileSync(abs, "utf8");
		const isJson = abs.toLowerCase().endsWith(".json");
		if (isJson) return interpolateEnvDeep(JSON.parse(raw)) as Record<string, unknown>;
		return (interpolateEnvDeep(parseYaml(raw)) as Record<string, unknown>) ?? {};
	}
	for (const candidate of ["bn.config.yaml", "bn.config.yml", "bn.config.json"]) {
		const abs = resolvePath(cwd, candidate);
		try {
			const raw = readFileSync(abs, "utf8");
			if (candidate.endsWith(".json")) {
				return interpolateEnvDeep(JSON.parse(raw)) as Record<string, unknown>;
			}
			return (interpolateEnvDeep(parseYaml(raw)) as Record<string, unknown>) ?? {};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
	}
	return {};
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

// ---------------------------------------------------------------------------
// ENV layer (BN_* prefix, plan §4.2)
// ---------------------------------------------------------------------------

function readEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (env.BN_HOST) setPath(out, ["server", "host"], env.BN_HOST);
	if (env.BN_PORT) setPath(out, ["server", "port"], env.BN_PORT);
	if (env.BN_DATA_DIR) out.dataDir = env.BN_DATA_DIR;
	if (env.BN_COOKIE_KEY) out.cookieEncryptionKey = env.BN_COOKIE_KEY;
	if (env.BN_LOG_LEVEL) out.logLevel = env.BN_LOG_LEVEL;
	if (env.BN_DASHBOARD_USER && env.BN_DASHBOARD_PASS) {
		setPath(out, ["auth", "basicAuth", "username"], env.BN_DASHBOARD_USER);
		setPath(out, ["auth", "basicAuth", "password"], env.BN_DASHBOARD_PASS);
	}
	return out;
}

// ---------------------------------------------------------------------------
// CLI layer (--key=value or --key value)
// ---------------------------------------------------------------------------

const CLI_KEY_MAP: Record<string, string[]> = {
	host: ["server", "host"],
	port: ["server", "port"],
	"data-dir": ["dataDir"],
	"log-level": ["logLevel"],
	"cookie-key": ["cookieEncryptionKey"],
};

function readCli(argv: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (!tok || !tok.startsWith("--")) continue;
		const body = tok.slice(2);
		const eq = body.indexOf("=");
		let key: string;
		let value: string | undefined;
		if (eq >= 0) {
			key = body.slice(0, eq);
			value = body.slice(eq + 1);
		} else {
			key = body;
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				value = next;
				i++;
			} else {
				value = "true";
			}
		}
		const path = CLI_KEY_MAP[key];
		if (path && value !== undefined) setPath(out, path, value);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...a };
	for (const [k, v] of Object.entries(b)) {
		const prev = out[k];
		if (isPlainObject(prev) && isPlainObject(v)) {
			out[k] = deepMerge(prev, v);
		} else if (v !== undefined) {
			out[k] = v;
		}
	}
	return out;
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let cursor: Record<string, unknown> = target;
	for (let i = 0; i < path.length - 1; i++) {
		const seg = path[i] as string;
		const next = cursor[seg];
		if (!isPlainObject(next)) {
			const fresh: Record<string, unknown> = {};
			cursor[seg] = fresh;
			cursor = fresh;
		} else {
			cursor = next;
		}
	}
	const leaf = path[path.length - 1];
	if (leaf !== undefined) cursor[leaf] = value;
}
