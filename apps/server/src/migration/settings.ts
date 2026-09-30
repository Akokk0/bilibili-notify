/**
 * 全局设置 `config/globals.json`:0.x 各个版本留下的形状 → 0.x 最新的形状。一项一项收进来(⑥c),
 * 配置仓开机只认最新的形状。
 *
 * - `defaults.features`:附加项的两代老数据({@link migrateLegacyFeatureFlags})。
 */

import { join } from "node:path";
import { migrateLegacyFeatureFlags } from "./features.js";
import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";

/** 整份全局设置的 raw → raw。认不得的形状原样放过,由配置仓开机时报出来。 */
export function migrateGlobals(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const defaults = raw.defaults;
	if (!isPlainObject(defaults) || defaults.features === undefined) return raw;
	return {
		...raw,
		defaults: { ...defaults, features: migrateLegacyFeatureFlags(defaults.features) },
	};
}

/**
 * 新代里的 `globals.json` 迁成最新的形状,回改写过的文件(绝对路径)。没变就不写 —— 新代里还是搬过来的那个文件。
 * 读不懂的原样留着,由配置仓开机时报出来。
 */
export async function migrateSettingsFile(configDir: string): Promise<string[]> {
	const path = join(configDir, "globals.json");
	const file = await readJsonFile(path);
	if (file.kind !== "ok") return [];
	const next = migrateGlobals(file.value);
	if (JSON.stringify(next) === JSON.stringify(file.value)) return [];
	await rewriteJsonFile(path, next);
	return [path];
}
