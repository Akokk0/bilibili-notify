/**
 * 核心设置里的 `logging` 一段与顶层 `profileRefreshCron`(3a-38 提交 ②:拆掉原来的 `app`)。
 *
 * 钉:四格的默认与范围逐格同今天的 `app.*`;`levels` 是开放键(原型名被拒);
 * `app` 这个键不再存在、顶层写 `app` 被剥掉不抛;`defaults` 里没有人在读的老格不再认。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_PROFILE_REFRESH_CRON,
	GlobalSettingsSchema,
	LoggingSettingsSchema,
	makeDefaultGlobalSettings,
} from "../globals";

describe("LoggingSettingsSchema", () => {
	it("什么都不写 → 默认:info、没有按模块覆盖、留 7 天、内存自检关", () => {
		expect(LoggingSettingsSchema.parse({})).toEqual({
			level: "info",
			levels: {},
			retentionDays: 7,
			memoryLog: { enabled: false },
		});
	});

	it("level 只认四档", () => {
		expect(LoggingSettingsSchema.safeParse({ level: "trace" }).success).toBe(false);
		expect(LoggingSettingsSchema.parse({ level: "debug" }).level).toBe("debug");
	});

	it.each([0, 366, 1.5])("retentionDays 越界或非整数 %s 被拒", (days) => {
		expect(LoggingSettingsSchema.safeParse({ retentionDays: days }).success).toBe(false);
	});

	it.each([1, 365])("retentionDays 边界 %s 通过", (days) => {
		expect(LoggingSettingsSchema.parse({ retentionDays: days }).retentionDays).toBe(days);
	});

	it("levels 是开放键:核心模块与集成键都收,值只认四档", () => {
		const parsed = LoggingSettingsSchema.parse({
			levels: { core: "warn", bilibili: "debug", "some-extension": "error" },
		});
		expect(parsed.levels).toEqual({ core: "warn", bilibili: "debug", "some-extension": "error" });
		expect(LoggingSettingsSchema.safeParse({ levels: { core: "loud" } }).success).toBe(false);
	});

	it("levels 的键是原型名 → 整份 logging 被拒(不是悄悄丢键)", () => {
		const result = LoggingSettingsSchema.safeParse({ levels: { constructor: "debug" } });
		expect(result.success).toBe(false);
	});

	it("levels 的键是空串 → 被拒", () => {
		expect(LoggingSettingsSchema.safeParse({ levels: { "": "debug" } }).success).toBe(false);
	});

	it("memoryLog 是一个对象,里面一格 enabled", () => {
		expect(LoggingSettingsSchema.parse({ memoryLog: { enabled: true } }).memoryLog).toEqual({
			enabled: true,
		});
		expect(LoggingSettingsSchema.safeParse({ memoryLog: true }).success).toBe(false);
	});
});

describe("核心设置的顶层形状", () => {
	it("全新安装:logging 与 profileRefreshCron 是出厂值,没有 app", () => {
		const g = makeDefaultGlobalSettings();
		expect(g.logging).toEqual({
			level: "info",
			levels: {},
			retentionDays: 7,
			memoryLog: { enabled: false },
		});
		expect(g.profileRefreshCron).toBe(DEFAULT_PROFILE_REFRESH_CRON);
		expect(DEFAULT_PROFILE_REFRESH_CRON).toBe("*/10 * * * *");
		expect("app" in g).toBe(false);
	});

	it("缺 profileRefreshCron 的盘补默认;缺 logging 照旧抛(与原来的 app 同一个松紧)", () => {
		const g = makeDefaultGlobalSettings() as unknown as Record<string, unknown>;
		delete g.profileRefreshCron;
		expect(GlobalSettingsSchema.parse(g).profileRefreshCron).toBe(DEFAULT_PROFILE_REFRESH_CRON);
		delete g.logging;
		expect(GlobalSettingsSchema.safeParse(g).success).toBe(false);
	});

	it("顶层写 app 被剥掉、不抛", () => {
		const g = { ...makeDefaultGlobalSettings(), app: { logLevel: "debug" } };
		const parsed = GlobalSettingsSchema.parse(g);
		expect("app" in parsed).toBe(false);
		expect(parsed.logging.level).toBe("info");
	});

	it("profileRefreshCron 保留任意字符串(语法不在 schema 里校验)", () => {
		const g = { ...makeDefaultGlobalSettings(), profileRefreshCron: "not a cron" };
		expect(GlobalSettingsSchema.parse(g).profileRefreshCron).toBe("not a cron");
	});
});
