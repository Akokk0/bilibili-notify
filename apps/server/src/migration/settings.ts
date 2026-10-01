/**
 * 核心的设置(0.x 的 `state/globals.json`,新代里在 `config/settings/core.json`):0.x 各个版本留下的形状 → 0.x
 * 最新的形状。一项一项收进来(⑥c),配置仓开机只认最新的形状。
 *
 * - `defaults.features`:附加项的两代老数据({@link migrateLegacyFeatureFlags});
 * - `defaults.ai`:扁平连接字段、「一家一桶」、手改的人格({@link migrateAiSettings});
 * - `defaults.templates`:历代旧默认原文({@link migrateOldTemplateDefaults});
 * - `linkParsing`:0.9.1 的「范围 + 白名单」({@link migrateLegacyLinkParsing})。
 *
 * 卡片样式那两个退役键(`hideDesc` / `hideFollower`)不用管:schema 不是 strict,读的时候自己剥掉。
 *
 * 设置按集成分文件(ADR-0021 决策 42 下 10-01 的 🔗):`app` 里 B 站的三格搬进 `config/settings/bilibili.json`,
 * 只挪位置、不改键名({@link splitBilibiliSettings})。
 */

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

/** 核心设置的 `app` 里归 B 站的三格。 */
const BILIBILI_APP_KEYS = ["userAgent", "dynamicCron", "healthCheckMinutes"] as const;

/**
 * 核心设置的 `app` 里归 B 站的三格拆出来:回拿掉它们的核心那份、和它们本身(一格都没有就是空对象)。值原样不动 ——
 * 一条解析不了的老 cron 也照搬,B 站那份读盘是宽松的。
 */
export function splitBilibiliSettings(core: unknown): {
	core: unknown;
	bilibili: Record<string, unknown>;
} {
	if (!isPlainObject(core) || !isPlainObject(core.app)) return { core, bilibili: {} };
	const app: Record<string, unknown> = { ...core.app };
	const bilibili: Record<string, unknown> = {};
	for (const key of BILIBILI_APP_KEYS) {
		if (!(key in app)) continue;
		bilibili[key] = app[key];
		delete app[key];
	}
	return { core: { ...core, app }, bilibili };
}

/**
 * 新代里核心的设置文件(`corePath`)迁成最新的形状,B 站的三格拆进 `bilibiliPath`;回改写过的文件(绝对路径)。
 * 核心那份没变就不写 —— 新代里还是搬过来的那个文件;一格 B 站的都没有就不建 B 站那份(配置仓开机时按默认值建)。
 * 读不懂的原样留着,由配置仓开机时报出来。
 */
export async function migrateSettingsFiles(
	corePath: string,
	bilibiliPath: string,
): Promise<string[]> {
	const file = await readJsonFile(corePath);
	if (file.kind !== "ok") return [];
	const { core, bilibili } = splitBilibiliSettings(migrateGlobals(file.value));
	const rewritten: string[] = [];
	if (Object.keys(bilibili).length > 0) {
		await rewriteJsonFile(bilibiliPath, bilibili, corePath);
		rewritten.push(bilibiliPath);
	}
	if (JSON.stringify(core) !== JSON.stringify(file.value)) {
		await rewriteJsonFile(corePath, core);
		rewritten.push(corePath);
	}
	return rewritten;
}
