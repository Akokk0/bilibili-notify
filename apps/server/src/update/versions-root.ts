import { resolve } from "node:path";
import { bootstrapCli } from "../config/bootstrap-cli.js";
import { readLegacyFile, readYamlOrJson } from "../config/bootstrap-file.js";
import { hostPath } from "../runtime/roots.js";

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

export interface ResolveVersionsRootOptions {
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
	/** 相对路径按它解析,同 loader。 */
	cwd: string;
}

export function resolveDataDir({ argv, env, cwd }: ResolveVersionsRootOptions): string {
	const fromCli = bootstrapCli(argv).get("data-dir");
	if (fromCli) return resolve(cwd, fromCli);
	const seeded = env.BN_DATA_DIR || DEFAULT_DATA_DIR;
	if (env.BN_CONFIG_DISABLED === "1") return resolve(cwd, seeded);
	try {
		if (env.BN_CONFIG) {
			const { dataDir } = readYamlOrJson(resolve(cwd, env.BN_CONFIG));
			return resolve(cwd, typeof dataDir === "string" ? dataDir : DEFAULT_DATA_DIR);
		}
		if (!env.BN_DATA_DIR) {
			const { dataDir } = readLegacyFile(cwd);
			if (typeof dataDir === "string") return resolve(cwd, dataDir);
		}
	} catch {
		// The full loader handles first-boot seeding and reports malformed files.
	}
	return resolve(cwd, seeded);
}

/**
 * 已装载荷放在宿主根(就是 `dataDir`)的哪个子目录下。
 *
 * 服务端(index.ts,dataDir 由 loader 算好)和 boot(自己解 dataDir)都得回答这一问,
 * 而**这段路径没有任何理由分两处写**:上面那份刻意的重实现只覆盖 `dataDir` 的优先级
 * (boot 加载不了 zod),不覆盖这一段。写岔了的症状与 dataDir 写岔了完全一样 ——
 * 服务端装到 A 目录、boot 去 B 目录找,两边都不报错。
 */
export function versionsRootIn(hostRoot: string): string {
	return resolve(hostPath(hostRoot, "versions"));
}

export function resolveVersionsRoot(input: ResolveVersionsRootOptions): string {
	return versionsRootIn(resolveDataDir(input));
}
