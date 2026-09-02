import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * 已装载荷放在哪 —— `<dataDir>/versions`。
 *
 * 存在的理由是 `boot.mjs` 要在**加载服务端之前**就知道这个目录,而那时候
 * `loadBootstrapConfig` 还没跑(跑它就要把 zod 与整套 schema 拉进 boot 的模块图,
 * 而那个入口存在的全部意义就是「先别加载那些」)。
 *
 * 所以这里是一份**刻意的最小重实现**,只解 `dataDir` 这一个字段,优先级与 loader
 * 保持一致:CLI > 配置文件 > 环境变量 > 默认。防漂移不靠人盯着 ——
 * `__tests__/versions-root.test.ts` 拿**真的 `loadBootstrapConfig`** 跑同一组输入,
 * 两边算出来的 dataDir 必须一样。它们一旦分家,症状是「更新装好了但重启后还是旧
 * 版本」:服务端装到 A 目录,boot 去 B 目录找,两边都不报错。
 */

/**
 * 和 `config/schema.ts` 的 `dataDir` 默认值**必须相同**(相对 cwd):这是两份实现唯一真会
 * 分歧的一档 —— 以前这边写 `/data`、那边写 `./data`,谁在 compose 里删掉 BN_DATA_DIR 就会
 * 「装到 A 目录、boot 去 B 目录找」。镜像与桌面壳都显式给 dataDir,这条只在没配时起作用。
 */
export const DEFAULT_DATA_DIR = "./data";

export interface ResolveVersionsRootInput {
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
	/** 相对路径按它解析,同 loader。 */
	cwd: string;
}

function readCliDataDir(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--data-dir") return argv[i + 1];
		if (arg?.startsWith("--data-dir=")) return arg.slice("--data-dir=".length);
	}
	return undefined;
}

function readFileDataDir(configPath: string): string | undefined {
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = (
			configPath.toLowerCase().endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)
		) as { dataDir?: unknown } | null;
		return typeof parsed?.dataDir === "string" ? parsed.dataDir : undefined;
	} catch {
		// 文件不在(首启动)、读不动、写坏了 —— 一律当没写过,交给下一档。
		return undefined;
	}
}

export function resolveDataDir({ argv, env, cwd }: ResolveVersionsRootInput): string {
	const fromCli = readCliDataDir(argv);
	if (fromCli) return resolve(cwd, fromCli);

	// B 模型:文件即真相,env 只在首启动 seed 过一次。所以文件先于 env。
	if (env.BN_CONFIG && env.BN_CONFIG_DISABLED !== "1") {
		const fromFile = readFileDataDir(resolve(cwd, env.BN_CONFIG));
		if (fromFile) return resolve(cwd, fromFile);
	}
	if (env.BN_DATA_DIR) return resolve(cwd, env.BN_DATA_DIR);
	return resolve(cwd, DEFAULT_DATA_DIR);
}

export function resolveVersionsRoot(input: ResolveVersionsRootInput): string {
	return join(resolveDataDir(input), "versions");
}
