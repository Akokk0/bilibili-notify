/**
 * 核心设置拆掉 `app`(3a-38 提交 ②):`app.logLevel / logLevels / logRetentionDays / memoryLog` → `logging`,
 * `app.fansCron` → 顶层 `profileRefreshCron`;`logLevels` 的 `dynamic` 与 `live` 并成 `bilibili`。
 *
 * 函数级:搬法、并键取值表逐行、新老并存新键说了算、认不得的形状原样放过、没有要搬的东西回同一个对象。
 * 流水线里的次序(B 站两格要先拆走)由 `zero-generation-settings.test.ts` 与 `settings.test.ts` 钉着。
 */

import { describe, expect, it } from "vite-plus/test";
import { splitAppSettings } from "../core-sections.js";

type Obj = Record<string, unknown>;

describe("splitAppSettings:搬法", () => {
	it("四格 + fansCron 各搬到新位置;memoryLog 布尔变成 { enabled };app 不再有", () => {
		const out = splitAppSettings({
			app: {
				logLevel: "debug",
				logLevels: { core: "warn", image: "error" },
				logRetentionDays: 14,
				memoryLog: true,
				fansCron: "*/5 * * * *",
			},
			master: {},
		}) as Obj;
		expect(out).toEqual({
			logging: {
				level: "debug",
				levels: { core: "warn", image: "error" },
				retentionDays: 14,
				memoryLog: { enabled: true },
			},
			profileRefreshCron: "*/5 * * * *",
			master: {},
		});
		expect("app" in out).toBe(false);
	});

	it("`app` 在原来的位置换成 logging,紧跟着是 profileRefreshCron(键序不乱)", () => {
		const out = splitAppSettings({
			history: {},
			app: { fansCron: "* * * * *" },
			master: {},
		}) as Obj;
		expect(Object.keys(out)).toEqual(["history", "logging", "profileRefreshCron", "master"]);
	});

	it("缺的格不写(留给 schema 补默认);没有 fansCron 就不写 profileRefreshCron", () => {
		const out = splitAppSettings({ app: { logLevel: "warn" } }) as Obj;
		expect(out).toEqual({ logging: { level: "warn" } });
	});

	it("`app` 里别的键(含 B 站两格以外的杂项)丢掉", () => {
		const out = splitAppSettings({ app: { logLevel: "info", stale: 1 } }) as Obj;
		expect(out).toEqual({ logging: { level: "info" } });
	});

	it("memoryLog 为 false 也要搬(不是丢)", () => {
		const out = splitAppSettings({ app: { memoryLog: false } }) as Obj;
		expect(out).toEqual({ logging: { memoryLog: { enabled: false } } });
	});

	it("`app` 是空对象 → logging 是空对象", () => {
		expect(splitAppSettings({ app: {} })).toEqual({ logging: {} });
	});
});

describe("splitAppSettings:logLevels 并键(dynamic、live → bilibili)", () => {
	const merged = (logLevel: string | undefined, levels: Obj): unknown => {
		const out = splitAppSettings({
			app: { ...(logLevel ? { logLevel } : {}), logLevels: levels },
		}) as { logging: { levels: Obj } };
		return out.logging.levels;
	};

	// 与方案 §2.2 那张表一行对一行(全局 × 旧 dynamic × 旧 live → 新 bilibili)。
	it.each([
		{ row: 1, global: "info", levels: {}, expected: {} },
		{
			row: 2,
			global: "info",
			levels: { dynamic: "debug", live: "warn" },
			expected: { bilibili: "debug" },
		},
		{
			row: 2.5,
			global: "info",
			levels: { dynamic: "warn", live: "debug" },
			expected: { bilibili: "debug" },
		},
		{
			row: 3,
			global: "info",
			levels: { dynamic: "warn", live: "warn" },
			expected: { bilibili: "warn" },
		},
		{ row: 4, global: "info", levels: { dynamic: "debug" }, expected: { bilibili: "debug" } },
		{ row: 4.5, global: "info", levels: { live: "debug" }, expected: { bilibili: "debug" } },
		{ row: 5, global: "info", levels: { dynamic: "info" }, expected: { bilibili: "info" } },
		{ row: 6, global: "info", levels: { dynamic: "error" }, expected: {} },
		{ row: 6.5, global: "info", levels: { live: "warn" }, expected: {} },
		// 全局不是 info:没写的那一侧按全局打,比较对象跟着全局走。
		{ row: 7, global: "warn", levels: { live: "info" }, expected: { bilibili: "info" } },
		{ row: 8, global: "debug", levels: { live: "info" }, expected: {} },
		{ row: 9, global: undefined, levels: { dynamic: "debug" }, expected: { bilibili: "debug" } },
	])("第 $row 行:全局 $global + $levels → $expected", ({ global, levels, expected }) => {
		expect(merged(global, levels)).toEqual(expected);
	});

	it("core / image / ai 与别的键原样带过去,dynamic 与 live 拿掉", () => {
		expect(
			merged("info", {
				core: "warn",
				dynamic: "debug",
				live: "debug",
				image: "error",
				ai: "debug",
				x: "warn",
			}),
		).toEqual({ core: "warn", image: "error", ai: "debug", x: "warn", bilibili: "debug" });
	});

	it("值不是四档之一的(手改坏的盘)原样带进 bilibili,先看 dynamic 再看 live", () => {
		expect(merged("info", { dynamic: "loud", live: "debug" })).toEqual({ bilibili: "loud" });
		expect(merged("info", { dynamic: "debug", live: "quiet" })).toEqual({ bilibili: "quiet" });
	});

	it("已经有 bilibili 键(手改过):它说了算,老键照样拿掉", () => {
		expect(merged("info", { bilibili: "error", dynamic: "debug", live: "debug" })).toEqual({
			bilibili: "error",
		});
	});

	it("logLevels 不是对象(手改坏的盘)原样带进 levels,由配置仓开机时报", () => {
		expect(merged("info", "bad" as never)).toBe("bad");
	});
});

describe("splitAppSettings:新老并存、认不得的形状、同一个对象", () => {
	it("新老键并存:已有的新键说了算,老键照样拿掉", () => {
		const out = splitAppSettings({
			app: { logLevel: "debug", logRetentionDays: 30, fansCron: "* * * * *" },
			logging: { level: "error" },
			profileRefreshCron: "*/20 * * * *",
		}) as Obj;
		expect(out).toEqual({
			logging: { level: "error", retentionDays: 30 },
			profileRefreshCron: "*/20 * * * *",
		});
	});

	it.each([
		["不是对象", "x"],
		["null", null],
		["数组", []],
		["undefined", undefined],
	])("raw 是%s:原样回", (_name, raw) => {
		expect(splitAppSettings(raw)).toBe(raw);
	});

	it("`app` 不是普通对象:原样回同一个对象", () => {
		const raw = { app: "oops", master: {} };
		expect(splitAppSettings(raw)).toBe(raw);
	});

	it("没有 app(已经是新形状):回传进来的那个对象", () => {
		const raw = { logging: { level: "info" }, profileRefreshCron: "* * * * *", master: {} };
		expect(splitAppSettings(raw)).toBe(raw);
	});

	it("幂等:迁过一遍再迁,回同一个对象", () => {
		const once = splitAppSettings({ app: { logLevel: "debug" } });
		expect(splitAppSettings(once)).toBe(once);
	});

	it("不改入参", () => {
		const raw = { app: { logLevel: "debug", logLevels: { dynamic: "debug" } } };
		const snapshot = structuredClone(raw);
		splitAppSettings(raw);
		expect(raw).toEqual(snapshot);
	});
});
