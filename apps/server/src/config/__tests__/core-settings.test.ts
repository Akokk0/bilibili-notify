/**
 * 核心设置逐格解析:一格坏了只那一格退默认,别的格照盘上的值;顶层不是对象仍然抛(信封坏)。
 * 只经 `parseCoreSettings` / `withRawSettings` 的入参与返回值断言,不 mock schema。
 */

import { GlobalConfigSchema, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { parseCoreSettings, withRawSettings } from "../core-settings.js";
import { ConfigValidationError } from "../validation-error.js";

// biome-ignore lint/suspicious/noExplicitAny: 夹具按路径随手改盘上 JSON,不值得为它逐层写类型
type Json = Record<string, any>;

/** 一份盘上长相的核心设置(JSON 值),好几格故意取非默认值,断言「别的格是入参里的值」才有分量。 */
function goodDisk(): Json {
	const disk = structuredClone(makeDefaultGlobalConfig()) as Json;
	disk.history = { retentionDays: 30 };
	disk.profileRefreshCron = "*/5 * * * *";
	disk.mutedUntil = 123;
	disk.defaults.filters.blockKeywords = ["广告"];
	disk.defaults.imageGroup = { ...disk.defaults.imageGroup, enabled: false };
	disk.ai.dynamicPrompt = "自己写的提示词";
	disk.ai.activeProfile = "p1";
	disk.ai.providers = { p1: { provider: "openrouter", label: "我的实例", model: "m" } };
	// 过一遍 schema 补齐带默认的子格:这样「别的格是入参里的值」可以直接 toEqual 入参那一格。
	return structuredClone(GlobalConfigSchema.parse(disk)) as Json;
}

describe("parseCoreSettings", () => {
	it("全好的一份:没有坏格,settings 等于它过 GlobalConfigSchema 的结果", () => {
		const disk = goodDisk();
		const { settings, invalid } = parseCoreSettings(disk);
		expect(invalid).toEqual([]);
		expect(settings).toEqual(GlobalConfigSchema.parse(disk));
		expect(settings.history.retentionDays).toBe(30);
		expect(settings.defaults.filters.blockKeywords).toEqual(["广告"]);
	});

	it("顶层格类型错:那一格取默认,别的格是入参里的值,记一条", () => {
		const disk = goodDisk();
		disk.history = "三十天";
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.history).toEqual(makeDefaultGlobalConfig().history);
		expect(settings.profileRefreshCron).toBe("*/5 * * * *");
		expect(settings.mutedUntil).toBe(123);
		expect(settings.ai.providers).toEqual(disk.ai.providers);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["history"]);
		expect(invalid[0]?.raw).toBe("三十天");
		expect(invalid[0]?.missing).toBe(false);
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	it("必填格缺了(logging):取默认,别的格不动,记一条 missing 且 raw 是 undefined", () => {
		const disk = goodDisk();
		delete disk.logging;
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.logging).toEqual(makeDefaultGlobalConfig().logging);
		expect(settings.history.retentionDays).toBe(30);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["logging"]);
		expect(invalid[0]?.missing).toBe(true);
		expect(invalid[0]?.raw).toBeUndefined();
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	it("带默认的格缺了(history):不记条目,按 schema 默认补", () => {
		const disk = goodDisk();
		delete disk.history;
		const { settings, invalid } = parseCoreSettings(disk);
		expect(invalid).toEqual([]);
		expect(settings.history).toEqual(makeDefaultGlobalConfig().history);
		expect(settings.mutedUntil).toBe(123);
	});

	it("越界(history 的保留天数不在七档里):整格退默认,记一条", () => {
		const disk = goodDisk();
		disk.history = { retentionDays: 45 };
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.history).toEqual(makeDefaultGlobalConfig().history);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["history"]);
		expect(invalid[0]?.raw).toEqual({ retentionDays: 45 });
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	it("defaults.filters 坏:只那个子格退默认,defaults 下别的子格是入参里的值", () => {
		const disk = goodDisk();
		disk.defaults.filters = { blockReposts: "是" };
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.defaults.filters).toEqual(makeDefaultGlobalConfig().defaults.filters);
		expect(settings.defaults.imageGroup).toEqual(disk.defaults.imageGroup);
		expect(settings.defaults.imageGroup.enabled).toBe(false);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["defaults", "filters"]);
		expect(invalid[0]?.raw).toEqual({ blockReposts: "是" });
		expect(invalid[0]?.missing).toBe(false);
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	it("ai.providers 里一家的 provider 不认识:providers 整格退默认,ai 下别的子格是入参里的值", () => {
		const disk = goodDisk();
		const bad = { p1: { provider: "没这家" }, p2: { provider: "openrouter" } };
		disk.ai.providers = bad;
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai.providers).toEqual({});
		expect(settings.ai.dynamicPrompt).toBe("自己写的提示词");
		expect(settings.ai.activeProfile).toBe("p1");
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["ai", "providers"]);
		expect(invalid[0]?.raw).toEqual(bad);
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	it("ai 整格是字符串:整格退默认,只记一条 [ai]", () => {
		const disk = goodDisk();
		disk.ai = "关掉";
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai).toEqual(makeDefaultGlobalConfig().ai);
		expect(settings.history.retentionDays).toBe(30);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["ai"]);
		expect(invalid[0]?.raw).toBe("关掉");
	});

	it("defaults 整格是数组:整格退默认,只记一条 [defaults]", () => {
		const disk = goodDisk();
		disk.defaults = [1, 2];
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.defaults).toEqual(makeDefaultGlobalConfig().defaults);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["defaults"]);
		expect(invalid[0]?.raw).toEqual([1, 2]);
	});

	it("子格必填缺了(ai.enabled):记 [ai, enabled] 且 missing,ai 下别的子格不动", () => {
		const disk = goodDisk();
		delete disk.ai.enabled;
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai.enabled).toBe(makeDefaultGlobalConfig().ai.enabled);
		expect(settings.ai.dynamicPrompt).toBe("自己写的提示词");
		expect(invalid.map((e) => [e.path, e.missing])).toEqual([[["ai", "enabled"], true]]);
	});

	it("两格同时坏:两条,次序按 schema 的键序,与入参里的键序无关", () => {
		const disk = goodDisk();
		disk.ai.providers = { p1: { provider: "没这家" } };
		disk.mutedUntil = "很久";
		disk.defaults.filters = 1;
		disk.history = "三十天";
		const { invalid } = parseCoreSettings(disk);
		expect(invalid.map((e) => e.path)).toEqual([
			["history"],
			["defaults", "filters"],
			["ai", "providers"],
			["mutedUntil"],
		]);
	});

	it("templatesSeen 坏:取出厂值(填满的账本),不是 schema 的空表", () => {
		const disk = goodDisk();
		disk.templatesSeen = "账本";
		const { settings, invalid } = parseCoreSettings(disk);
		const factory = makeDefaultGlobalConfig().templatesSeen;
		expect(Object.keys(factory).length).toBeGreaterThan(0);
		expect(settings.templatesSeen).toEqual(factory);
		expect(invalid.map((e) => e.path)).toEqual([["templatesSeen"]]);
	});

	it("入参没有被改写,返回的 settings 与 raw 也不与入参共享引用", () => {
		const disk = goodDisk();
		disk.defaults.filters = { blockReposts: "是", blockKeywords: ["x"] };
		disk.ai.providers = { p1: { provider: "没这家" } };
		const before = JSON.stringify(disk);
		const { settings, invalid } = parseCoreSettings(disk);
		expect(JSON.stringify(disk)).toBe(before);
		const [filtersRaw, providersRaw] = invalid.map((e) => e.raw as Json) as [Json, Json];
		filtersRaw.blockKeywords.push("改");
		providersRaw.p1.provider = "改";
		settings.defaults.imageGroup.enabled = true;
		settings.history.retentionDays = 90;
		expect(JSON.stringify(disk)).toBe(before);
	});

	it.each([
		["数组", []],
		["字符串", "不是对象"],
		["null", null],
	])("顶层不是对象(%s):抛 ConfigValidationError,与整份校验不过同一个错", (_name, raw) => {
		expect(() => parseCoreSettings(raw)).toThrow(ConfigValidationError);
	});
});

describe("withRawSettings", () => {
	/** 三种坏法一起:顶层类型错、子格坏、必填格缺了。 */
	function brokenDisk(): Json {
		const disk = goodDisk();
		disk.history = "三十天";
		disk.defaults.filters = { blockReposts: "是" };
		delete disk.logging;
		return disk;
	}

	it("把条目放回:坏格是原文,缺的键不在,别的格不动", () => {
		const { settings, invalid } = parseCoreSettings(brokenDisk());
		const toWrite = structuredClone(settings) as Json;
		const out = withRawSettings(toWrite, invalid) as Json;
		expect(out.history).toBe("三十天");
		expect(out.defaults.filters).toEqual({ blockReposts: "是" });
		expect(Object.hasOwn(out, "logging")).toBe(false);
		const expected = structuredClone(toWrite);
		expected.history = "三十天";
		expected.defaults.filters = { blockReposts: "是" };
		delete expected.logging;
		expect(out).toEqual(expected);
		expect(out.defaults.imageGroup).toEqual(settings.defaults.imageGroup);
	});

	it("入参(disk 与 entries)没有被改写,放回的原文也不与条目共享引用", () => {
		const { settings, invalid } = parseCoreSettings(brokenDisk());
		const toWrite = structuredClone(settings) as Json;
		const diskBefore = JSON.stringify(toWrite);
		const entriesBefore = JSON.stringify(invalid);
		const out = withRawSettings(toWrite, invalid) as Json;
		expect(JSON.stringify(toWrite)).toBe(diskBefore);
		expect(JSON.stringify(invalid)).toBe(entriesBefore);
		out.defaults.filters.blockReposts = "改";
		expect(JSON.stringify(invalid)).toBe(entriesBefore);
	});

	it("两级路径的父格不是对象:跳过那一条,不抛,别的条目照放", () => {
		const entries = [
			{ path: ["ai", "providers"], issues: [], raw: { x: 1 }, missing: false },
			{ path: ["history"], issues: [], raw: "原文", missing: false },
		];
		const disk = { ai: "不是对象", history: { retentionDays: 7 } };
		const out = withRawSettings(disk, entries);
		expect(out).toEqual({ ai: "不是对象", history: "原文" });
	});

	it("来回稳定:放回后再解析,settings 与 invalid 都和第一次一样", () => {
		const bad = goodDisk();
		bad.defaults.filters = { blockReposts: "是" };
		bad.ai.providers = { p1: { provider: "没这家" } };
		const first = parseCoreSettings(bad);
		expect(first.invalid.map((e) => e.path)).toEqual([
			["defaults", "filters"],
			["ai", "providers"],
		]);
		const second = parseCoreSettings(withRawSettings(first.settings, first.invalid));
		expect(second.settings).toEqual(first.settings);
		expect(second.invalid).toEqual(first.invalid);
	});
});
