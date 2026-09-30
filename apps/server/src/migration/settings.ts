/**
 * 全局设置 `config/globals.json`:0.x 各个版本留下的形状 → 0.x 最新的形状。一项一项收进来(⑥c),
 * 配置仓开机只认最新的形状。
 *
 * - `defaults.features`:附加项的两代老数据({@link migrateLegacyFeatureFlags});
 * - `defaults.ai`:扁平连接字段、「一家一桶」、手改的人格({@link migrateAiSettings});
 * - `defaults.templates`:历代旧默认原文({@link migrateOldTemplateDefaults});
 * - `linkParsing`:0.9.1 的「范围 + 白名单」({@link migrateLegacyLinkParsing})。
 *
 * 卡片样式那两个退役键(`hideDesc` / `hideFollower`)不用管:schema 不是 strict,读的时候自己剥掉。
 */

import { join } from "node:path";
import { migrateAiSettings } from "./ai.js";
import { migrateLegacyFeatureFlags } from "./features.js";
import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";
import { migrateLegacyLinkParsing } from "./link-parsing.js";
import { migrateOldTemplateDefaults } from "./templates.js";

/** 整份全局设置的 raw → raw。认不得的形状原样放过,由配置仓开机时报出来。 */
export function migrateGlobals(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const out: Record<string, unknown> = { ...raw };
	if (isPlainObject(raw.defaults)) {
		const defaults: Record<string, unknown> = { ...raw.defaults };
		if (defaults.features !== undefined)
			defaults.features = migrateLegacyFeatureFlags(defaults.features);
		if (defaults.ai !== undefined) defaults.ai = migrateAiSettings(defaults.ai);
		if (defaults.templates !== undefined) {
			defaults.templates = migrateOldTemplateDefaults(defaults.templates);
		}
		out.defaults = defaults;
	}
	if (raw.linkParsing !== undefined) out.linkParsing = migrateLegacyLinkParsing(raw.linkParsing);
	return out;
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
