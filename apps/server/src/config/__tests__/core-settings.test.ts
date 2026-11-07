/**
 * 核心设置逐格解析:一格坏了只那一格退默认,别的格照盘上的值;顶层不是对象仍然抛(信封坏)。
 * 只经 `parseCoreSettings` / `withRawSettings` 的入参与返回值断言,不 mock schema。
 */

import { GlobalSettingsSchema, makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { instanceIdOfEntry, parseCoreSettings, withRawSettings } from "../core-settings.js";
import { ConfigValidationError } from "../validation-error.js";

// biome-ignore lint/suspicious/noExplicitAny: 夹具按路径随手改盘上 JSON,不值得为它逐层写类型
type Json = Record<string, any>;

/** 一份盘上长相的核心设置(JSON 值),好几格故意取非默认值,断言「别的格是入参里的值」才有分量。 */
function goodDisk(): Json {
	const disk = structuredClone(makeDefaultGlobalSettings()) as Json;
	disk.history = { retentionDays: 30 };
	disk.profileRefreshCron = "*/5 * * * *";
	disk.mutedUntil = 123;
	disk.defaults.filters.blockKeywords = ["广告"];
	disk.defaults.imageGroup = { ...disk.defaults.imageGroup, enabled: false };
	disk.ai.activePreset = "analyst";
	disk.ai.activeProfile = "p1";
	disk.ai.providers = { p1: { provider: "openrouter", label: "我的实例", model: "m" } };
	// 过一遍 schema 补齐带默认的子格:这样「别的格是入参里的值」可以直接 toEqual 入参那一格。
	return structuredClone(GlobalSettingsSchema.parse(disk)) as Json;
}

describe("parseCoreSettings", () => {
	it("全好的一份:没有坏格,settings 等于它过 GlobalSettingsSchema 的结果", () => {
		const disk = goodDisk();
		const { settings, invalid } = parseCoreSettings(disk);
		expect(invalid).toEqual([]);
		expect(settings).toEqual(GlobalSettingsSchema.parse(disk));
		expect(settings.history.retentionDays).toBe(30);
		expect(settings.defaults.filters.blockKeywords).toEqual(["广告"]);
	});

	it("顶层格类型错:那一格取默认,别的格是入参里的值,记一条", () => {
		const disk = goodDisk();
		disk.history = "三十天";
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.history).toEqual(makeDefaultGlobalSettings().history);
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
		expect(settings.logging).toEqual(makeDefaultGlobalSettings().logging);
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
		expect(settings.history).toEqual(makeDefaultGlobalSettings().history);
		expect(settings.mutedUntil).toBe(123);
	});

	it("越界(history 的保留天数不在七档里):整格退默认,记一条", () => {
		const disk = goodDisk();
		disk.history = { retentionDays: 45 };
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.history).toEqual(makeDefaultGlobalSettings().history);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["history"]);
		expect(invalid[0]?.raw).toEqual({ retentionDays: 45 });
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	it("timezone 坏(Mars/Base):那一格退默认 Asia/Shanghai,记一条,原文留着", () => {
		const disk = goodDisk();
		disk.timezone = "Mars/Base";
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.timezone).toBe("Asia/Shanghai");
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["timezone"]);
		expect(invalid[0]?.raw).toBe("Mars/Base");
		expect(invalid[0]?.missing).toBe(false);
		expect((withRawSettings(settings, invalid) as Json).timezone).toBe("Mars/Base");
	});

	it("defaults.filters 坏:只那个子格退默认,defaults 下别的子格是入参里的值", () => {
		const disk = goodDisk();
		disk.defaults.filters = { blockReposts: "是" };
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.defaults.filters).toEqual(makeDefaultGlobalSettings().defaults.filters);
		expect(settings.defaults.imageGroup).toEqual(disk.defaults.imageGroup);
		expect(settings.defaults.imageGroup.enabled).toBe(false);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["defaults", "filters"]);
		expect(invalid[0]?.raw).toEqual({ blockReposts: "是" });
		expect(invalid[0]?.missing).toBe(false);
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	// N1:ai.providers 里一家坏只那一家不在,别家是盘上的值,条目落在三段路径上。
	it("ai.providers 里一家的字段类型错:只那一家不在表里,另两家是入参里的值,ai 下别的子格不动", () => {
		const disk = goodDisk();
		disk.ai.providers = {
			a: { provider: "openrouter", model: "ma" },
			b: { provider: "deepseek", model: 7 },
			c: { provider: "deepseek", model: "mc", label: "第三家" },
		};
		const rawB = structuredClone(disk.ai.providers.b);
		const { settings, invalid } = parseCoreSettings(disk);
		expect(Object.keys(settings.ai.providers)).toEqual(["a", "c"]);
		const expectedA = GlobalSettingsSchema.shape.ai.shape.providers.parse({
			a: disk.ai.providers.a,
		}).a;
		expect(settings.ai.providers.a).toEqual(expectedA);
		expect(settings.ai.providers.c?.label).toBe("第三家");
		expect(settings.ai.activePreset).toBe("analyst");
		expect(settings.ai.activeProfile).toBe("p1");
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["ai", "providers", "b"]);
		expect(invalid[0]?.raw).toEqual(rawB);
		expect(invalid[0]?.missing).toBe(false);
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
		// 内存里的核心设置永远过得了 schema。
		expect(GlobalSettingsSchema.safeParse(settings).success).toBe(true);
	});

	// ADR-0032:ai.writing 写坏只隔离这一格,内存里是默认(两份开、无例外),ai 别的子格照盘上的值。
	it("ai.writing 写坏:只隔离 [ai, writing] 这一格退默认,ai 别的子格照盘上的值", () => {
		const disk = goodDisk();
		disk.ai.writing = { post: { isOnByDefault: "不是布尔" } };
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai.writing).toEqual({
			post: { isOnByDefault: true, byTarget: {} },
			liveSummary: { isOnByDefault: true, byTarget: {} },
		});
		expect(settings.ai.activePreset).toBe("analyst");
		expect(settings.ai.activeProfile).toBe("p1");
		expect(settings.ai.providers).toEqual(disk.ai.providers);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["ai", "writing"]);
		expect(invalid[0]?.raw).toEqual({ post: { isOnByDefault: "不是布尔" } });
		expect(GlobalSettingsSchema.safeParse(settings).success).toBe(true);
	});

	// N2:各种坏法。
	it.each([
		["值是 null", null],
		["值是数字", 7],
		["值是数组", [1]],
		["provider 不认识", { provider: "没这家" }],
	])("ai.providers 里一家%s:只那一家记一条、不在表里,别家还在", (_name, bad) => {
		const disk = goodDisk();
		disk.ai.providers = { good: { provider: "openrouter" }, bad, tail: { provider: "deepseek" } };
		const { settings, invalid } = parseCoreSettings(disk);
		expect(Object.keys(settings.ai.providers)).toEqual(["good", "tail"]);
		expect(invalid.map((e) => e.path)).toEqual([["ai", "providers", "bad"]]);
		expect(invalid[0]?.raw).toEqual(bad);
	});

	it("ai.providers 里两家都坏:两条,按盘上的键序,插在 ai 子格按 schema 键序的位置上", () => {
		const disk = goodDisk();
		disk.ai.providers = {
			z: { provider: "没这家" },
			ok: { provider: "openrouter" },
			a: { provider: "deepseek", model: 1 },
		};
		disk.ai.enabled = "开";
		disk.history = "三十天";
		const { settings, invalid } = parseCoreSettings(disk);
		expect(Object.keys(settings.ai.providers)).toEqual(["ok"]);
		expect(invalid.map((e) => e.path)).toEqual([
			["history"],
			["ai", "enabled"],
			["ai", "providers", "z"],
			["ai", "providers", "a"],
		]);
	});

	it("ai.providers 表本身是数组:整格一条 [ai, providers],表退成空", () => {
		const disk = goodDisk();
		disk.ai.providers = [{ provider: "openrouter" }];
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai.providers).toEqual({});
		expect(settings.ai.activePreset).toBe("analyst");
		expect(invalid.map((e) => e.path)).toEqual([["ai", "providers"]]);
		expect(invalid[0]?.raw).toEqual([{ provider: "openrouter" }]);
	});

	it("ai.providers 表是字符串或 null:同样整格一条 [ai, providers]", () => {
		for (const bad of ["坏的", null]) {
			const disk = goodDisk();
			disk.ai.providers = bad;
			const { settings, invalid } = parseCoreSettings(disk);
			expect(settings.ai.providers).toEqual({});
			expect(invalid.map((e) => e.path)).toEqual([["ai", "providers"]]);
		}
	});

	it("ai.providers 键不在:不记,表是空的", () => {
		const disk = goodDisk();
		delete disk.ai.providers;
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai.providers).toEqual({});
		expect(invalid).toEqual([]);
	});

	it("ai 整格是对象但 ai.providers 全好:没有条目", () => {
		const { invalid } = parseCoreSettings(goodDisk());
		expect(invalid).toEqual([]);
	});

	// 题 2:原型名当实例 id 是坏的那一家。键的规则取自 GlobalSettingsSchema(.unwrap 得到 record,.keyType / .valueType)。
	it("实例 id 是原型名(constructor):记成单家的坏格、原文留着,别家还在", () => {
		const disk = goodDisk();
		disk.ai.providers = {
			good: { provider: "openrouter" },
			constructor: { provider: "deepseek", model: "m" },
		};
		const { settings, invalid } = parseCoreSettings(disk);
		expect(Object.keys(settings.ai.providers)).toEqual(["good"]);
		expect(invalid.map((e) => e.path)).toEqual([["ai", "providers", "constructor"]]);
		expect(invalid[0]?.raw).toEqual({ provider: "deepseek", model: "m" });
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	// N12(解析这一半):盘上有一家自己的键叫 __proto__。zod 的 record 在把键交给键的规则之前就跳过它,
	// 光靠 schema 拦不住,解析层自己记坏格;拼出来的表原型不能被换。
	it("实例 id 是 __proto__:记一条单家的坏格,原文留着,拼出来的表原型没被换", () => {
		const disk = goodDisk();
		const text =
			'{"good":{"provider":"openrouter"},"__proto__":{"provider":"deepseek","model":"evil"}}';
		disk.ai.providers = JSON.parse(text);
		expect(Object.hasOwn(disk.ai.providers, "__proto__")).toBe(true);
		const { settings, invalid } = parseCoreSettings(disk);
		expect(Object.keys(settings.ai.providers)).toEqual(["good"]);
		expect(Object.getPrototypeOf(settings.ai.providers)).toBe(Object.prototype);
		expect(invalid.map((e) => e.path)).toEqual([["ai", "providers", "__proto__"]]);
		expect(invalid[0]?.raw).toEqual({ provider: "deepseek", model: "evil" });
	});

	it("单家条目的判别:恰好三段 [ai, providers, id] 才算,回那个 id", () => {
		expect(instanceIdOfEntry(["ai", "providers", "p1"])).toBe("p1");
		expect(instanceIdOfEntry(["ai", "providers"])).toBeUndefined();
		expect(instanceIdOfEntry(["ai"])).toBeUndefined();
		expect(instanceIdOfEntry(["ai", "search", "x"])).toBeUndefined();
		expect(instanceIdOfEntry(["defaults", "providers", "x"])).toBeUndefined();
		expect(instanceIdOfEntry(["ai", "providers", "p1", "model"])).toBeUndefined();
	});

	it("ai 整格是字符串:整格退默认,只记一条 [ai]", () => {
		const disk = goodDisk();
		disk.ai = "关掉";
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai).toEqual(makeDefaultGlobalSettings().ai);
		expect(settings.history.retentionDays).toBe(30);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["ai"]);
		expect(invalid[0]?.raw).toBe("关掉");
	});

	it("defaults 整格是数组:整格退默认,只记一条 [defaults]", () => {
		const disk = goodDisk();
		disk.defaults = [1, 2];
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.defaults).toEqual(makeDefaultGlobalSettings().defaults);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["defaults"]);
		expect(invalid[0]?.raw).toEqual([1, 2]);
	});

	it("子格必填缺了(ai.enabled):记 [ai, enabled] 且 missing,ai 下别的子格不动", () => {
		const disk = goodDisk();
		delete disk.ai.enabled;
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.ai.enabled).toBe(makeDefaultGlobalSettings().ai.enabled);
		expect(settings.ai.activePreset).toBe("analyst");
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
			["ai", "providers", "p1"],
			["mutedUntil"],
		]);
	});

	it("templatesSeen 坏:取出厂值(新装的账本是空的),并报这一格", () => {
		const disk = goodDisk();
		disk.templatesSeen = "账本";
		const { settings, invalid } = parseCoreSettings(disk);
		expect(settings.templatesSeen).toEqual(makeDefaultGlobalSettings().templatesSeen);
		expect(settings.templatesSeen).toEqual({});
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
		providersRaw.provider = "改";
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
			["ai", "providers", "p1"],
		]);
		const second = parseCoreSettings(withRawSettings(first.settings, first.invalid));
		expect(second.settings).toEqual(first.settings);
		expect(second.invalid).toEqual(first.invalid);
	});

	// N13:坏的一家在表的中间,放回后再解析与第一次一样;再写一遍,字节一样(放回的位置是确定的)。
	it("单家坏在表中间:放回后再解析,settings 与 invalid 同第一次;第二次放回的字节同第一次", () => {
		const bad = goodDisk();
		bad.ai.providers = {
			a: { provider: "openrouter", model: "ma" },
			mid: { provider: "deepseek", model: 7 },
			z: { provider: "deepseek", model: "mz" },
		};
		const first = parseCoreSettings(bad);
		expect(first.invalid.map((e) => e.path)).toEqual([["ai", "providers", "mid"]]);
		const written1 = withRawSettings(first.settings, first.invalid) as Json;
		// 原文放回了,内容一个字没动;别家是内存里的值。
		expect(written1.ai.providers.mid).toEqual({ provider: "deepseek", model: 7 });
		expect(written1.ai.providers.a.model).toBe("ma");
		const second = parseCoreSettings(written1);
		expect(second.settings).toEqual(first.settings);
		expect(second.invalid).toEqual(first.invalid);
		const written2 = withRawSettings(second.settings, second.invalid);
		expect(JSON.stringify(written2)).toBe(JSON.stringify(written1));
	});

	// N12(放回这一半):自己的键叫 __proto__ 的一家,放回后仍是盘上自己的一个键、内容不变,原型没被换。
	it("单家的键是 __proto__:放回后盘上那一家还在、内容不变,表的原型没被换", () => {
		const bad = goodDisk();
		bad.ai.providers = JSON.parse(
			'{"good":{"provider":"openrouter"},"__proto__":{"provider":"deepseek","model":"evil"}}',
		);
		const first = parseCoreSettings(bad);
		const out = withRawSettings(first.settings, first.invalid) as Json;
		const providers = out.ai.providers as object;
		expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
		expect(Object.keys(providers)).toEqual(["good", "__proto__"]);
		expect(Object.getOwnPropertyDescriptor(providers, "__proto__")?.value).toEqual({
			provider: "deepseek",
			model: "evil",
		});
		// 序列化一遍再读回,那一家也在(JSON.stringify 对自己的 __proto__ 键照常输出)。
		const roundTrip = JSON.parse(JSON.stringify(out));
		expect(Object.hasOwn(roundTrip.ai.providers, "__proto__")).toBe(true);
	});
});

describe("search scenes isolated as one secret-bearing cell", () => {
	it("retains raw invalid switches at ai.search while running with safe default switches", () => {
		const disk = goodDisk();
		disk.ai.search = {
			backend: "tavily",
			keys: { bocha: "secret-b", tavily: "secret-t" },
			scenes: { post: null, live: true, roast: false },
			unknown: "keep",
		};
		const original = structuredClone(disk.ai.search);
		const parsed = parseCoreSettings(disk);
		expect(parsed.settings.ai.search.scenes).toEqual({ post: false, live: false, roast: false });
		expect(parsed.invalid).toHaveLength(1);
		expect(parsed.invalid[0]).toMatchObject({
			path: ["ai", "search"],
			raw: original,
			missing: false,
		});
		expect((withRawSettings(parsed.settings, parsed.invalid) as Json).ai.search).toEqual(original);
		expect(disk.ai.search).toEqual(original);
	});
	it("does not compatibility-read old switches in a modern config", () => {
		const disk = goodDisk();
		disk.ai.search = { engines: { dynamic: true, live: true, roast: true } };
		const parsed = parseCoreSettings(disk);
		expect(parsed.invalid).toEqual([]);
		expect(parsed.settings.ai.search.scenes).toEqual({ post: false, live: false, roast: false });
		expect(parsed.settings.ai.search).not.toHaveProperty("engines");
	});
});
