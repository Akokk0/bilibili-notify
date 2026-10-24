/**
 * 核心的设置(0.x 的 `state/globals.json`,新代里在 `config/settings/core.json`):0.x 各个版本留下的形状 → 0.x
 * 最新的形状。一项一项收进来(⑥c),配置仓开机只认最新的形状。
 *
 * - `defaults.features`:附加项的两代老数据({@link migrateLegacyFeatureFlags});
 * - 0.x 的 `defaults.ai`:扁平连接字段、「一家一桶」、手改的人格({@link migrateAiSettings});
 * - `defaults.templates`:历代旧默认原文({@link migrateOldTemplateDefaults});
 * - `linkParsing`:0.9.1 的「范围 + 白名单」({@link migrateLegacyLinkParsing});它之后的 1.0 改名另有一步
 *   ({@link renameLinkParsing}:成 `linkPreview` 五格)。
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
 *
 * `app` 剩下的格(日志的四格、粉丝轮询的 cron)最后由 `core-sections.ts` 的 `splitAppSettings` 拆进 `logging` 与顶层
 * `profileRefreshCron`,所以 B 站那两格必须先拆走(见 {@link migrateSettingsFiles})。
 */

import {
	DEFAULT_HISTORY_RETENTION_DAYS,
	ExtensionIdSchema,
	HISTORY_RETENTION_DAY_OPTIONS,
	type HistoryRetentionDays,
	HistorySettingsSchema,
	isPrivateTarget,
	type PushTarget,
} from "@bilibili-notify/internal";
import { migrateAiSettings, removeZeroBuiltinPresets } from "./ai.js";
import { moveGlobalCards } from "./card-moves.js";
import { moveGlobalAi, moveTemplateLedger, splitAppSettings } from "./core-sections.js";
import { renameGlobalSettingsKeys } from "./feature-renames.js";
import { migrateLegacyFeatureFlags } from "./features.js";
import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";
import { migrateLegacyLinkParsing, renameLinkParsing } from "./link-parsing.js";
import { rewriteGlobalLivePlaceholders } from "./live-placeholders.js";
import { type GlobalLiveFacts, liveFactsOf, splitGlobalLiveSettings } from "./live-split.js";
import { moveGlobalMembership } from "./membership-moves.js";
import { migrateOldTemplateDefaults } from "./templates.js";
import { removeUnchangedGlobalTexts } from "./unchanged-texts.js";

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
 * 整份全局设置的 raw → raw:0.x 各个版本留下的形状 → 0.x 最新的形状 → 1.0 的改名 → 链接设置 `linkParsing` 成 `linkPreview`
 * 五格({@link renameLinkParsing},`link-parsing.ts`) → 会员与醒目留言的搬家(两个直播阈值、
 * 上舰文案,㉓d,`membership-moves.ts`) → 卡片设置搬家与老皮肤指针回默认(㉔e,`card-moves.ts`) → 直播拆键 → 其余六条直播文案的占位符改写
 * (3b-21,`live-placeholders.ts`;账本还在老位置) → 历史保留天数换键
 * → 拆掉 `app`(日志的格进 `logging`、粉丝轮询的 cron 成顶层 `profileRefreshCron`,3a-38,`core-sections.ts`)→ 默认文案账本
 * 上提到顶层 `templatesSeen`(同文件;前面改写账本的几步看的还是老位置)→ 没改过的文字与会员默认删键、修剪账本,
 * 并写 `locale: "zh-CN"`(`unchanged-texts.ts`)→ AI 设置上提到顶层 `ai`(同文件;更早的
 * `migrateAiSettings` 改写的是老位置 `defaults.ai`)→ 拆出内置人格、顶层人格三格删掉、只记删过哪几份
 * (`ai.ts`)。设置那一步
 * ({@link migrateSettingsFiles})和订阅那一步要的「全局值」({@link readZeroLiveFacts})都从这一条流水过,拆键前后的全局值只有一个读法。
 *
 * ⚠️ 对 B 站那两格(`app.dynamicCron` / `healthCheckMinutes`)**有损**:最后一步把剩下的 `app` 整个吃掉,没先拆走的就没了。
 * 它们必须先经 {@link splitBilibiliSettings} 拆走 —— 生产路径只有 {@link migrateSettingsFiles} 一处,那里排好了次序。
 */
export function migrateGlobalsToCurrent(raw: unknown): unknown {
	const presetsWereEmpty = zeroAiPresetsWereEmpty(raw);
	return removeZeroBuiltinPresets(
		moveGlobalAi(
			removeUnchangedGlobalTexts(
				moveTemplateLedger(
					splitAppSettings(
						moveHistoryRetention(
							rewriteGlobalLivePlaceholders(
								splitGlobalLiveSettings(
									moveGlobalCards(
										moveGlobalMembership(
											renameLinkParsing(renameGlobalSettingsKeys(migrateGlobals(raw))),
										),
									),
								),
							),
						),
					),
				),
			),
		),
		presetsWereEmpty,
	);
}

/** 人格指针迁移之前,0.x 的清单是不是空数组 —— 新步骤靠它区分「四份都在」与「四份都删了」。 */
function zeroAiPresetsWereEmpty(raw: unknown): boolean {
	if (!isPlainObject(raw)) return false;
	const ai = isPlainObject(raw.ai)
		? raw.ai
		: isPlainObject(raw.defaults) && isPlainObject(raw.defaults.ai)
			? raw.defaults.ai
			: undefined;
	return ai !== undefined && Array.isArray(ai.presets) && ai.presets.length === 0;
}

/** 七档从短到长,换算时往上找最近的一档。 */
const RETENTION_STEPS_ASC = [...HISTORY_RETENTION_DAY_OPTIONS].sort((a, b) => a - b);
const LONGEST_RETENTION_DAYS = Math.max(...HISTORY_RETENTION_DAY_OPTIONS) as HistoryRetentionDays;

/**
 * 0.x 的历史保留天数(1–365 的任意整数)换成七档:不在选项里的往上取最近一档,超过最长一档的压成最长一档;
 * 缺了、读不懂的按 0.x 的默认。
 */
function toHistoryRetentionDays(old: unknown): HistoryRetentionDays {
	if (typeof old !== "number" || !Number.isFinite(old) || old < 1) {
		return DEFAULT_HISTORY_RETENTION_DAYS;
	}
	return RETENTION_STEPS_ASC.find((step) => step >= old) ?? LONGEST_RETENTION_DAYS;
}

/**
 * 新代里迁好的核心设置上的保留天数,给迁移里那次历史清扫用。文件不在(0.x 没写过设置)、读不懂、
 * 那一格不合法,都按默认 —— 和配置仓开机时补默认是同一个结果。
 */
export async function readMigratedRetentionDays(corePath: string): Promise<HistoryRetentionDays> {
	const file = await readJsonFile(corePath);
	const history = file.kind === "ok" && isPlainObject(file.value) ? file.value.history : undefined;
	return (
		HistorySettingsSchema.safeParse(history ?? {}).data?.retentionDays ??
		DEFAULT_HISTORY_RETENTION_DAYS
	);
}

/**
 * 历史保留天数换键(ADR-0022 决策 9 下 10-04 的 🔗):`app.historyRetentionDays` → 顶层 `history.retentionDays`,
 * 值换算成七档。老键从 `app` 里拿掉,`app` 里别的格不动。已经是新形状的(有 `history.retentionDays`、`app` 里
 * 没有老键)原样回同一个对象;认不得的形状原样放过。
 */
export function moveHistoryRetention(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const app = isPlainObject(raw.app) ? raw.app : undefined;
	const history = isPlainObject(raw.history) ? raw.history : undefined;
	const hasOldKey = app !== undefined && "historyRetentionDays" in app;
	const hasNewKey = history !== undefined && "retentionDays" in history;
	if (!hasOldKey && hasNewKey) return raw;
	const { historyRetentionDays: old, ...restOfApp } = app ?? {};
	return {
		...raw,
		...(app ? { app: restOfApp } : {}),
		// 两把键都在(手改过的设置):新键说了算,老键照样拿掉。
		history: hasNewKey ? history : { ...history, retentionDays: toHistoryRetentionDays(old) },
	};
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
	// B 站那两格要最先拆走:`migrateGlobalsToCurrent` 末尾会把剩下的 `app` 整个吃掉(`core-sections.ts`)。
	const bilibiliSplit = splitBilibiliSettings(file.value);
	const { core, extensions } = splitExtensionSettings(migrateGlobalsToCurrent(bilibiliSplit.core));
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

/**
 * 主人目标只许指向私聊目标(ADR-0021 决策 57):核心设置里的 `master.targetId` 指向的目标不在目标表里、
 * 或不是私聊会话,就把那一格清空;回「清没清」。
 *
 * 设置与目标是两份文件,所以这一步在「连接与目标」「设置」两步之后单独做,两边都读新代里迁好的那一份。
 * 目标表不在(0.x 没配过)按空表算;读不懂的(不是 JSON、不是数组)不动 —— 那种盘配置仓开机时会报出来。
 * 目标按 `kind` / `scope` 两格判,条目的其余形状这里不关心。
 */
export async function clearMasterTargetUnlessPrivate(paths: {
	core: string;
	targets: string;
}): Promise<boolean> {
	const core = await readJsonFile(paths.core);
	if (core.kind !== "ok" || !isPlainObject(core.value) || !isPlainObject(core.value.master)) {
		return false;
	}
	const master = core.value.master;
	if (master.targetId === undefined) return false;
	const targets = await readJsonFile(paths.targets);
	if (targets.kind === "unreadable") return false;
	if (targets.kind === "ok" && !Array.isArray(targets.value)) return false;
	const entries = targets.kind === "ok" ? (targets.value as unknown[]) : [];
	const target = entries.find((entry) => isPlainObject(entry) && entry.id === master.targetId);
	if (isPrivateTarget(target as PushTarget | undefined)) return false;
	const { targetId: _cleared, ...rest } = master;
	await rewriteJsonFile(paths.core, { ...core.value, master: rest });
	return true;
}
