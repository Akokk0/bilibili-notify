/**
 * 核心的设置(0.x 的 `state/globals.json`,新代里在 `config/settings/core.json`):0.x 各个版本留下的形状 → 0.x
 * 最新的形状。一项一项收进来(⑥c),配置仓开机只认最新的形状。
 *
 * - `defaults.features`:附加项的两代老数据({@link migrateLegacyFeatureFlags});
 * - `defaults.ai`:扁平连接字段、「一家一桶」、手改的人格({@link migrateAiSettings});
 * - `defaults.templates`:历代旧默认原文({@link migrateOldTemplateDefaults});
 * - `linkParsing`:0.9.1 的「范围 + 白名单」({@link migrateLegacyLinkParsing})。
 *
 * 这几项产出的是 **0.x 最新**的形状(特性键、文案键、版式键仍是 0.x 的名字);1.0 的改名是它们之后的另一步
 * ({@link renameGlobalSettingsKeys},在 {@link migrateSettingsFiles} 里串着跑),直播拆键({@link splitGlobalLiveSettings},
 * `live-split.ts`)又在改名之后。
 *
 * 卡片样式那两个退役键(`hideDesc` / `hideFollower`)不用管:schema 不是 strict,读的时候自己剥掉。
 *
 * 设置按集成分文件(ADR-0021 决策 42 下 10-01 的 🔗):`app` 里 B 站的两格(`dynamicCron` / `healthCheckMinutes`)搬进
 * `config/settings/bilibili.json`,只挪位置、不改键名;第三格 `userAgent` **丢掉**(浏览器身份一律由 `packages/http` 生成,
 * UA 与 `sec-ch-ua` 永远配套,ADR-0025 决策 7)({@link splitBilibiliSettings});各拓展的 `settings` 搬进
 * `config/settings/extensions/<id>.json`,开关留在核心那份({@link splitExtensionSettings})。
 */

import { ExtensionIdSchema } from "@bilibili-notify/internal";
import { migrateAiSettings } from "./ai.js";
import { renameGlobalSettingsKeys } from "./feature-renames.js";
import { migrateLegacyFeatureFlags } from "./features.js";
import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";
import { migrateLegacyLinkParsing } from "./link-parsing.js";
import { type GlobalLiveFacts, liveFactsOf, splitGlobalLiveSettings } from "./live-split.js";
import { migrateOldTemplateDefaults } from "./templates.js";

/**
 * 整份全局设置的 raw → raw:0.x 各个版本留下的形状 → 0.x 最新的形状。认不得的形状原样放过,由配置仓开机时报出来。
 * 不含 1.0 的改名(见文件头)。
 */
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
 * 整份全局设置的 raw → raw:0.x 各个版本留下的形状 → 0.x 最新的形状 → 1.0 的改名 → 直播拆键。设置那一步
 * ({@link migrateSettingsFiles})和订阅那一步要的「全局值」({@link readZeroLiveFacts})都从这一条流水过,拆键前后的
 * 全局值只有一个读法。
 */
export function migrateGlobalsToCurrent(raw: unknown): unknown {
	return splitGlobalLiveSettings(renameGlobalSettingsKeys(migrateGlobals(raw)));
}

/**
 * 第 0 代的全局设置(`state/globals.json`)里直播拆键要的两样 —— 开播开关与 `pushTime`。订阅那一步用它算每条订阅的
 * 周期开关(见 `live-split.ts` 文件头:设置那一步已经把 `pushTime` 折成间隔,反推不出)。文件不在、读不懂、形状不对一律回
 * `fallback`(0.12 的出厂值):配置仓开机时自己会报设置的问题,订阅别跟着停。
 */
export async function readZeroLiveFacts(
	zeroGlobalsPath: string,
	fallback: GlobalLiveFacts,
): Promise<GlobalLiveFacts> {
	const file = await readJsonFile(zeroGlobalsPath);
	if (file.kind !== "ok") return fallback;
	// 只要拆键之前那一刻的值:走到改名为止、不做拆键。
	return liveFactsOf(renameGlobalSettingsKeys(migrateGlobals(file.value))) ?? fallback;
}

/** 核心设置的 `app` 里归 B 站的两格。 */
const BILIBILI_APP_KEYS = ["dynamicCron", "healthCheckMinutes"] as const;

/** 核心设置的 `app` 里 1.0 不要的 B 站那一格:自定义 UA。从核心那份拿掉,哪儿也不搬。 */
const DROPPED_APP_KEYS = ["userAgent"] as const;

/**
 * 核心设置的 `app` 里归 B 站的两格拆出来:回拿掉它们的核心那份、和它们本身(一格都没有就是空对象)。值原样不动 ——
 * 一条解析不了的老 cron 也照搬,B 站那份读盘是宽松的。`userAgent` 一并从核心那份拿掉、不进 B 站那份:
 * 它是 0.x 的自定义 UA,1.0 的身份只有一处来源。
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
	for (const key of DROPPED_APP_KEYS) delete app[key];
	return { core: { ...core, app }, bilibili };
}

/**
 * 核心设置里各拓展的 `settings` 拆出来:回只剩开关的核心那份、和各拓展的设置(按 id)。拓展 id 不合 id 的形状的
 * (手改过的配置)不拆 —— 它要拼进文件名;那一格原样留在核心那份里,配置仓读的时候剥掉。
 */
export function splitExtensionSettings(core: unknown): {
	core: unknown;
	extensions: Map<string, unknown>;
} {
	const extensions = new Map<string, unknown>();
	if (!isPlainObject(core) || !isPlainObject(core.extensions)) return { core, extensions };
	const table: Record<string, unknown> = {};
	for (const [id, entry] of Object.entries(core.extensions)) {
		if (
			!isPlainObject(entry) ||
			!("settings" in entry) ||
			!ExtensionIdSchema.safeParse(id).success
		) {
			table[id] = entry;
			continue;
		}
		const { settings, ...rest } = entry;
		table[id] = rest;
		if (settings !== undefined) extensions.set(id, settings);
	}
	return { core: { ...core, extensions: table }, extensions };
}

/**
 * 新代里核心的设置文件迁成最新的形状,B 站的两格与各拓展的设置拆进各自的文件;回改写过的文件(绝对路径)。核心那份
 * 没变就不写 —— 新代里还是搬过来的那个文件;一格 B 站的都没有就不建 B 站那份(配置仓开机时按默认值建)。读不懂的
 * 原样留着,由配置仓开机时报出来。
 */

/** 迁移写到的几份设置文件(绝对路径)。 */
export interface SettingsFilePaths {
	core: string;
	bilibili: string;
	/** 一个拓展的设置文件。 */
	extension(id: string): string;
}

export async function migrateSettingsFiles(paths: SettingsFilePaths): Promise<string[]> {
	const corePath = paths.core;
	const file = await readJsonFile(corePath);
	if (file.kind !== "ok") return [];
	const bilibiliSplit = splitBilibiliSettings(migrateGlobalsToCurrent(file.value));
	const { core, extensions } = splitExtensionSettings(bilibiliSplit.core);
	const rewritten: string[] = [];
	if (Object.keys(bilibiliSplit.bilibili).length > 0) {
		await rewriteJsonFile(paths.bilibili, bilibiliSplit.bilibili, corePath);
		rewritten.push(paths.bilibili);
	}
	for (const [id, settings] of extensions) {
		const path = paths.extension(id);
		await rewriteJsonFile(path, settings, corePath);
		rewritten.push(path);
	}
	if (JSON.stringify(core) !== JSON.stringify(file.value)) {
		await rewriteJsonFile(corePath, core);
		rewritten.push(corePath);
	}
	return rewritten;
}
