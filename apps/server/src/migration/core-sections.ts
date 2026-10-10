/**
 * 核心设置拆成几段(3a-38):`app` 这个杂物抽屉拆掉,每一格各回各的家。
 *
 * - {@link splitAppSettings}(提交 ②):`app.logLevel / logLevels / logRetentionDays / memoryLog` → `logging`,
 *   `app.fansCron` → 顶层 `profileRefreshCron`;`logLevels` 里 `dynamic` 与 `live` 两个键并成 `bilibili`。
 *
 * - {@link moveTemplateLedger}(提交 ③):`defaults.templateDefaultsSeen` → 顶层 `templatesSeen`。
 *
 * - {@link moveGlobalAi}(提交 ④):`defaults.ai` → 顶层 `ai`,里面的键一个不动。
 *
 * 同 `live-split.ts` / `card-moves.ts` 的规矩:raw → raw,认不得的形状原样放过(由配置仓开机时报出来),
 * 没有要搬的东西回传进来的那个对象。接在 `migrateGlobalsToCurrent` 的末尾 —— **B 站那两格要先经
 * `splitBilibiliSettings` 拆走**(见 `settings.ts`),这里把剩下的 `app` 整个吃掉。
 */

import { isPlainObject } from "./files.js";

/** 日志等级从啰嗦到安静的次序,并键时取更啰嗦的那个。 */
const VERBOSITY: Readonly<Record<string, number>> = { debug: 3, info: 2, warn: 1, error: 0 };

/** 全局没写等级时的出厂值(同 `LoggingSettingsSchema.level` 的默认)。 */
const FALLBACK_LEVEL = "info";

/** 一个四档之一的等级有多啰嗦(数大的更啰嗦)。 */
function verbosity(level: string): number {
	return VERBOSITY[level] ?? 0;
}

/** 写了的那个等级是不是四档之一。 */
function isKnownLevel(value: unknown): value is string {
	return typeof value === "string" && Object.hasOwn(VERBOSITY, value);
}

/**
 * 旧 `dynamic` / `live` 两个键并成 `bilibili` 该写什么;`undefined` = 不写(跟全局)。两个旧键各自「没写 = 跟全局」,
 * 所以按**生效值**并、取更啰嗦的(等级是排障用的,并键不该把谁调高过的日志悄悄关掉):
 * - 两个都写了:取更啰嗦的;
 * - 只写了一个:没写的那一侧按全局打,写了的那个不比全局啰嗦就不写(不能把没写的那一侧压低)。
 * 值不是四档之一的(手改坏的盘)原样带进 `bilibili`,先看 `dynamic` 再看 `live`,由配置仓开机时报出来。
 */
function mergeBilibiliLevel(dynamic: unknown, live: unknown, globalLevel: unknown): unknown {
	const written = [dynamic, live].filter((value) => value !== undefined);
	if (written.length === 0) return undefined;
	const unknown = written.find((value) => !isKnownLevel(value));
	if (unknown !== undefined) return unknown;
	const effectiveGlobal = isKnownLevel(globalLevel) ? globalLevel : FALLBACK_LEVEL;
	const [first, second] = written as [string, string?];
	if (second !== undefined) return verbosity(second) > verbosity(first) ? second : first;
	return verbosity(first) >= verbosity(effectiveGlobal) ? first : undefined;
}

/** `app.logLevels` → `logging.levels`:`dynamic` / `live` 并成 `bilibili`,别的键原样带过去。 */
function mergeLogLevels(levels: unknown, globalLevel: unknown): unknown {
	if (!isPlainObject(levels)) return levels;
	const { dynamic, live, ...rest } = levels;
	// 已经有 bilibili 键(手改过的盘):它说了算,老键照样拿掉。
	if ("bilibili" in rest) return rest;
	const bilibili = mergeBilibiliLevel(dynamic, live, globalLevel);
	return bilibili === undefined ? rest : { ...rest, bilibili };
}

/**
 * 默认文案账本上提(提交 ③):`defaults.templateDefaultsSeen` → 顶层 `templatesSeen`(紧跟在 `defaults` 后面)。
 * 老键从 `defaults` 里拿掉,`defaults` 里别的格不动;顶层已经有 `templatesSeen`(手改过的盘)就用顶层的、老键照样拿掉。
 * 老账本不是对象也原样带上去,由配置仓开机时报出来。`defaults` 不是普通对象、或里面没有老键:原样回同一个对象。
 *
 * 上游两步 —— `membership-moves.ts` 与 `feature-renames.ts` —— 改写的是老位置上的账本,所以流水线里这一步必须排在它们之后。
 */
export function moveTemplateLedger(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.defaults)) return raw;
	if (!Object.hasOwn(raw.defaults, "templateDefaultsSeen")) return raw;
	const { templateDefaultsSeen: oldLedger, ...restOfDefaults } = raw.defaults;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "templatesSeen") continue;
		if (key !== "defaults") {
			out[key] = value;
			continue;
		}
		out.defaults = restOfDefaults;
		out.templatesSeen = Object.hasOwn(raw, "templatesSeen") ? raw.templatesSeen : oldLedger;
	}
	return out;
}

/**
 * AI 设置上提(提交 ④):`defaults.ai` → 顶层 `ai`(有顶层 `templatesSeen` 就紧跟在它后面,没有就紧跟 `defaults`)。
 * 里面的键一个不动。老键从 `defaults` 里拿掉,`defaults` 里别的格不动;顶层已经有 `ai`(手改过的盘)就用顶层的、老键照样拿掉。
 * 老 `ai` 不是对象也原样带上去,由配置仓开机时报出来。`defaults` 不是普通对象、或里面没有老键:原样回同一个对象。
 *
 * 0.x 老形状的 AI 设置(扁平连接字段、「一家一桶」)由更早的 `migration/ai.ts` 在老位置上改写好,所以这一步排在流水线最后。
 */
export function moveGlobalAi(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.defaults)) return raw;
	if (!Object.hasOwn(raw.defaults, "ai")) return raw;
	const { ai: oldAi, ...restOfDefaults } = raw.defaults;
	const anchor = Object.hasOwn(raw, "templatesSeen") ? "templatesSeen" : "defaults";
	const ai = Object.hasOwn(raw, "ai") ? raw.ai : oldAi;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "ai") continue;
		out[key] = key === "defaults" ? restOfDefaults : value;
		if (key === anchor) out.ai = ai;
	}
	return out;
}

/** `app` 里归 `logging` 的几格(缺的不写,留给 schema 补默认)。 */
function loggingFromApp(app: Record<string, unknown>): Record<string, unknown> {
	const logging: Record<string, unknown> = {};
	if ("logLevel" in app) logging.level = app.logLevel;
	if ("logLevels" in app) logging.levels = mergeLogLevels(app.logLevels, app.logLevel);
	if ("logRetentionDays" in app) logging.retentionDays = app.logRetentionDays;
	if ("memoryLog" in app) logging.memoryLog = { enabled: app.memoryLog };
	return logging;
}

/**
 * 核心设置的 `app` 拆开:见文件头。`app` 在原来的位置换成 `logging`,接着是 `profileRefreshCron`(有 `fansCron` 才写);
 * `app` 里别的键丢掉(今天它们也是读盘时被剥掉、下次写盘时消失)。新老并存(手改过的盘同时有 `app` 与 `logging` /
 * `profileRefreshCron`)时已有的新键说了算,老键照样拿掉。`app` 不是普通对象、或根本没有 `app`:原样回同一个对象。
 */
export function splitAppSettings(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.app)) return raw;
	const app = raw.app;
	const existing = isPlainObject(raw.logging) ? raw.logging : {};
	const logging = { ...loggingFromApp(app), ...existing };
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "logging" || key === "profileRefreshCron") continue;
		if (key !== "app") {
			out[key] = value;
			continue;
		}
		out.logging = logging;
		if ("profileRefreshCron" in raw) out.profileRefreshCron = raw.profileRefreshCron;
		else if ("fansCron" in app) out.profileRefreshCron = app.fansCron;
	}
	return out;
}
