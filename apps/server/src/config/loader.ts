import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { shouldRefuseBareAuth } from "../auth/bare-auth-policy.js";
import { type BootstrapConfig, BootstrapConfigSchema } from "./schema.js";

export interface LoadBootstrapConfigOptions {
	/** Process argv (without the leading `node` and script). Defaults to `process.argv.slice(2)`. */
	argv?: readonly string[];
	/** Process env. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Working dir for resolving the bn.config.{yaml,json} file. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Diagnostic sink used on first-boot seed. Defaults to writing one line to stderr. */
	log?: (msg: string) => void;
}

/**
 * Bootstrap config loader — **B 模型**(env 仅首启动 seed,之后 file 为唯一真相)。
 *
 * 两条分支,由 `BN_CONFIG` 是否显式设置切换:
 *
 *   - **`BN_CONFIG` 已设(部署主路径,docker 镜像 ENV 默认 `/config/bn.config.yaml`)**:
 *       1. 路径不存在(ENOENT)→ first boot:env + CLI + schema defaults 算出配置;
 *          若结果监听 non-loopback 又无 basicAuth(裸暴露,index.ts 门禁会 fail-closed
 *          拒绝启动)→ 就地生成兜底凭据(随机密码)补进 auth → stringify yaml,
 *          原子写入(tmpfile + rename)→ 返回配置
 *       2. 路径是目录(EISDIR,常见于 docker bind-mount 单文件 host 端未创建)→
 *          精准报错挂掉,日志指向 docs(不自动救场:删用户挂载对象有数据丢失风险)
 *       3. 路径是文件 → 读取 + parse,**忽略所有 env**(file 是唯一真相),仅 CLI 可叠加覆盖
 *          (CLI 是一次性 escape hatch,不像 env 是 image/compose 持久声明)
 *       4. file 内 schema 校验错 → 报错挂,日志说哪个字段错(用户去修文件)
 *
 *   - **`BN_CONFIG` 未设(dev / vp test 跑测试)**:
 *       走 legacy 12-factor 模型 — file(若 cwd 扫到)< ENV < CLI 三层 merge。
 *       不 seed(没有显式的 yaml 落点),不破坏 dev 模式。
 *
 * `dataDir` 在 B 模型下跟其他字段一样 seed/读 — BN_CONFIG 已显式指定 yaml 路径,
 * 与 dataDir(state 目录)解耦,无鸡生蛋。docker 部署 image 默认 `BN_CONFIG=/config/bn.config.yaml`
 * 配合用户 `./config:/config` mount,yaml 自动出现在 host 端 `./config/`,可直接 vim 编辑。
 */
export function loadBootstrapConfig(opts: LoadBootstrapConfigOptions = {}): BootstrapConfig {
	const argv = opts.argv ?? process.argv.slice(2);
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();
	const log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));

	const fromCli = readCli(argv);

	// 桌面壳/sidecar 路径:显式禁用 bootstrap file,避免读取或生成 bn.config.*。
	if (env.BN_CONFIG_DISABLED === "1") {
		if (env.BN_CONFIG) {
			throw new Error("BN_CONFIG_DISABLED=1 cannot be used together with BN_CONFIG");
		}
		return loadEnvCliModel(env, fromCli);
	}

	// 显式 BN_CONFIG → B 模型
	if (env.BN_CONFIG) {
		const yamlPath = resolvePath(cwd, env.BN_CONFIG);
		return loadBModel(yamlPath, env, fromCli, log);
	}

	// 未设 BN_CONFIG → legacy 12-factor:扫 cwd 候选文件,三层 merge
	return loadLegacyModel(cwd, env, fromCli);
}

/**
 * 解析当前运行时使用的 bootstrap 配置文件路径,供运行时写回(dashboard 热启用卡片
 * 渲染后持久化 chromePath)。仅 B 模型(显式 BN_CONFIG)可写回;BN_CONFIG_DISABLED
 * (sidecar/desktop)与 legacy 12-factor(dev,无单一目标文件)返回 null —— 这些场景
 * 运行时持久化无意义,改配置走 env / 手编辑 yaml。
 */
export function resolveConfigPath(
	opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string | null {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();
	if (env.BN_CONFIG_DISABLED === "1") return null;
	if (env.BN_CONFIG) return resolvePath(cwd, env.BN_CONFIG);
	return null;
}

// ---------------------------------------------------------------------------
// B 模型:BN_CONFIG 显式指定路径,env 仅首启动 seed
// ---------------------------------------------------------------------------

function loadBModel(
	yamlPath: string,
	env: NodeJS.ProcessEnv,
	fromCli: Record<string, unknown>,
	log: (msg: string) => void,
): BootstrapConfig {
	const state = inspectPath(yamlPath);

	if (state === "directory") {
		// 常见于 docker bind-mount 单文件时 host 端 yaml 未创建,docker 自动建空目录占位
		throw new Error(
			`bootstrap config path is a directory: ${yamlPath}\n` +
				"  → 常见于 docker bind-mount 单文件而 host 端 yaml 不存在,docker 自动建空目录。\n" +
				"  → 解决:在 docker-compose.yaml 里删掉 bn.config.yaml 的 single-file volume 挂载,\n" +
				"     改成挂目录;或先 'rm -rf <host 路径>' 让 first boot 自动 seed。\n" +
				"  → 详见 apps/docker-compose.example.yaml",
		);
	}

	if (state === "missing") {
		// First boot — env + CLI + schema defaults 算出配置 → 原子写入
		const fromEnv = readEnv(env);
		const seedMerged = deepMerge(fromEnv, fromCli);
		const seeded = parseOrRethrow(seedMerged, yamlPath, "seed");
		maybeSeedDashboardCredentials(seeded, env, log);
		writeSeedFile(yamlPath, seeded, log);
		return seeded;
	}

	// 文件存在:读取 + parse,跳过 env,仅 CLI 叠加
	const fileObj = readYamlOrJson(yamlPath);
	const merged = deepMerge(fileObj, fromCli);
	return parseOrRethrow(merged, yamlPath, "read");
}

function parseOrRethrow(
	raw: Record<string, unknown>,
	yamlPath: string,
	mode: "seed" | "read",
): BootstrapConfig {
	const result = BootstrapConfigSchema.safeParse(raw);
	if (result.success) return result.data;
	const hint =
		mode === "read"
			? `修复 yaml 后重启,或 'rm ${yamlPath}' 让 first boot 重新 seed`
			: "请检查 BN_* 环境变量取值";
	throw new Error(
		`bootstrap config schema error (${mode}) at ${yamlPath}:\n${result.error.message}\n  → ${hint}`,
	);
}

const SEED_HEADER = `# bilibili-notify bootstrap config (auto-generated on first boot)
#
# 模型:env 仅在首次启动写入此文件,之后启动 env 被 loader 忽略 —— 文件即真相。
# 编辑此文件后重启容器: docker compose restart
# 完全重置(让 env 重新 seed): rm 本文件 + docker compose up -d
#
`;

function writeSeedFile(path: string, config: BootstrapConfig, log: (msg: string) => void): void {
	mkdirSync(dirname(path), { recursive: true });
	// 扩展名 dispatch:.json 路径用 JSON.stringify,否则 yaml(yaml 加 SEED_HEADER 注释,
	// JSON 不支持注释跳过)。若不分派,.json 扩展名的 first-boot 写出 yaml 内容 →
	// 第二次启动 readYamlOrJson 走 JSON.parse 直接炸 → restart loop。
	const isJson = path.toLowerCase().endsWith(".json");
	const body = isJson
		? JSON.stringify(config, null, 2)
		: `${SEED_HEADER}${stringifyYaml(config, { indent: 2 })}`;
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	// mode 0o600:seed 文件可能含 cookieEncryptionKey / dashboard password 等 secret,
	// 只对 owner 可读。tmpfile + rename 仍保持原子语义。
	writeFileSync(tmp, body, { mode: 0o600, encoding: "utf8" });
	renameSync(tmp, path);
	log(`[bootstrap] first boot — seeded bootstrap config from ENV to ${path}`);
}

/**
 * First-boot 安全兜底:若 seed 出的配置没有 dashboard basicAuth,且监听 non-loopback
 * 又没设逃生口 `BN_ALLOW_NO_AUTH=1` —— 此时 index.ts 的 bare-auth 门禁会 fail-closed
 * 拒绝启动(docker 镜像 ENV 默认 `BN_HOST=0.0.0.0`,首启动必中),容器进无限重启循环。
 * 这里**就地**生成兜底凭据补进 `config.auth.basicAuth`(用户名取 `BN_DASHBOARD_USER`,
 * 未设则 `admin`;密码恒为随机),门禁因此放行。
 *
 * 触发判定直接复用门禁的 `shouldRefuseBareAuth` —— 保证「会生成」⇔「否则会被拒」,
 * 单一事实源。loopback 部署 / 显式 `BN_ALLOW_NO_AUTH=1` 时不强塞凭据(裸跑本就合法)。
 *
 * 凭据随后由 `writeSeedFile` 写进 yaml(host 端 `./config/bn.config.yaml`,mode 0600)
 * 并经 `log` 打到 stderr(docker logs 可见),用户两处都能取。随机串走 base64url
 * (字符集 `A-Za-z0-9-_`),不含 `${`,不会被 `interpolateEnvDeep` 二次替换。
 */
function maybeSeedDashboardCredentials(
	config: BootstrapConfig,
	env: NodeJS.ProcessEnv,
	log: (msg: string) => void,
): void {
	if (config.auth?.basicAuth) return; // 用户已通过 BN_DASHBOARD_USER/PASS 显式提供
	const allowNoAuth = env.BN_ALLOW_NO_AUTH === "1";
	const refuse = shouldRefuseBareAuth({
		host: config.server.host,
		hasBasicAuth: false,
		allowNoAuth,
	});
	if (!refuse) return; // loopback 或显式逃生口 —— 裸跑合法,不生成

	// 半配置(只设 BN_DASHBOARD_USER 没设 PASS,readEnv 因不成对未写 basicAuth)时
	// 尊重用户设的用户名,仅兜底生成密码;未设则回落 `admin`。
	const username = env.BN_DASHBOARD_USER || "admin";
	const password = randomBytes(18).toString("base64url");
	config.auth = { ...config.auth, basicAuth: { username, password } };
	log(
		"[bootstrap] dashboard auth 未配置且监听 non-loopback —— 已自动生成登录凭据:\n" +
			`             username: ${username}\n` +
			`             password: ${password}\n` +
			"           凭据已写入 bootstrap yaml(host 端 ./config/bn.config.yaml)。" +
			"登录后请编辑该文件修改 auth.basicAuth 并重启容器。",
	);
}

type PathState = "missing" | "directory" | "file";
function inspectPath(path: string): PathState {
	try {
		return statSync(path).isDirectory() ? "directory" : "file";
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Legacy 12-factor 模型(无 BN_CONFIG,dev/test 路径)
// ---------------------------------------------------------------------------

function loadLegacyModel(
	cwd: string,
	env: NodeJS.ProcessEnv,
	fromCli: Record<string, unknown>,
): BootstrapConfig {
	const fromFile = readLegacyFile(cwd);
	const fromEnv = readEnv(env);
	const merged = deepMerge(deepMerge(fromFile, fromEnv), fromCli);
	return BootstrapConfigSchema.parse(merged);
}

function loadEnvCliModel(
	env: NodeJS.ProcessEnv,
	fromCli: Record<string, unknown>,
): BootstrapConfig {
	const fromEnv = readEnv(env);
	return BootstrapConfigSchema.parse(deepMerge(fromEnv, fromCli));
}

function readLegacyFile(cwd: string): Record<string, unknown> {
	for (const candidate of ["bn.config.yaml", "bn.config.yml", "bn.config.json"]) {
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

function readYamlOrJson(path: string): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// ENV layer (BN_* prefix)
// ---------------------------------------------------------------------------

function readEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (env.BN_HOST) setPath(out, ["server", "host"], env.BN_HOST);
	if (env.BN_PORT) setPath(out, ["server", "port"], env.BN_PORT);
	if (env.BN_DATA_DIR) out.dataDir = env.BN_DATA_DIR;
	if (env.BN_COOKIE_KEY) out.cookieEncryptionKey = env.BN_COOKIE_KEY;
	if (env.BN_CHROME_PATH) out.chromePath = env.BN_CHROME_PATH;
	if (env.BN_WEB_DIST) out.webDistDir = env.BN_WEB_DIST;
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
	"chrome-path": ["chromePath"],
	"web-dist": ["webDistDir"],
};

function readCli(argv: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (!tok?.startsWith("--")) continue;
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
