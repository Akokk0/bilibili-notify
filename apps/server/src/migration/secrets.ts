/**
 * 加密袋 `secrets/config-secrets.enc`:0.x 早期只有一套 AI 连接时,袋里那把 key 叫 `aiApiKey`(单把)→ 放进按
 * 服务商分桶的 `aiApiKeys.custom` —— 设置那一族把扁平的旧 AI 配置整份迁进了 `providers.custom`,两边正好对上。
 * 收进来之前是配置仓开机时做(⑥c),配置仓开机只认分桶的袋子。
 *
 * 袋子用的就是配置仓那一份读写(`createSecretStore`),格式与权限只有一个真源。解袋要主密钥:由调用方取第 0 代
 * 那把交进来(迁移逐字节搬过来,是同一把)。拿不到、解不开的原样留着 —— 配置仓开机解不开照旧当空袋起、记一句
 * warn,和改之前一样。
 */

import type { Logger } from "@bilibili-notify/internal";
import type { KeyMaterialState } from "@bilibili-notify/storage";
import { createSecretStore } from "../config/secret-store.js";

/** 0.x 的袋子:比现在多一格单把的 `aiApiKey`。 */
interface ZeroSecretBag {
	aiApiKey?: unknown;
	aiApiKeys?: Record<string, string>;
}

/** 迁移不打日志:解不开的那一句留给配置仓开机时说。 */
const QUIET: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 新代里的加密袋迁成最新的形状,回改写过的文件(绝对路径)。单把那格并进 `custom` 时,分桶里已有的 `custom`
 * 优先。
 */
export async function migrateSecretBag(path: string, key: KeyMaterialState): Promise<string[]> {
	if (key.kind !== "ok") return [];
	const store = createSecretStore({
		filePath: path,
		keyProvider: { getKey: async () => key.key, protected: false },
		logger: QUIET,
	});
	const bag = (await store.load()) as ZeroSecretBag;
	if (typeof bag.aiApiKey !== "string" || bag.aiApiKey === "") return [];
	const { aiApiKey, ...rest } = bag;
	await store.save({ ...rest, aiApiKeys: { custom: aiApiKey, ...(bag.aiApiKeys ?? {}) } });
	return [path];
}
